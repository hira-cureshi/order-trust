const express = require("express");
const db = require("../db");
const { runAlertCheck } = require("../riskEngine");
const { verifyDashboardToken } = require("../shopify");

const router = express.Router();

function getShop(req) {
  return req.query.shop || req.session?.shop;
}

// Every dashboard route now requires the per-shop secret token issued at
// install time. Before this fix, any of these endpoints would return a
// shop's real order/alert data to anyone who just typed in that shop's
// domain — a real gap, fixed here before any real merchant used this.
function requireAuth(req, res, next) {
  const shop = getShop(req);
  const token = req.query.token;
  if (!shop || !verifyDashboardToken(shop, token)) {
    return res.status(401).json({ error: "unauthorized" });
  }
  req.shop = shop;
  next();
}

router.get("/api/summary", requireAuth, (req, res) => {
  const shop = req.shop;

  const totals = db
    .prepare(
      `SELECT
         COUNT(*) as total_line_items,
         SUM(CASE WHEN fulfillment_status = 'unfulfilled' THEN 1 ELSE 0 END) as open_line_items
       FROM order_line_items WHERE shop_domain = ?`
    )
    .get(shop);

  const activeAlerts = db
    .prepare(
      `SELECT * FROM alerts WHERE shop_domain = ? AND resolved = 0 ORDER BY created_at DESC`
    )
    .all(shop);

  const vendorBaselines = db
    .prepare(
      `SELECT * FROM vendor_baseline WHERE shop_domain = ? ORDER BY avg_lead_time_hours DESC`
    )
    .all(shop);

  res.json({ totals, activeAlerts, vendorBaselines });
});

// Manually trigger an alert check (useful for testing before the cron runs)
router.post("/api/run-check", requireAuth, async (req, res) => {
  const shop = req.shop;
  const shopRow = db.prepare(`SELECT notify_email FROM shops WHERE shop_domain = ?`).get(shop);
  const result = await runAlertCheck(shop, shopRow?.notify_email);
  res.json(result);
});

// Lets a merchant dismiss/resolve an alert once they've acted on it.
router.post("/api/alerts/:id/resolve", requireAuth, (req, res) => {
  const shop = req.shop;
  db.prepare(`UPDATE alerts SET resolved = 1 WHERE id = ? AND shop_domain = ?`).run(
    req.params.id,
    shop
  );
  res.json({ resolved: true });
});

module.exports = router;
