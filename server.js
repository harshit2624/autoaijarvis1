/**
 * ╔══════════════════════════════════════════════════════════╗
 * ║         JARVIS × Shopify — Render.com Server            ║
 * ║  OAuth 2.0 Client Credentials Grant (latest Shopify)    ║
 * ╚══════════════════════════════════════════════════════════╝
 *
 * DEPLOY TO RENDER:
 *   1. Push this folder to GitHub
 *   2. New Web Service → connect repo
 *   3. Build Command : npm install
 *   4. Start Command : node server.js
 *   5. Add env vars in Render dashboard (see .env.example)
 */

const express   = require("express");
const cors      = require("cors");
const crypto    = require("crypto");
const fetch     = (...a) => import("node-fetch").then(({ default: f }) => f(...a));
require("dotenv").config();

const app = express();

app.use(express.static('.'));

// ── Raw body needed for webhook HMAC verification ──────────────────────────
app.use("/webhooks", express.raw({ type: "application/json" }));
app.use(express.json());

// ── CORS — allow your deployed frontend URL ────────────────────────────────
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "*").split(",").map(s => s.trim());
app.use(cors({
  origin: (origin, cb) => {
    if (ALLOWED_ORIGINS.includes("*") || !origin || ALLOWED_ORIGINS.includes(origin)) {
      cb(null, true);
    } else {
      cb(new Error("CORS: origin not allowed"));
    }
  },
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
}));

// ── Config ─────────────────────────────────────────────────────────────────
const SHOP          = process.env.SHOP_NAME;           // e.g. mystore
const CLIENT_ID     = process.env.SHOPIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;
const PORT          = process.env.PORT || 3001;        // Render sets PORT automatically

if (!SHOP || !CLIENT_ID || !CLIENT_SECRET) {
  console.error("❌  Missing env vars: SHOP_NAME, SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET");
  process.exit(1);
}

// ── Token Cache (Shopify tokens expire every 24 hrs) ──────────────────────
let tokenCache = { token: null, expiresAt: 0 };

async function getAccessToken() {
  const now = Date.now();
  if (tokenCache.token && now < tokenCache.expiresAt - 60_000) return tokenCache.token;

  console.log("🔑  Fetching new Shopify access token...");
  const res = await fetch(`https://${SHOP}.myshopify.com/admin/oauth/access_token`, {
    method:  "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body:    new URLSearchParams({
      grant_type:    "client_credentials",
      client_id:     CLIENT_ID,
      client_secret: CLIENT_SECRET,
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Shopify OAuth error: ${JSON.stringify(err)}`);
  }

  const data = await res.json();
  tokenCache = { token: data.access_token, expiresAt: now + data.expires_in * 1000 };
  console.log(`✅  Token obtained — scopes: ${data.scope}`);
  if (!data.scope?.includes("read_all_orders")) {
    console.warn("⚠️  WARNING: 'read_all_orders' scope is missing — Orders API will only return the last 60 days.");
    console.warn("   Fix: Shopify Admin → Settings → Apps → Develop apps → your app → Configuration → add 'read_all_orders' → reinstall.");
  }
  return tokenCache.token;
}

// ── Shopify REST helper ────────────────────────────────────────────────────
async function shopifyREST(path) {
  const token = await getAccessToken();
  const res = await fetch(`https://${SHOP}.myshopify.com/admin/api/2025-01${path}`, {
    headers: { "X-Shopify-Access-Token": token, "Content-Type": "application/json" },
  });
  if (!res.ok) throw new Error(`Shopify REST error ${res.status} on ${path}`);
  return res.json();
}

// ── Shopify REST helper — returns body + headers (for pagination) ──────────
async function shopifyRESTRaw(path) {
  const token = await getAccessToken();
  const res = await fetch(`https://${SHOP}.myshopify.com/admin/api/2025-01${path}`, {
    headers: { "X-Shopify-Access-Token": token, "Content-Type": "application/json" },
  });
  if (!res.ok) throw new Error(`Shopify REST error ${res.status} on ${path}`);
  const data = await res.json();
  return { data, link: res.headers.get("link") || "" };
}

