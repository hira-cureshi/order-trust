// cron.js — runs the alert check on a schedule so aging orders and vendor
// pattern shifts get caught even if nobody opens the dashboard that day.

const cron = require("node-cron");
const db = require("./db");
const { runAlertCheck } = require("./riskEngine");

function startScheduler() {
  // Every 6 hours. Tune this once real usage data suggests otherwise.
  cron.schedule("0 */6 * * *", async () => {
    const shops = db.prepare(`SELECT shop_domain, notify_email FROM shops`).all();
    for (const shop of shops) {
      try {
        const result = await runAlertCheck(shop.shop_domain, shop.notify_email);
        console.log(`[alert-check] ${shop.shop_domain}:`, result);
      } catch (err) {
        console.error(`[alert-check] failed for ${shop.shop_domain}:`, err.message);
      }
    }
  });

  console.log("Alert-check scheduler started (every 6 hours).");
}

module.exports = { startScheduler };
