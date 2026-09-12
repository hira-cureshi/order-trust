# Order Trust — v1 (alert-first)

Watches a Shopify store's orders and raises two kinds of alerts to the
**merchant** (not the customer — this is a deliberate change from an
earlier draft):

1. **Aging order alerts** — a specific line item has sat unfulfilled too
   long. Based on the honest, unfakeable fact that no fulfillment click
   happened — not on trusting Shopify's "fulfilled" status.
2. **Pattern-shift alerts** — a supplier's recent fulfillment speed has
   drifted well above their own historical normal. Compares a supplier to
   itself, not to a fixed number, so it's fair to naturally-slower
   suppliers and doesn't require trusting the "fulfilled ≠ shipped"
   timestamp problem.

This version reflects real feedback gathered from Shopify Community threads
and direct testing (a CSV export test confirmed Shopify's "fulfilled"
status can be set with zero shipping proof — see `order-trust-validation-notes.md`
for the full history). It deliberately does NOT include: a supplier
scorecard dashboard, SKU-level scoring, lead-time-vs-transit-time
splitting, or chargeback/dispute automation — all cut to keep v1 lightweight,
per direct advice from several people who reviewed the idea.

**Tested end-to-end before being handed over** — not just "should work."
Specifically verified:
- Vendor name normalization actually merges "Supplier Alpha" / "supplier alpha" / "Supplier Alpha37" into one supplier
- A supplier sitting unfulfilled for 9 days correctly triggers an aging alert
- A supplier whose last 3 orders suddenly took 15x longer than their historical 6-order average correctly triggers a pattern-shift alert
- A supplier with only 2 orders ever does NOT get scored (noise-filter working — avoids false alerts on too little data)
- The real HTTP API and dashboard serve this data correctly, not just the underlying functions
- Dashboard access requires the correct per-shop secret token — verified a missing or wrong token gets rejected (401), only the correct one succeeds
- Data rendered in the dashboard is HTML-escaped, closing a real XSS risk
- OAuth install requests are verified against the original state cookie, closing a forged-install risk
- Each shop's Shopify access token is encrypted before it's stored — verified the raw database value is unreadable ciphertext, while the app still correctly decrypts it when needed. The app now refuses to start saving tokens at all if ENCRYPTION_KEY isn't set, rather than silently storing them in plain text.

## Before you deploy: one required setup step

