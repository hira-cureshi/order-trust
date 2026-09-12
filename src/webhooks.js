// webhooks.js — Shopify calls these URLs automatically whenever something
// happens in the store (new order, shipment update, refund). This is how
// the app stays in sync without you doing anything manually.
//
// UPDATED: now saves data per LINE ITEM, not per whole order — this is the
// fix for lumine's attribution problem (a 3-supplier order needs 3
// independently-trackable rows, not one blended order record). Vendor
// names are normalized on the way in, so nothing downstream ever sees
// "Soeji" and "soeji" as different suppliers.

const express = require("express");
const db = require("./db");
const { verifyWebhookHmac } = require("./shopify");
const { normalizeVendor } = require("./vendorNormalize");
const { logEvent } = require("./riskEngine");

const router = express.Router();

// Shopify signs webhook bodies — we need the RAW body (not parsed JSON) to
// verify that signature, so this raw parser is applied only to these routes
// (see server.js for how it's wired in before the global JSON parser).
const rawBodySaver = (req, res, buf) => {
  req.rawBody = buf;
};

router.post("/orders-create", express.json({ verify: rawBodySaver }), async (req, res) => {
  if (!verifyWebhookHmac(req.rawBody, req.get("X-Shopify-Hmac-Sha256"))) {
    return res.status(401).send("Invalid HMAC");
  }
  const shop = req.get("X-Shopify-Shop-Domain");
  const order = req.body;

  db.prepare(
    `INSERT INTO orders (shop_domain, shopify_order_id, order_number, customer_email, customer_name, created_at, financial_status)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(shop_domain, shopify_order_id) DO NOTHING`
  ).run(
    shop,
    String(order.id),
    order.name || String(order.order_number),
    order.email || null,
    order.customer ? `${order.customer.first_name || ""} ${order.customer.last_name || ""}`.trim() : null,
    order.created_at,
    order.financial_status || null
  );

  // The core fix: one row per line item, each with its OWN normalized
  // vendor, so a mixed-supplier order never gets blamed on the wrong one.
  const lineItems = Array.isArray(order.line_items) ? order.line_items : [];
  for (const item of lineItems) {
    const normalizedVendor = normalizeVendor(shop, item.vendor);
    db.prepare(
      `INSERT INTO order_line_items
         (shop_domain, shopify_order_id, shopify_line_item_id, product_title, sku, quantity,
          raw_vendor, normalized_vendor, order_created_at, fulfillment_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'unfulfilled')
       ON CONFLICT(shop_domain, shopify_line_item_id) DO NOTHING`
    ).run(
      shop,
      String(order.id),
      String(item.id),
      item.title || null,
      item.sku || null,
      item.quantity || 1,
      item.vendor || null,
      normalizedVendor,
      order.created_at
    );
  }

  logEvent(shop, String(order.id), "order_created", `Synced with ${lineItems.length} line item(s)`);
  res.status(200).send("ok");
});

router.post("/fulfillments-update", express.json({ verify: rawBodySaver }), async (req, res) => {
  if (!verifyWebhookHmac(req.rawBody, req.get("X-Shopify-Hmac-Sha256"))) {
    return res.status(401).send("Invalid HMAC");
  }
  const shop = req.get("X-Shopify-Shop-Domain");
  const fulfillment = req.body;

  const statusMap = {
    in_transit: "in_transit",
    delivered: "delivered",
    failure: "stalled",
  };
  const newStatus = statusMap[fulfillment.shipment_status] || "fulfilled";

  // A fulfillment event lists which specific line items it covers — only
  // those lines get updated, not the whole order. This is what makes
  // "order shipped in 3 separate batches on different days" trackable
  // correctly instead of averaging it all into one misleading number.
  const fulfilledLineItemIds = Array.isArray(fulfillment.line_items)
    ? fulfillment.line_items.map((li) => String(li.id))
    : [];

  for (const lineItemId of fulfilledLineItemIds) {
    db.prepare(
      `UPDATE order_line_items
       SET fulfillment_status = ?, fulfilled_at = CURRENT_TIMESTAMP, tracking_number = ?,
           last_checked_at = CURRENT_TIMESTAMP
       WHERE shop_domain = ? AND shopify_line_item_id = ?`
    ).run(newStatus, fulfillment.tracking_number || null, shop, lineItemId);
  }

  logEvent(
    shop,
    String(fulfillment.order_id),
    "fulfillment_update",
    `${newStatus} — ${fulfilledLineItemIds.length} line item(s)`
  );
  res.status(200).send("ok");
});

router.post("/refunds-create", express.json({ verify: rawBodySaver }), async (req, res) => {
  if (!verifyWebhookHmac(req.rawBody, req.get("X-Shopify-Hmac-Sha256"))) {
    return res.status(401).send("Invalid HMAC");
  }
  const shop = req.get("X-Shopify-Shop-Domain");
  const refund = req.body;

  // Refunds also reference specific line items — mark only those as
  // refunded, so a partial refund on one item doesn't unfairly tag every
  // supplier on that order.
  const refundLineItemIds = Array.isArray(refund.refund_line_items)
    ? refund.refund_line_items.map((rli) => String(rli.line_item_id))
    : [];

  for (const lineItemId of refundLineItemIds) {
    db.prepare(
      `UPDATE order_line_items SET refunded = 1 WHERE shop_domain = ? AND shopify_line_item_id = ?`
    ).run(shop, lineItemId);
  }

  logEvent(shop, String(refund.order_id), "refund_issued", `${refundLineItemIds.length} line item(s) refunded`);
  res.status(200).send("ok");
});

module.exports = router;