// ── Fetch ALL orders using cursor-based pagination ─────────────────────────
// Shopify's default window is ~60 days. Pass created_at_min to go further back.
// Note: date filters only go on the FIRST request — page_info cursors carry the
// full query context, so subsequent pages only need limit + page_info.
async function fetchAllOrders(status = "any", createdAtMin = null, createdAtMax = null) {
  const allOrders = [];

  // Build first-page query
  const params = new URLSearchParams({ limit: "250", status });
  if (createdAtMin) params.set("created_at_min", createdAtMin);
  if (createdAtMax) params.set("created_at_max", createdAtMax);

  let { data, link } = await shopifyRESTRaw(`/orders.json?${params}`);
  allOrders.push(...(data.orders || []));
  console.log(`📄  Page 1 — fetched ${data.orders?.length ?? 0} (total: ${allOrders.length})`);

  // Follow next-page cursors until exhausted
  while (link) {
    const match = link.match(/<([^>]+)>;\s*rel="next"/);
    if (!match) break;
    const pageInfo = new URL(match[1]).searchParams.get("page_info");
    if (!pageInfo) break;

    // When paginating with page_info, ONLY limit is allowed alongside it
    ({ data, link } = await shopifyRESTRaw(`/orders.json?limit=250&page_info=${pageInfo}`));
    allOrders.push(...(data.orders || []));
    console.log(`📄  Page +1 — fetched ${data.orders?.length ?? 0} (total: ${allOrders.length})`);
  }

  console.log(`✅  fetchAllOrders complete — ${allOrders.length} total`);
  return allOrders;
}

