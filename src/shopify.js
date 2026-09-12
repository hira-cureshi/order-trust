// shopify.js — handles the OAuth "install" flow and wraps calls to the
// Shopify Admin API. This is deliberately written without the official SDK
// so every step is visible and easy to debug when you're learning the flow.

const axios = require("axios");
const crypto = require("crypto");
const db = require("./db");
const { encrypt, decrypt } = require("./encryption");

const {
  SHOPIFY_API_KEY,
  SHOPIFY_API_SECRET,
  SHOPIFY_SCOPES,
  APP_URL,
} = process.env;

const API_VERSION = "2025-01";

// Step 1: merchant visits /auth?shop=example.myshopify.com
// We redirect them to Shopify's permission screen.
function buildInstallUrl(shop, state) {
  const redirectUri = `${APP_URL}/auth/callback`;
  const url =
    `https://${shop}/admin/oauth/authorize` +
    `?client_id=${SHOPIFY_API_KEY}` +
    `&scope=${SHOPIFY_SCOPES}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&state=${state}`;
  return url;
}

// Step 2: Shopify redirects back to /auth/callback with a code + hmac.
// We verify the hmac (proves the request really came from Shopify), then
// exchange the code for a permanent access token.
function verifyHmac(query) {
  const { hmac, ...rest } = query;
  const message = Object.keys(rest)
    .sort()
    .map((key) => `${key}=${rest[key]}`)
    .join("&");
  const digest = crypto
    .createHmac("sha256", SHOPIFY_API_SECRET)
    .update(message)
    .digest("hex");
  return digest === hmac;
}

async function exchangeCodeForToken(shop, code) {
  const res = await axios.post(`https://${shop}/admin/oauth/access_token`, {
    client_id: SHOPIFY_API_KEY,
    client_secret: SHOPIFY_API_SECRET,
    code,
  });
  return res.data.access_token;
}

function saveShop(shop, accessToken, notifyEmail) {
  // Every install gets its own random dashboard token — this is what
  // fixes a real gap found before any real merchant used this: without
  // it, anyone who knew or guessed a shop's domain could view that
  // shop's alerts by just typing the URL. Now the dashboard link only
  // works with the matching secret token attached.
  const dashboardToken = crypto.randomBytes(24).toString("hex");
  // The access token is encrypted before it's ever written to disk —
  // fixes a second real gap: this token grants real access to a
  // merchant's store, and was previously stored in plain text.
  const encryptedToken = encrypt(accessToken);
  db.prepare(
    `INSERT INTO shops (shop_domain, access_token, notify_email, dashboard_token) VALUES (?, ?, ?, ?)
     ON CONFLICT(shop_domain) DO UPDATE SET access_token = excluded.access_token, notify_email = excluded.notify_email`
  ).run(shop, encryptedToken, notifyEmail || null, dashboardToken);
  // Keep the existing token on reinstall rather than issuing a new one,
  // so an old dashboard link doesn't silently break.
  const row = db.prepare(`SELECT dashboard_token FROM shops WHERE shop_domain = ?`).get(shop);
  return row.dashboard_token;
}

// Verifies a dashboard request actually has the right secret token for
// that shop — the fix for the "anyone can view any shop's data" gap.
function verifyDashboardToken(shop, token) {
  if (!shop || !token) return false;
  const row = db.prepare(`SELECT dashboard_token FROM shops WHERE shop_domain = ?`).get(shop);
  return !!row && row.dashboard_token === token;
}

// Fetches the store's own admin email, so alerts have somewhere to go
// automatically without asking the merchant to type it in separately.
async function fetchShopEmail(shop, accessToken) {
  try {
    const res = await axios.get(`https://${shop}/admin/api/${API_VERSION}/shop.json`, {
      headers: { "X-Shopify-Access-Token": accessToken },
    });
    return res.data?.shop?.email || null;
  } catch (err) {
    console.warn("Could not fetch shop email:", err.response?.data || err.message);
    return null;
  }
}

function getShopToken(shop) {
  const row = db.prepare(`SELECT access_token FROM shops WHERE shop_domain = ?`).get(shop);
  return row ? decrypt(row.access_token) : null;
}

// Registers the webhooks we need. Call this once, right after install.
// Made idempotent (safe to call on every install/reinstall) after a real
// error surfaced during testing: Shopify rejects a create-webhook request
// if one already exists for that exact topic+address, which happens
// naturally every time a merchant (or you, during testing) uninstalls and
// reinstalls the app. Instead of always trying to create, this now checks
// what's already registered first.
async function registerWebhooks(shop, accessToken) {
  const topics = ["orders/create", "fulfillments/update", "refunds/create"];
  const headers = { "X-Shopify-Access-Token": accessToken };

  let existing = [];
  try {
    const res = await axios.get(`https://${shop}/admin/api/${API_VERSION}/webhooks.json`, { headers });
    existing = res.data.webhooks || [];
  } catch (err) {
    console.warn("Could not fetch existing webhooks:", err.response?.data || err.message);
  }

  for (const topic of topics) {
    const address = `${APP_URL}/webhooks/${topic.replace("/", "-")}`;
    const match = existing.find((w) => w.topic === topic);

    if (match && match.address === address) {
      // Already registered, pointing at the right URL — nothing to do.
      continue;
    }

    try {
      if (match) {
        // Registered but pointing at an old URL (e.g. after switching
        // hosting providers) — update it in place rather than trying to
        // create a duplicate, which Shopify would reject.
        await axios.put(
          `https://${shop}/admin/api/${API_VERSION}/webhooks/${match.id}.json`,
          { webhook: { id: match.id, address } },
          { headers }
        );
      } else {
        await axios.post(
          `https://${shop}/admin/api/${API_VERSION}/webhooks.json`,
          { webhook: { topic, address, format: "json" } },
          { headers }
        );
      }
    } catch (err) {
      console.warn(`Webhook ${topic} registration issue:`, err.response?.data || err.message);
    }
  }
}

// Verifies that an incoming webhook actually came from Shopify.
function verifyWebhookHmac(rawBody, hmacHeader) {
  const digest = crypto
    .createHmac("sha256", SHOPIFY_API_SECRET)
    .update(rawBody, "utf8")
    .digest("base64");
  return digest === hmacHeader;
}

module.exports = {
  buildInstallUrl,
  verifyHmac,
  exchangeCodeForToken,
  saveShop,
  getShopToken,
  registerWebhooks,
  verifyWebhookHmac,
  fetchShopEmail,
  verifyDashboardToken,
};
