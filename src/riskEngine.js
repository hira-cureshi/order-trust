// riskEngine.js — this IS the product. Not a dashboard, not a report —
// two specific alerts, matching exactly what was pitched and validated:
//
// 1. AGING ORDERS: a line item that's sat unfulfilled too long. This is
//    100% honest data — Shopify can't fake "no fulfillment click happened
//    yet." This catches the "scrambling at the last minute" problem
//    directly (per Hira's own answer to vedasuite).
//
// 2. PATTERN SHIFT: a supplier whose current fulfillment speed has clearly
//    drifted from THEIR OWN historical average. This sidesteps the
//    fulfilled-timestamp-isn't-real-shipping problem (MayraApps, the CSV
//    test) by not claiming to know ground truth — it only claims "this
//    supplier is behaving differently than their own normal," which is a
//    fair, defensible claim even with imperfect underlying data.

const db = require("./db");
const { sendAlertEmail } = require("./email");

const AGING_DAYS_THRESHOLD = Number(process.env.AGING_DAYS_THRESHOLD || 5);
// A supplier needs at least this many completed (fulfilled) line items
// before we trust their baseline enough to alert on deviation — protects
// against the "SKU has 1-2 orders, it's just noise" trap MayraApps and
// lumine both flagged.
const MIN_SAMPLE_FOR_BASELINE = Number(process.env.MIN_SAMPLE_FOR_BASELINE || 5);
// How many hours slower than their own baseline counts as a real shift,
// not just normal variance.
const PATTERN_SHIFT_MULTIPLIER = Number(process.env.PATTERN_SHIFT_MULTIPLIER || 2);

function hoursBetween(a, b) {
  return (new Date(b).getTime() - new Date(a).getTime()) / (1000 * 60 * 60);
}

function daysSince(dateStr) {
  return hoursBetween(dateStr, new Date().toISOString()) / 24;
}

// --- Alert 1: aging, unfulfilled line items -------------------------------

function checkAgingOrders(shopDomain) {
  const openLines = db
    .prepare(
      `SELECT * FROM order_line_items
       WHERE shop_domain = ? AND fulfillment_status = 'unfulfilled'`
    )
    .all(shopDomain);

  const newAlerts = [];

  for (const line of openLines) {
    const ageDays = daysSince(line.order_created_at);
    if (ageDays < AGING_DAYS_THRESHOLD) continue;

    // Don't re-alert on the same line item every single run — check if an
    // unresolved aging alert already exists for it.
    const existing = db
      .prepare(
        `SELECT id FROM alerts
         WHERE shop_domain = ? AND alert_type = 'aging_order' AND shopify_order_id = ? AND resolved = 0`
      )
      .get(shopDomain, line.shopify_order_id);
    if (existing) continue;

    const message = `"${line.product_title || "Item"}" from ${line.normalized_vendor} has been unfulfilled for ${Math.floor(ageDays)} days (order ${line.shopify_order_id}).`;

    const result = db
      .prepare(
        `INSERT INTO alerts (shop_domain, alert_type, shopify_order_id, normalized_vendor, message)
         VALUES (?, 'aging_order', ?, ?, ?)`
      )
      .run(shopDomain, line.shopify_order_id, line.normalized_vendor, message);

    newAlerts.push({ id: result.lastInsertRowid, message });
  }

  return newAlerts;
}

// --- Alert 2: vendor pattern shift -----------------------------------------

// How many of the MOST RECENT fulfilled line items are treated as "current
// behavior" rather than folded into the historical baseline. Keeping this
// separate from the baseline is what makes shift-detection actually work —
// earlier testing caught a real bug where recent orders were diluting
// their own comparison baseline, silently masking real shifts.
const RECENT_WINDOW_SIZE = Number(process.env.RECENT_WINDOW_SIZE || 3);