You must generate a real `ENCRYPTION_KEY` and set it as an environment
variable wherever this is deployed (Railway/Render's Variables tab) —
without it, the app will throw an error the moment anyone tries to
install it, rather than fall back to storing tokens insecurely. Generate
one with:
```
openssl rand -hex 32
```
If you don't have a terminal handy, any trusted "generate random hex"
tool set to 64 characters / 32 bytes works too — just don't reuse the
placeholder value in `.env.example`.

---

## Part 1 — What's actually built vs. what you still need to do

**Built and working right now:**
- Shopify OAuth install flow
- Webhook handlers for new orders, shipment updates, and refunds
- Automatic customer emails at each shipping stage
- The "stalled order" risk engine (flags + emails after N idle days)
- Supplier reliability tracking (delays + refunds per supplier)
- A dashboard showing at-risk orders and supplier stats

**You still need to do (none of this requires code — it's account setup):**
1. Create a free Shopify Partner account
2. Create a free SendGrid account (for sending the emails)
3. Deploy this code somewhere public (so Shopify can reach it)
4. Point the app at a real or test Shopify store

Each step below is exact and in order.

---

## Part 2 — Step-by-step setup

### Step 1: Get your code running locally first (15 min)
```
npm install
cp .env.example .env
node server.js
```
You should see `Order Trust listening on port 3000`. Visit
`http://localhost:3000` — it should say the app is running.

### Step 2: Create a Shopify Partner account (free, 10 min)
1. Go to partners.shopify.com → sign up (free)
2. In the dashboard: **Apps → Create app → Create app manually**
3. Name it "Order Trust" (or whatever you like)
4. You'll get an **API key** and **API secret** — copy both into your `.env`
5. Also create a **free development store** (Partner dashboard → Stores →
   Add store → Development store) — this is your safe testing sandbox with
   fake orders, no real customers involved

### Step 3: Deploy the app so it has a public URL (20-30 min)
Shopify requires your app to be reachable over HTTPS from the internet —
`localhost` won't work for the real OAuth flow. Easiest free options:
- **Render.com** (recommended for beginners — free tier, connects directly to a GitHub repo)
- **Railway.app** (similarly simple, usage-based free tier)

Steps (Render, as example):
1. Push this folder to a GitHub repo
2. Render → New → Web Service → connect the repo
3. Build command: `npm install` — Start command: `node server.js`
4. Add your `.env` values as Environment Variables in Render's dashboard
5. Once deployed, Render gives you a URL like `https://order-trust.onrender.com`
   — set that as `APP_URL` in your environment variables and redeploy

### Step 4: Set your app URLs in the Shopify Partner dashboard
In your app's settings in the Partner dashboard:
- App URL: `https://your-app-url.com`
- Allowed redirection URL: `https://your-app-url.com/auth/callback`

### Step 5: Install it on your dev store
Visit: `https://your-app-url.com/auth?shop=your-dev-store.myshopify.com`
Approve the permissions screen. You'll land on the dashboard.

### Step 6: Create a test order and watch it flow through
In your dev store admin, create a test order. Within seconds it should
appear in Order Trust's database, and (if SendGrid is configured) the
"order confirmed" email should send. Fulfill the order with tracking to see
the "in transit" email fire too.

### Step 7: Connect SendGrid (free tier: 100 emails/day)
1. sendgrid.com → free account
2. Settings → API Keys → create one → put it in `.env` as `SENDGRID_API_KEY`
3. Verify a sender email (Settings → Sender Authentication) — use this as
   `FROM_EMAIL`

---

## Part 3 — The actual launch plan (people, not code)

Building it is maybe 30% of the work. Here's the rest, week by week, inside
your 2-3 hrs/day:

**Week 1 — Validate before you polish**
Post in r/dropship, r/shopify, r/ecommerce: describe the problem (silent
customers → chargebacks) and ask if this is something they'd want. Don't
pitch the product hard — ask what they currently do about it. This tells
you if the pain is real before you spend more time building.

**Week 2 — Get the deploy live + install on your own old dropshipping
store if you still have access**, or a fresh dev store. Fix whatever breaks
in real conditions — API rate limits, webhook edge cases, etc.

**Week 3-4 — Recruit 5-10 pilot users, free**
DM people who engaged in the Week 1 posts. Offer it free for 60 days in
exchange for feedback. Your pitch: "I built a tool that automatically
emails your customers before they ask where their order is, so you catch
problems before a chargeback. Want to try it free?"

**Week 5-6 — Watch what they actually use**
Talk to each pilot user once. Ask: did any order actually get caught by
the risk flag? Did it feel accurate? What did they check the dashboard for?
This tells you what to build next — the supplier trend view might matter
more (or less) than you assumed.

**Month 2-3 — Charge**
Once 2-3 pilot users say they'd be annoyed to lose it, add Shopify's
Billing API (a recurring charge, e.g. $19-29/mo) and convert them from free
to paid. This is the real validation — free "yes" doesn't count, paid "yes"
does.

---

## Part 4 — Growing past SQLite (only once you have real users)

SQLite (used here) is perfect for the first 10-50 shops and $0 database
cost. Once you're past that, or if your host's disk isn't persistent
(check this — some free tiers wipe the filesystem on redeploy), migrate to
a hosted Postgres instance (Render and Railway both offer this in a few
clicks) and swap `better-sqlite3` calls for a Postgres client. Everything
else in the codebase stays the same.

---

## File map
```
server.js                 — starts everything
src/shopify.js             — OAuth + webhook signature verification + shop email lookup
src/vendorNormalize.js     — merges free-text vendor name duplicates
src/webhooks.js            — saves order/fulfillment/refund events PER LINE ITEM
src/riskEngine.js          — the actual product: aging + pattern-shift alert logic
src/email.js               — sends the merchant a digest when new alerts fire
src/cron.js                — runs the alert check every 6 hours
src/db.js                  — SQLite schema (Node's built-in node:sqlite — no native
                              module to compile, avoids a real deployment failure
                              mode with the previous better-sqlite3 dependency)
src/routes/auth.js         — the install flow
src/routes/dashboard.js    — API serving alerts + vendor baselines
public/                    — the dashboard itself (plain HTML/CSS/JS)
```

## A known, honest limitation (not fixed in this version)

Alerts are still based on Shopify's own `fulfilled` timestamp, which — as
confirmed by hands-on testing — can be set the instant a supplier clicks a
button, with no proof the package actually moved. The pattern-shift alert
is designed to be useful anyway (a real supplier slowdown usually shows up
even in imperfect timestamp data), but it cannot fully distinguish "this
supplier is genuinely slow" from "this supplier is gaming the fulfilled
status." Solving that fully would mean integrating a real carrier-tracking
API (AfterShip, Track123) — a deliberate v2 decision, not done here, since
those APIs have real per-shipment costs that need a paying customer base
to justify.