// ── Shopify GraphQL helper ─────────────────────────────────────────────────
async function shopifyGQL(query, variables = {}) {
  const token = await getAccessToken();
  const res = await fetch(`https://${SHOP}.myshopify.com/admin/api/2025-01/graphql.json`, {
    method:  "POST",
    headers: { "X-Shopify-Access-Token": token, "Content-Type": "application/json" },
    body:    JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`GraphQL error: ${res.status}`);
  return res.json();
}

// ── In-memory webhook event log (last 100 events) ─────────────────────────
const webhookEvents = [];
function logWebhook(topic, payload) {
  webhookEvents.unshift({ topic, payload, receivedAt: new Date().toISOString() });
  if (webhookEvents.length > 100) webhookEvents.pop();
  console.log(`📦 Webhook received: ${topic}`);
}

// ══════════════════════════════════════════════════════════════════════════
// ROUTES
// ══════════════════════════════════════════════════════════════════════════

// ── Health / wake-up ping (Render free tier keep-alive) ───────────────────
app.get("/health", (_, res) => res.json({
  status: "ok",
  shop:   `${SHOP}.myshopify.com`,
  uptime: process.uptime(),
  time:   new Date().toISOString(),
}));

// ── GET /orders ───────────────────────────────────────────────────────────
app.get("/orders", async (req, res) => {
  try {
    const status       = req.query.status        || "any";
    const createdAtMin = req.query.created_at_min || null;
    const createdAtMax = req.query.created_at_max || null;

    const raw    = await fetchAllOrders(status, createdAtMin, createdAtMax);
    const orders = raw.map(o => ({
      id:        o.name,
      shopifyId: o.id,
      customer:  o.customer
        ? `${o.customer.first_name ?? ""} ${o.customer.last_name ?? ""}`.trim()
        : "Guest",
      email:     o.email ?? "",
      product:   o.line_items?.[0]?.title ?? "—",
      items:     o.line_items?.length ?? 0,
      amount:    parseFloat(o.total_price ?? 0),
      currency:  o.currency ?? "USD",
      status:    mapStatus(o.fulfillment_status),
      financial: o.financial_status ?? "—",
      date:      (o.created_at ?? "").split("T")[0],
      city:      o.shipping_address?.city ?? "—",
      country:   o.shipping_address?.country_code ?? "—",
    }));

    res.json({ orders, total: orders.length });
  } catch (err) {
    console.error("❌ /orders:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /orders/stats ─────────────────────────────────────────────────────
app.get("/orders/stats", async (req, res) => {
  try {
    const base = `/orders/count.json`;
    const [total, fulfilled, pending, cancelled] = await Promise.all([
      shopifyREST(`${base}?status=any`),
      shopifyREST(`${base}?fulfillment_status=fulfilled`),
      shopifyREST(`${base}?fulfillment_status=unfulfilled`),
      shopifyREST(`${base}?status=cancelled`),
    ]);

    // Revenue: sum fulfilled orders (last 50 as approximation)
    const recent = await shopifyREST(`/orders.json?limit=50&status=any&fulfillment_status=fulfilled`);
    const revenue = (recent.orders || []).reduce((sum, o) => sum + parseFloat(o.total_price || 0), 0);

    res.json({
      total:     total.count     ?? 0,
      fulfilled: fulfilled.count ?? 0,
      pending:   pending.count   ?? 0,
      cancelled: cancelled.count ?? 0,
      revenue:   parseFloat(revenue.toFixed(2)),
    });
  } catch (err) {
    console.error("❌ /orders/stats:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /orders/export — CSV download ─────────────────────────────────────
app.get("/orders/export", async (req, res) => {
  try {
    const raw  = await fetchAllOrders("any");
    const rows = [["Order","Customer","Email","Product","Items","Amount","Currency","Status","Financial","Date","City","Country"]];
    raw.forEach(o => {
      rows.push([
        o.name,
        o.customer ? `${o.customer.first_name ?? ""} ${o.customer.last_name ?? ""}`.trim() : "Guest",
        o.email ?? "",
        o.line_items?.[0]?.title ?? "—",
        o.line_items?.length ?? 0,
        o.total_price ?? 0,
        o.currency ?? "USD",
        o.fulfillment_status ?? "unfulfilled",
        o.financial_status ?? "—",
        (o.created_at ?? "").split("T")[0],
        o.shipping_address?.city ?? "—",
        o.shipping_address?.country_code ?? "—",
      ]);
    });
    const csv = rows.map(r => r.map(v => `"${String(v).replace(/"/g,'""')}"`).join(",")).join("\n");
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="shopify-orders-${Date.now()}.csv"`);
    res.send(csv);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /webhooks/events — see recent webhook events ──────────────────────
app.get("/webhooks/events", (_, res) => res.json({ events: webhookEvents }));

// ── POST /webhooks/orders — Shopify sends events here ─────────────────────
// Register this URL in Shopify: Settings → Notifications → Webhooks
// URL: https://YOUR-RENDER-APP.onrender.com/webhooks/orders
app.post("/webhooks/orders", (req, res) => {
  // Verify the webhook is genuinely from Shopify
  const hmac      = req.headers["x-shopify-hmac-sha256"];
  const topic     = req.headers["x-shopify-topic"] ?? "unknown";
  const rawBody   = req.body;

  if (CLIENT_SECRET && hmac) {
    const computed = crypto
      .createHmac("sha256", CLIENT_SECRET)
      .update(rawBody)
      .digest("base64");

    if (!crypto.timingSafeEqual(Buffer.from(hmac), Buffer.from(computed))) {
      console.warn("⚠️  Webhook HMAC mismatch — rejected");
      return res.status(401).json({ error: "Unauthorized" });
    }
  }

  try {
    const payload = JSON.parse(rawBody.toString());
    logWebhook(topic, payload);
  } catch {
    logWebhook(topic, {});
  }

  res.status(200).json({ received: true });
});

// ── POST /chat — JARVIS AI chat (proxies to Anthropic, keeps API key server-side)
app.post("/chat", async (req, res) => {
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) {
    return res.status(503).json({ error: "ANTHROPIC_API_KEY not set in environment." });
  }

  const { messages, context } = req.body;
  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: "messages array required." });
  }

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type":         "application/json",
        "x-api-key":            ANTHROPIC_KEY,
        "anthropic-version":    "2023-06-01",
      },
      body: JSON.stringify({
        model:      "claude-haiku-4-5-20251001",
        max_tokens: 500,
        system: `You are JARVIS, a sharp e-commerce assistant for a Shopify store called CrosCrow.
You have access to live store data. Answer concisely — 1-3 sentences max unless a list is needed.
Always use real numbers from the data provided. Be direct, no filler.
${context ? `\nLive store snapshot:\n${JSON.stringify(context, null, 2)}` : ""}`,
        messages: messages.map(m => ({
          role:    m.role === "bot" ? "assistant" : "user",
          content: m.text,
        })),
      }),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.error?.message || `Anthropic error ${response.status}`);
    }

    const data = await response.json();
    res.json({ reply: data.content?.[0]?.text || "No response." });
  } catch (err) {
    console.error("❌ /chat:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Utility ────────────────────────────────────────────────────────────────
function mapStatus(s) {
  if (!s) return "pending";
  s = s.toLowerCase();
  if (s === "fulfilled" || s === "shipped" || s.includes("fulfil")) return "fulfilled";
  if (s === "cancelled" || s === "canceled") return "cancelled";
  return "pending";
}

// ── Start ──────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚀  JARVIS Shopify Server running on port ${PORT}`);
  console.log(`    Shop    : ${SHOP}.myshopify.com`);
  console.log(`    Health  : /health`);
  console.log(`    Orders  : /orders`);
  console.log(`    Stats   : /orders/stats`);
  console.log(`    Export  : /orders/export`);
  console.log(`    Webhook : POST /webhooks/orders\n`);
});