// Recomputes each vendor's rolling baseline from their fulfilled history,
// EXCLUDING the most recent RECENT_WINDOW_SIZE orders — those are reserved
// for the "current behavior" comparison in checkPatternShifts, so a
// vendor's own recent slowdown can never quietly drag down (and hide
// itself inside) its own baseline.
function refreshVendorBaselines(shopDomain) {
  const vendors = db
    .prepare(
      `SELECT DISTINCT normalized_vendor FROM order_line_items WHERE shop_domain = ?`
    )
    .all(shopDomain);

  for (const { normalized_vendor } of vendors) {
    const allFulfilled = db
      .prepare(
        `SELECT order_created_at, fulfilled_at, refunded FROM order_line_items
         WHERE shop_domain = ? AND normalized_vendor = ? AND fulfilled_at IS NOT NULL
         ORDER BY fulfilled_at DESC`
      )
      .all(shopDomain, normalized_vendor);

    if (allFulfilled.length === 0) continue;

    // Baseline = everything EXCEPT the most recent window. If there isn't
    // enough history beyond the recent window yet, fall back to using
    // everything (better than an empty baseline) — sample_count will stay
    // low either way, which keeps the noise-filter in checkPatternShifts
    // from trusting it prematurely.
    const historical =
      allFulfilled.length > RECENT_WINDOW_SIZE
        ? allFulfilled.slice(RECENT_WINDOW_SIZE)
        : allFulfilled;

    const leadTimes = historical.map((l) => hoursBetween(l.order_created_at, l.fulfilled_at));
    const avgHours = leadTimes.reduce((a, b) => a + b, 0) / leadTimes.length;
    const refundCount = allFulfilled.filter((l) => l.refunded).length;

    db.prepare(
      `INSERT INTO vendor_baseline (shop_domain, normalized_vendor, avg_lead_time_hours, sample_count, refund_count, last_updated)
       VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(shop_domain, normalized_vendor) DO UPDATE SET
         avg_lead_time_hours = excluded.avg_lead_time_hours,
         sample_count = excluded.sample_count,
         refund_count = excluded.refund_count,
         last_updated = CURRENT_TIMESTAMP`
    ).run(shopDomain, normalized_vendor, avgHours, historical.length, refundCount);
  }
}

// Compares each vendor's most recent orders against their own established
// baseline. Only fires once a vendor has enough history to trust the
// baseline — a vendor with 2 orders doesn't get scored, per MayraApps'
// noise-filter point.
function checkPatternShifts(shopDomain) {
  const baselines = db
    .prepare(
      `SELECT * FROM vendor_baseline WHERE shop_domain = ? AND sample_count >= ?`
    )
    .all(shopDomain, MIN_SAMPLE_FOR_BASELINE);

  const newAlerts = [];

  for (const baseline of baselines) {
    // Same fixed-size recent window used to build the baseline (see
    // refreshVendorBaselines) — this is what keeps "recent" and "normal"
    // cleanly separated instead of overlapping and diluting each other.
    const recentLines = db
      .prepare(
        `SELECT order_created_at, fulfilled_at FROM order_line_items
         WHERE shop_domain = ? AND normalized_vendor = ? AND fulfilled_at IS NOT NULL
         ORDER BY fulfilled_at DESC LIMIT ?`
      )
      .all(shopDomain, baseline.normalized_vendor, RECENT_WINDOW_SIZE);

    if (recentLines.length < RECENT_WINDOW_SIZE) continue; // not enough recent data to judge a shift

    const recentAvg =
      recentLines.reduce((sum, l) => sum + hoursBetween(l.order_created_at, l.fulfilled_at), 0) /
      recentLines.length;

    const isShifted = recentAvg > baseline.avg_lead_time_hours * PATTERN_SHIFT_MULTIPLIER;
    if (!isShifted) continue;

    // Avoid re-alerting daily for the same ongoing shift.
    const existing = db
      .prepare(
        `SELECT id FROM alerts
         WHERE shop_domain = ? AND alert_type = 'pattern_shift' AND normalized_vendor = ? AND resolved = 0`
      )
      .get(shopDomain, baseline.normalized_vendor);
    if (existing) continue;

    const message = `${baseline.normalized_vendor}'s recent fulfillment time (~${Math.round(recentAvg)}h) is running well above their normal average (~${Math.round(baseline.avg_lead_time_hours)}h) — worth checking in with them.`;

    const result = db
      .prepare(
        `INSERT INTO alerts (shop_domain, alert_type, normalized_vendor, message)
         VALUES (?, 'pattern_shift', ?, ?)`
      )
      .run(shopDomain, baseline.normalized_vendor, message);

    newAlerts.push({ id: result.lastInsertRowid, message });
  }

  return newAlerts;
}

// Runs both checks for a shop and emails the merchant a single digest if
// anything new was found. This is the function the cron job calls.
async function runAlertCheck(shopDomain, notifyEmail) {
  refreshVendorBaselines(shopDomain);

  const agingAlerts = checkAgingOrders(shopDomain);
  const patternAlerts = checkPatternShifts(shopDomain);
  const allAlerts = [...agingAlerts, ...patternAlerts];

  if (allAlerts.length > 0 && notifyEmail) {
    await sendAlertEmail(notifyEmail, allAlerts);
    for (const alert of allAlerts) {
      db.prepare(`UPDATE alerts SET email_sent = 1 WHERE id = ?`).run(alert.id);
    }
  }

  return { agingCount: agingAlerts.length, patternCount: patternAlerts.length };
}

function logEvent(shopDomain, orderId, eventType, detail) {
  db.prepare(
    `INSERT INTO event_log (shop_domain, order_id, event_type, detail) VALUES (?, ?, ?, ?)`
  ).run(shopDomain, orderId, eventType, detail);
}

module.exports = { runAlertCheck, checkAgingOrders, checkPatternShifts, refreshVendorBaselines, logEvent };
