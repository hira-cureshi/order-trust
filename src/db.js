// db.js — all local data storage. Uses Node's built-in SQLite module (no
// external database, no native module to compile — this avoided a real
// deployment headache: better-sqlite3 needs to build from source on
// install, which fails on some hosts with restricted network access).
// Swap for Postgres later if you outgrow it (see README "Growing past
// SQLite").

const { DatabaseSync } = require("node:sqlite");
const path = require("path");

const db = new DatabaseSync(path.join(__dirname, "..", "order-trust.db"));
db.exec("PRAGMA journal_mode = WAL;");

db.exec(`
  CREATE TABLE IF NOT EXISTS shops (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    shop_domain TEXT UNIQUE NOT NULL,
    access_token TEXT NOT NULL,
    notify_email TEXT,
    dashboard_token TEXT,
    installed_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  -- Order-level record. Kept lean on purpose — line items carry the vendor
  -- and fulfillment detail, since that's what lumine's feedback made clear
  -- must be tracked per line, not per order (mixed-supplier orders break
  -- any "whole order" attribution).
  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    shop_domain TEXT NOT NULL,
    shopify_order_id TEXT NOT NULL,
    order_number TEXT,
    customer_email TEXT,
    customer_name TEXT,
    created_at TEXT,
    financial_status TEXT,
    UNIQUE(shop_domain, shopify_order_id)
  );

  -- One row per line item per order. This is where the real tracking
  -- happens: each product has its own vendor, its own fulfillment status,
  -- its own timestamps. A single order with 3 suppliers produces 3 rows
  -- here, each independently trackable.
  CREATE TABLE IF NOT EXISTS order_line_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    shop_domain TEXT NOT NULL,
    shopify_order_id TEXT NOT NULL,
    shopify_line_item_id TEXT NOT NULL,
    product_title TEXT,
    sku TEXT,
    quantity INTEGER DEFAULT 1,
    raw_vendor TEXT,           -- exactly what Shopify/the merchant typed
    normalized_vendor TEXT,    -- cleaned, de-duplicated name (see vendor_aliases)
    order_created_at TEXT,     -- copied from the order, snapshotted here
    fulfilled_at TEXT,         -- NULL until Shopify reports this line fulfilled
    fulfillment_status TEXT DEFAULT 'unfulfilled',
    tracking_number TEXT,
    refunded INTEGER DEFAULT 0,
    last_checked_at TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(shop_domain, shopify_line_item_id)
  );

  -- Vendor name normalization. Free-text vendor fields produce duplicates
  -- like "Soeji" / "soeji" / "Soeji37" — this table is the merge map so
  -- every report reads them as one supplier. Starts empty; entries are
  -- added automatically (case/whitespace folding) and can be corrected
  -- manually later.
  CREATE TABLE IF NOT EXISTS vendor_aliases (
    shop_domain TEXT NOT NULL,
    raw_vendor TEXT NOT NULL,
    normalized_vendor TEXT NOT NULL,
    PRIMARY KEY (shop_domain, raw_vendor)
  );

  -- Rolling baseline per supplier — the "normal" this supplier is compared
  -- against. This is what makes pattern-shift detection possible: an alert
  -- fires when a supplier deviates from THEIR OWN history, not an arbitrary
  -- fixed threshold that's unfair to naturally-slower suppliers.
  CREATE TABLE IF NOT EXISTS vendor_baseline (
    shop_domain TEXT NOT NULL,
    normalized_vendor TEXT NOT NULL,
    avg_lead_time_hours REAL,
    sample_count INTEGER DEFAULT 0,
    refund_count INTEGER DEFAULT 0,
    last_updated TEXT DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (shop_domain, normalized_vendor)
  );

  -- Every alert Order Trust has ever raised. This is the actual product —
  -- not a dashboard, a log of "here's what needed your attention and when."
  CREATE TABLE IF NOT EXISTS alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    shop_domain TEXT NOT NULL,
    alert_type TEXT NOT NULL,     -- 'aging_order' | 'pattern_shift'
    shopify_order_id TEXT,
    normalized_vendor TEXT,
    message TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    resolved INTEGER DEFAULT 0,
    email_sent INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS event_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    shop_domain TEXT,
    order_id TEXT,
    event_type TEXT,
    detail TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
`);

module.exports = db;
