require("dotenv").config();
const express = require("express");
const path = require("path");
const cookieParser = require("cookie-parser");

const authRoutes = require("./src/routes/auth");
const dashboardRoutes = require("./src/routes/dashboard");
const webhookRoutes = require("./src/webhooks");
const { startScheduler } = require("./src/cron");

const app = express();

app.use(cookieParser());
app.use(express.static(path.join(__dirname, "public")));

// Webhook routes need the raw body for HMAC verification, so they parse
// their own JSON (see webhooks.js) — mount them BEFORE the global parser.
app.use("/webhooks", webhookRoutes);

app.use(express.json());
app.use(authRoutes);
app.use(dashboardRoutes);

app.get("/", (req, res) => {
  res.send(
    `Order Trust is running. Install on a store via /auth?shop=your-store.myshopify.com`
  );
});

app.get("/health", (req, res) => res.json({ status: "ok" }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Order Trust listening on port ${PORT}`);
  startScheduler();
});
