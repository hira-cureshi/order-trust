const express = require("express");
const crypto = require("crypto");
const {
  buildInstallUrl,
  verifyHmac,
  exchangeCodeForToken,
  saveShop,
  registerWebhooks,
  fetchShopEmail,
} = require("../shopify");

const router = express.Router();

// Step 1: /auth?shop=your-store.myshopify.com  -> redirects to Shopify
router.get("/auth", (req, res) => {
  const { shop } = req.query;
  if (!shop) return res.status(400).send("Missing ?shop parameter");

  const state = crypto.randomBytes(16).toString("hex");
  res.cookie("state", state, { httpOnly: true });
  res.redirect(buildInstallUrl(shop, state));
});

// Step 2: Shopify redirects back here after the merchant approves
router.get("/auth/callback", async (req, res) => {
  const { shop, hmac, code, state } = req.query;

  if (!verifyHmac(req.query)) {
    return res.status(401).send("HMAC validation failed");
  }

  // This check was previously missing (flagged before any real store used
  // this app) — without it, someone could forge a callback request that
  // skips the "did this install really start on step 1" check. Comparing
  // the state value against the cookie set in step 1 closes that gap.
  if (!state || state !== req.cookies?.state) {
    return res.status(401).send("State validation failed — please restart the install");
  }
  res.clearCookie("state");

  try {
    const accessToken = await exchangeCodeForToken(shop, code);
    const notifyEmail = await fetchShopEmail(shop, accessToken);
    const dashboardToken = saveShop(shop, accessToken, notifyEmail);
    await registerWebhooks(shop, accessToken);

    res.redirect(`/dashboard.html?shop=${shop}&token=${dashboardToken}`);
  } catch (err) {
    console.error("OAuth callback failed:", err.response?.data || err.message);
    res.status(500).send("Installation failed — check server logs");
  }
});

module.exports = router;
