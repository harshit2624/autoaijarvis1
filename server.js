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
const Database  = require("better-sqlite3");
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

// ── SQLite — persistent store for CrosCrow metadata ───────────────────────
const db = new Database("./croscrow.db");
db.exec(`
  CREATE TABLE IF NOT EXISTS order_meta (
    shopify_id    TEXT PRIMARY KEY,
    stage         TEXT DEFAULT 'new',
    payment_type  TEXT DEFAULT 'cod',
    advance_paid  REAL DEFAULT 0,
    shipping_charge REAL DEFAULT 0,
    notes         TEXT DEFAULT '',
    awb           TEXT DEFAULT '',
    courier       TEXT DEFAULT '',
    tracking_url  TEXT DEFAULT '',
    updated_at    TEXT DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS vendor_config (
    vendor_name    TEXT PRIMARY KEY,
    commission_pct REAL DEFAULT 20,
    active         INTEGER DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS settlements (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    vendor_name    TEXT NOT NULL,
    period_start   TEXT,
    period_end     TEXT,
    total_orders   INTEGER DEFAULT 0,
    gross_revenue  REAL DEFAULT 0,
    commission     REAL DEFAULT 0,
    gst_amount     REAL DEFAULT 0,
    advance_total  REAL DEFAULT 0,
    net_payable    REAL DEFAULT 0,
    status         TEXT DEFAULT 'pending',
    invoice_no     TEXT,
    created_at     TEXT,
    paid_at        TEXT
  );
  CREATE TABLE IF NOT EXISTS settlement_orders (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    settlement_id     INTEGER REFERENCES settlements(id),
    shopify_order_id  TEXT,
    order_name        TEXT,
    my_revenue        REAL,
    payment_type      TEXT,
    commission_pct    REAL,
    commission        REAL,
    gst               REAL,
    advance_paid      REAL,
    net               REAL
  );
  CREATE TABLE IF NOT EXISTS wallet_tx (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    vendor_name  TEXT NOT NULL,
    type         TEXT,
    amount       REAL,
    description  TEXT,
    ref_id       TEXT,
    created_at   TEXT
  );
  CREATE TABLE IF NOT EXISTS audit_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    actor      TEXT,
    action     TEXT,
    target_id  TEXT,
    details    TEXT,
    created_at TEXT
  );
`);

// ── Commission + GST calculation ──────────────────────────────────────────
const GST_RATE = 0.18;

function calcCommission(myRevenue, paymentType, commPct, advancePaid = 0) {
  const rate = (commPct || 20) / 100;
  let base = myRevenue;
  if (paymentType === "prepaid") base = myRevenue * 0.9; // vendor gives 10% discount

  const commission = parseFloat((base * rate).toFixed(2));
  const gst        = parseFloat((commission * GST_RATE).toFixed(2));
  const invoice    = parseFloat((commission + gst).toFixed(2));

  if (paymentType === "prepaid") {
    // CrosCrow collected full amount → pays vendor (base - commission - gst)
    const vendorNet = parseFloat((base - commission - gst).toFixed(2));
    return { base, commission, gst, invoice, net: -vendorNet, type: "payout" };
  }
  // COD / partial → vendor pays CrosCrow
  const net = parseFloat((invoice - (advancePaid || 0)).toFixed(2));
  return { base, commission, gst, invoice, advancePaid: advancePaid || 0, net, type: "receivable" };
}

// ── Admin auth ────────────────────────────────────────────────────────────
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "CrosCrowAdmin@00";
const adminSessions  = new Map();

function adminAuth(req, res, next) {
  const token = (req.headers.authorization || "").replace("Bearer ", "").trim();
  if (!token || !adminSessions.has(token)) return res.status(401).json({ error: "Unauthorized" });
  const s = adminSessions.get(token);
  if (Date.now() > s.expiresAt) { adminSessions.delete(token); return res.status(401).json({ error: "Session expired" }); }
  next();
}

function auditLog(actor, action, targetId, details) {
  try {
    db.prepare("INSERT INTO audit_log (actor,action,target_id,details,created_at) VALUES (?,?,?,?,?)")
      .run(actor, action, String(targetId), typeof details === "object" ? JSON.stringify(details) : String(details || ""), new Date().toISOString());
  } catch {}
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

// ══════════════════════════════════════════════════════════════════════════
// VENDOR PORTAL
// ══════════════════════════════════════════════════════════════════════════

const VENDOR_PASSWORD = process.env.VENDOR_PASSWORD || "Croscrow@00";
const vendorSessions  = new Map(); // token → { vendorName, expiresAt }

function vendorAuth(req, res, next) {
  const token = (req.headers.authorization || "").replace("Bearer ", "").trim();
  if (!token || !vendorSessions.has(token)) return res.status(401).json({ error: "Unauthorized" });
  const s = vendorSessions.get(token);
  if (Date.now() > s.expiresAt) { vendorSessions.delete(token); return res.status(401).json({ error: "Session expired. Please log in again." }); }
  req.vendor = s.vendorName;
  next();
}

// ── GET /vendor/list ─────────────────────────────────────────────────────
app.get("/vendor/list", async (req, res) => {
  try {
    const vendors = await getVendorList();
    res.json({ vendors });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

async function getVendorList() {
  let all = [], page = 1;
  while (true) {
    const data = await shopifyREST(`/products.json?limit=250&fields=vendor&page=${page}`);
    const batch = data.products || [];
    all.push(...batch);
    if (batch.length < 250) break;
    page++;
  }
  return [...new Set(all.map(p => p.vendor).filter(Boolean))].sort();
}

// ── POST /vendor/login ────────────────────────────────────────────────────
app.post("/vendor/login", async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: "Username and password required." });
  if (password !== VENDOR_PASSWORD)  return res.status(401).json({ error: "Invalid password." });
  try {
    const vendors = await getVendorList();
    const matched = vendors.find(v => v.toLowerCase() === username.toLowerCase().trim());
    if (!matched) return res.status(401).json({ error: `Vendor "${username}" not found in store.` });
    const token = crypto.randomBytes(32).toString("hex");
    vendorSessions.set(token, { vendorName: matched, expiresAt: Date.now() + 24 * 60 * 60 * 1000 });
    console.log(`🔓  Vendor login: ${matched}`);
    res.json({ token, vendorName: matched });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── POST /vendor/logout ───────────────────────────────────────────────────
app.post("/vendor/logout", vendorAuth, (req, res) => {
  const token = req.headers.authorization.replace("Bearer ", "").trim();
  vendorSessions.delete(token);
  res.json({ success: true });
});

// ── GET /vendor/orders ────────────────────────────────────────────────────
app.get("/vendor/orders", vendorAuth, async (req, res) => {
  try {
    const { created_at_min, created_at_max } = req.query;
    const allOrders = await fetchAllOrders("any",
      created_at_min || "2000-01-01T00:00:00Z",
      created_at_max || null
    );
    const vName = req.vendor.toLowerCase();

    const orders = allOrders
      .filter(o => (o.line_items || []).some(li => (li.vendor || "").toLowerCase() === vName))
      .map(o => {
        const myItems = (o.line_items || []).filter(li => (li.vendor || "").toLowerCase() === vName);
        const myRevenue = myItems.reduce((s, li) => s + parseFloat(li.price || 0) * (li.quantity || 1), 0);
        return {
          id:           o.name,
          shopifyId:    String(o.id),
          customer:     o.customer ? `${o.customer.first_name ?? ""} ${o.customer.last_name ?? ""}`.trim() : "Guest",
          email:        o.email        ?? "",
          phone:        o.shipping_address?.phone ?? o.customer?.phone ?? "",
          date:         (o.created_at ?? "").split("T")[0],
          status:       mapStatus(o.fulfillment_status),
          financial:    o.financial_status ?? "—",
          tags:         o.tags ?? "",
          currency:     o.currency ?? "INR",
          myRevenue:    parseFloat(myRevenue.toFixed(2)),
          myItems: myItems.map(li => ({
            id:        li.id,
            title:     li.title,
            variant:   li.variant_title || "",
            sku:       li.sku || "",
            quantity:  li.quantity,
            price:     parseFloat(li.price || 0),
            fulfilled: li.fulfillment_status === "fulfilled",
          })),
          fulfillments: (o.fulfillments || []).map(f => ({
            id:       f.id,
            status:   f.status,
            courier:  f.tracking_company || "",
            awb:      f.tracking_number  || "",
            url:      f.tracking_url     || "",
            date:     (f.created_at || "").split("T")[0],
          })),
          shippingAddress: o.shipping_address ? {
            name:    o.shipping_address.name    || "",
            line1:   o.shipping_address.address1 || "",
            line2:   o.shipping_address.address2 || "",
            city:    o.shipping_address.city     || "",
            state:   o.shipping_address.province || "",
            zip:     o.shipping_address.zip      || "",
            country: o.shipping_address.country  || "",
            phone:   o.shipping_address.phone    || "",
          } : null,
        };
      });

    res.json({ orders, total: orders.length });
  } catch (err) {
    console.error("❌ /vendor/orders:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /vendor/stats ─────────────────────────────────────────────────────
app.get("/vendor/stats", vendorAuth, async (req, res) => {
  try {
    const allOrders = await fetchAllOrders("any", "2000-01-01T00:00:00Z", null);
    const vName = req.vendor.toLowerCase();
    const mine  = allOrders.filter(o => (o.line_items || []).some(li => (li.vendor || "").toLowerCase() === vName));

    const revenue = mine.reduce((s, o) => {
      const items = (o.line_items || []).filter(li => (li.vendor || "").toLowerCase() === vName);
      return s + items.reduce((ss, li) => ss + parseFloat(li.price || 0) * (li.quantity || 1), 0);
    }, 0);
    const fulfilled = mine.filter(o => o.fulfillment_status === "fulfilled").length;
    const pending   = mine.filter(o => !o.fulfillment_status || o.fulfillment_status === "unfulfilled").length;
    const cancelled = mine.filter(o => o.financial_status   === "voided" || o.cancelled_at).length;

    res.json({
      total: mine.length,
      revenue: parseFloat(revenue.toFixed(2)),
      avg: mine.length ? parseFloat((revenue / mine.length).toFixed(2)) : 0,
      fulfilled, pending, cancelled,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GET /vendor/products ──────────────────────────────────────────────────
app.get("/vendor/products", vendorAuth, async (req, res) => {
  try {
    const data = await shopifyREST(`/products.json?vendor=${encodeURIComponent(req.vendor)}&limit=250`);
    const products = (data.products || []).map(p => ({
      id:      p.id,
      title:   p.title,
      status:  p.status,
      image:   p.image?.src || null,
      type:    p.product_type || "",
      variants: (p.variants || []).map(v => ({
        id:        v.id,
        title:     v.title,
        sku:       v.sku || "",
        price:     parseFloat(v.price || 0),
        inventory: v.inventory_quantity ?? "—",
      })),
    }));
    res.json({ products });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── POST /vendor/orders/:shopifyId/fulfill ────────────────────────────────
// Uses Shopify's Fulfillment Orders API (2022-07+)
app.post("/vendor/orders/:shopifyId/fulfill", vendorAuth, async (req, res) => {
  const { shopifyId } = req.params;
  const { courier, awb, trackingUrl, notifyCustomer = true } = req.body || {};
  if (!awb) return res.status(400).json({ error: "AWB / tracking number is required." });

  try {
    const token = await getAccessToken();

    // Step 1: get fulfillment orders for this order
    const foRes = await fetch(
      `https://${SHOP}.myshopify.com/admin/api/2025-01/orders/${shopifyId}/fulfillment_orders.json`,
      { headers: { "X-Shopify-Access-Token": token } }
    );
    if (!foRes.ok) throw new Error(`Could not get fulfillment orders: ${foRes.status}`);
    const foData = await foRes.json();
    const openFOs = (foData.fulfillment_orders || []).filter(fo => fo.status === "open");
    if (!openFOs.length) return res.status(400).json({ error: "No open fulfillment orders found. Order may already be fulfilled." });

    // Step 2: create fulfillment
    const fulfillBody = {
      fulfillment: {
        line_items_by_fulfillment_order: openFOs.map(fo => ({ fulfillment_order_id: fo.id })),
        tracking_info: { number: awb, url: trackingUrl || "", company: courier || "" },
        notify_customer: notifyCustomer,
      },
    };
    const fRes = await fetch(
      `https://${SHOP}.myshopify.com/admin/api/2025-01/fulfillments.json`,
      {
        method:  "POST",
        headers: { "X-Shopify-Access-Token": token, "Content-Type": "application/json" },
        body:    JSON.stringify(fulfillBody),
      }
    );
    if (!fRes.ok) {
      const err = await fRes.json().catch(() => ({}));
      throw new Error(JSON.stringify(err.errors || err));
    }
    const fData = await fRes.json();
    console.log(`📦  Fulfillment created for order ${shopifyId} by vendor ${req.vendor}`);
    res.json({ success: true, fulfillment: fData.fulfillment });
  } catch (err) {
    console.error("❌ /vendor/fulfill:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /vendor/orders/:shopifyId/tag ────────────────────────────────────
app.post("/vendor/orders/:shopifyId/tag", vendorAuth, async (req, res) => {
  const { shopifyId } = req.params;
  const { tags } = req.body || {};
  if (tags === undefined) return res.status(400).json({ error: "tags field required." });
  try {
    const token = await getAccessToken();
    const r = await fetch(
      `https://${SHOP}.myshopify.com/admin/api/2025-01/orders/${shopifyId}.json`,
      {
        method:  "PUT",
        headers: { "X-Shopify-Access-Token": token, "Content-Type": "application/json" },
        body:    JSON.stringify({ order: { id: shopifyId, tags } }),
      }
    );
    if (!r.ok) throw new Error(`Shopify error ${r.status}`);
    const d = await r.json();
    res.json({ success: true, tags: d.order.tags });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════════════════════════════════════
// ADMIN PORTAL
// ══════════════════════════════════════════════════════════════════════════

app.post("/admin/login", (req, res) => {
  const { password } = req.body || {};
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ error: "Invalid admin password." });
  const token = crypto.randomBytes(32).toString("hex");
  adminSessions.set(token, { expiresAt: Date.now() + 8 * 60 * 60 * 1000 });
  auditLog("admin", "login", "-", {});
  res.json({ token });
});

app.post("/admin/logout", adminAuth, (req, res) => {
  adminSessions.delete(req.headers.authorization.replace("Bearer ", "").trim());
  res.json({ success: true });
});

// ── GET /admin/dashboard ──────────────────────────────────────────────────
app.get("/admin/dashboard", adminAuth, async (req, res) => {
  try {
    const raw    = await fetchAllOrders("any", "2000-01-01T00:00:00Z", null);
    const metas  = db.prepare("SELECT * FROM order_meta").all();
    const metaMap = Object.fromEntries(metas.map(m => [m.shopify_id, m]));

    const STAGES = ["new","confirmed","ready","pickup","transit","delivered","rto","hold","cancelled"];
    const stageCounts = Object.fromEntries(STAGES.map(s => [s, 0]));
    let totalRevenue = 0;

    raw.forEach(o => {
      const meta  = metaMap[String(o.id)];
      const stage = meta?.stage || "new";
      if (stageCounts[stage] !== undefined) stageCounts[stage]++;
      totalRevenue += parseFloat(o.total_price || 0);
    });

    const pendRow = db.prepare("SELECT SUM(commission+gst_amount) as t FROM settlements WHERE status='pending'").get();
    res.json({
      totalOrders: raw.length,
      stageCounts,
      totalRevenue: parseFloat(totalRevenue.toFixed(2)),
      pendingCommission: parseFloat((pendRow?.t || 0).toFixed(2)),
    });
  } catch (err) {
    console.error("❌ /admin/dashboard:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /admin/orders ─────────────────────────────────────────────────────
app.get("/admin/orders", adminAuth, async (req, res) => {
  try {
    const { stage, vendor, created_at_min, created_at_max } = req.query;
    const raw    = await fetchAllOrders("any", created_at_min || "2000-01-01T00:00:00Z", created_at_max || null);
    const metas  = db.prepare("SELECT * FROM order_meta").all();
    const metaMap = Object.fromEntries(metas.map(m => [m.shopify_id, m]));

    let orders = raw.map(o => {
      const meta    = metaMap[String(o.id)] || {};
      const vendors = [...new Set((o.line_items || []).map(li => li.vendor).filter(Boolean))];
      const myRev   = (o.line_items || []).reduce((s, li) => s + parseFloat(li.price || 0) * (li.quantity || 1), 0);
      const shipping = parseFloat(o.total_shipping_price_set?.shop_money?.amount || 0);
      return {
        id:             o.name,
        shopifyId:      String(o.id),
        customer:       o.customer ? `${o.customer.first_name ?? ""} ${o.customer.last_name ?? ""}`.trim() : "Guest",
        email:          o.email || "",
        phone:          o.shipping_address?.phone || "",
        date:           (o.created_at || "").split("T")[0],
        orderValue:     parseFloat((o.total_price || 0)),
        myRevenue:      parseFloat(myRev.toFixed(2)),
        shippingCharge: shipping,
        currency:       o.currency || "INR",
        fulfillment:    o.fulfillment_status || "unfulfilled",
        financial:      o.financial_status || "",
        vendors,
        stage:          meta.stage || "new",
        paymentType:    meta.payment_type || "cod",
        advancePaid:    meta.advance_paid || 0,
        notes:          meta.notes || "",
        awb:            meta.awb || "",
        courier:        meta.courier || "",
        trackingUrl:    meta.tracking_url || "",
        lineItems:      (o.line_items || []).map(li => ({
          title: li.title, vendor: li.vendor, qty: li.quantity,
          price: parseFloat(li.price || 0), sku: li.sku || "",
        })),
        shippingAddress: o.shipping_address || null,
      };
    });

    if (stage && stage !== "all") orders = orders.filter(o => o.stage === stage);
    if (vendor) orders = orders.filter(o => o.vendors.some(v => v.toLowerCase() === vendor.toLowerCase()));

    res.json({ orders, total: orders.length });
  } catch (err) {
    console.error("❌ /admin/orders:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── PUT /admin/orders/:id/stage ───────────────────────────────────────────
app.put("/admin/orders/:id/stage", adminAuth, (req, res) => {
  const { id } = req.params;
  const { stage } = req.body || {};
  const VALID = ["new","confirmed","ready","pickup","transit","delivered","rto","hold","cancelled"];
  if (!VALID.includes(stage)) return res.status(400).json({ error: "Invalid stage." });

  db.prepare(`INSERT INTO order_meta (shopify_id, stage, updated_at) VALUES (?,?,?)
    ON CONFLICT(shopify_id) DO UPDATE SET stage=excluded.stage, updated_at=excluded.updated_at`)
    .run(id, stage, new Date().toISOString());
  auditLog("admin", "stage_change", id, { stage });
  res.json({ success: true, stage });
});

// ── PUT /admin/orders/:id/meta ────────────────────────────────────────────
app.put("/admin/orders/:id/meta", adminAuth, (req, res) => {
  const { id } = req.params;
  const { payment_type, advance_paid, shipping_charge, notes, awb, courier, tracking_url } = req.body || {};

  db.prepare(`INSERT INTO order_meta (shopify_id, payment_type, advance_paid, shipping_charge, notes, awb, courier, tracking_url, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?)
    ON CONFLICT(shopify_id) DO UPDATE SET
      payment_type    = COALESCE(excluded.payment_type, payment_type),
      advance_paid    = COALESCE(excluded.advance_paid, advance_paid),
      shipping_charge = COALESCE(excluded.shipping_charge, shipping_charge),
      notes           = COALESCE(excluded.notes, notes),
      awb             = COALESCE(excluded.awb, awb),
      courier         = COALESCE(excluded.courier, courier),
      tracking_url    = COALESCE(excluded.tracking_url, tracking_url),
      updated_at      = excluded.updated_at`)
    .run(id, payment_type || "cod", advance_paid || 0, shipping_charge || 0,
      notes || "", awb || "", courier || "", tracking_url || "", new Date().toISOString());

  auditLog("admin", "meta_update", id, req.body);
  res.json({ success: true });
});

// ── GET /admin/vendors ────────────────────────────────────────────────────
app.get("/admin/vendors", adminAuth, async (req, res) => {
  try {
    const vendors = await getVendorList();
    const configs = db.prepare("SELECT * FROM vendor_config").all();
    const cfgMap  = Object.fromEntries(configs.map(c => [c.vendor_name, c]));
    res.json({ vendors: vendors.map(v => ({
      name:           v,
      commission_pct: cfgMap[v]?.commission_pct ?? 20,
      active:         cfgMap[v]?.active ?? 1,
    }))});
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── PUT /admin/vendors/:name/config ──────────────────────────────────────
app.put("/admin/vendors/:name/config", adminAuth, (req, res) => {
  const name = decodeURIComponent(req.params.name);
  const { commission_pct } = req.body || {};
  if (commission_pct === undefined) return res.status(400).json({ error: "commission_pct required." });

  db.prepare(`INSERT INTO vendor_config (vendor_name, commission_pct) VALUES (?,?)
    ON CONFLICT(vendor_name) DO UPDATE SET commission_pct=excluded.commission_pct`)
    .run(name, parseFloat(commission_pct));
  auditLog("admin", "vendor_config", name, { commission_pct });
  res.json({ success: true });
});

// ── POST /admin/settlements/generate ─────────────────────────────────────
app.post("/admin/settlements/generate", adminAuth, async (req, res) => {
  const { vendor_name, period_start, period_end } = req.body || {};
  if (!vendor_name || !period_start || !period_end)
    return res.status(400).json({ error: "vendor_name, period_start, period_end required." });

  try {
    const existing = db.prepare("SELECT id FROM settlements WHERE vendor_name=? AND period_start=? AND period_end=?")
      .get(vendor_name, period_start, period_end);
    if (existing) return res.status(400).json({ error: "Settlement already exists for this period." });

    const allOrders = await fetchAllOrders("any", period_start + "T00:00:00Z", period_end + "T23:59:59Z");
    const vName  = vendor_name.toLowerCase();
    const config = db.prepare("SELECT * FROM vendor_config WHERE vendor_name=?").get(vendor_name) || { commission_pct: 20 };
    const metas  = db.prepare("SELECT * FROM order_meta").all();
    const metaMap = Object.fromEntries(metas.map(m => [m.shopify_id, m]));

    // Only settle delivered orders
    const vendorDelivered = allOrders.filter(o => {
      const meta = metaMap[String(o.id)];
      return (meta?.stage || "new") === "delivered" &&
        (o.line_items || []).some(li => (li.vendor || "").toLowerCase() === vName);
    });

    let totalRev = 0, totalComm = 0, totalGst = 0, totalAdv = 0;
    const orderDetails = [];

    vendorDelivered.forEach(o => {
      const meta    = metaMap[String(o.id)] || {};
      const myItems = (o.line_items || []).filter(li => (li.vendor || "").toLowerCase() === vName);
      const myRev   = myItems.reduce((s, li) => s + parseFloat(li.price || 0) * (li.quantity || 1), 0);
      const calc    = calcCommission(myRev, meta.payment_type || "cod", config.commission_pct, meta.advance_paid || 0);

      totalRev  += myRev;
      totalComm += calc.commission;
      totalGst  += calc.gst;
      totalAdv  += (meta.advance_paid || 0);

      orderDetails.push({
        shopify_order_id: String(o.id),
        order_name:       o.name,
        my_revenue:       parseFloat(myRev.toFixed(2)),
        payment_type:     meta.payment_type || "cod",
        commission_pct:   config.commission_pct,
        commission:       calc.commission,
        gst:              calc.gst,
        advance_paid:     meta.advance_paid || 0,
        net:              calc.net,
      });
    });

    const netPayable = parseFloat((totalComm + totalGst - totalAdv).toFixed(2));
    const invoiceNo  = `CC-${vendor_name.toUpperCase().replace(/\s+/g,"").slice(0,6)}-${period_start.slice(0,7).replace("-","")}-${String(Date.now()).slice(-4)}`;

    const { lastInsertRowid: settlId } = db.prepare(
      `INSERT INTO settlements (vendor_name,period_start,period_end,total_orders,gross_revenue,commission,gst_amount,advance_total,net_payable,status,invoice_no,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(vendor_name, period_start, period_end, vendorDelivered.length,
      parseFloat(totalRev.toFixed(2)), parseFloat(totalComm.toFixed(2)),
      parseFloat(totalGst.toFixed(2)), parseFloat(totalAdv.toFixed(2)),
      netPayable, "pending", invoiceNo, new Date().toISOString());

    const ins = db.prepare(
      `INSERT INTO settlement_orders (settlement_id,shopify_order_id,order_name,my_revenue,payment_type,commission_pct,commission,gst,advance_paid,net)
       VALUES (?,?,?,?,?,?,?,?,?,?)`
    );
    orderDetails.forEach(od => ins.run(settlId, od.shopify_order_id, od.order_name, od.my_revenue,
      od.payment_type, od.commission_pct, od.commission, od.gst, od.advance_paid, od.net));

    auditLog("admin", "settlement_generated", String(settlId), { vendor_name, period_start, period_end, netPayable });
    res.json({ success: true, settlementId: settlId, invoiceNo, totalOrders: vendorDelivered.length, netPayable });
  } catch (err) {
    console.error("❌ /admin/settlements/generate:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /admin/settlements ────────────────────────────────────────────────
app.get("/admin/settlements", adminAuth, (req, res) => {
  const { vendor_name, status } = req.query;
  const conditions = [], params = [];
  if (vendor_name) { conditions.push("vendor_name=?"); params.push(vendor_name); }
  if (status)      { conditions.push("status=?");      params.push(status); }
  const where = conditions.length ? " WHERE " + conditions.join(" AND ") : "";
  res.json({ settlements: db.prepare(`SELECT * FROM settlements${where} ORDER BY created_at DESC`).all(...params) });
});

// ── GET /admin/settlements/:id ────────────────────────────────────────────
app.get("/admin/settlements/:id", adminAuth, (req, res) => {
  const settlement = db.prepare("SELECT * FROM settlements WHERE id=?").get(req.params.id);
  if (!settlement) return res.status(404).json({ error: "Not found." });
  const orders = db.prepare("SELECT * FROM settlement_orders WHERE settlement_id=?").all(req.params.id);
  res.json({ settlement, orders });
});

// ── PUT /admin/settlements/:id/mark-paid ──────────────────────────────────
app.put("/admin/settlements/:id/mark-paid", adminAuth, (req, res) => {
  const s = db.prepare("SELECT * FROM settlements WHERE id=?").get(req.params.id);
  if (!s) return res.status(404).json({ error: "Not found." });
  db.prepare("UPDATE settlements SET status='paid', paid_at=? WHERE id=?").run(new Date().toISOString(), req.params.id);
  db.prepare("INSERT INTO wallet_tx (vendor_name,type,amount,description,ref_id,created_at) VALUES (?,?,?,?,?,?)")
    .run(s.vendor_name, s.net_payable > 0 ? "debit" : "credit",
      Math.abs(s.net_payable), `Settlement ${s.invoice_no}`, String(s.id), new Date().toISOString());
  auditLog("admin", "settlement_paid", req.params.id, { vendor: s.vendor_name, amount: s.net_payable });
  res.json({ success: true });
});

// ── GET /admin/audit ──────────────────────────────────────────────────────
app.get("/admin/audit", adminAuth, (req, res) => {
  res.json({ logs: db.prepare("SELECT * FROM audit_log ORDER BY created_at DESC LIMIT 500").all() });
});

// ── Vendor wallet + settlements ───────────────────────────────────────────
app.get("/vendor/wallet", vendorAuth, (req, res) => {
  const txs     = db.prepare("SELECT * FROM wallet_tx WHERE vendor_name=? ORDER BY created_at DESC").all(req.vendor);
  const balance = txs.reduce((s, t) => t.type === "credit" ? s + t.amount : s - t.amount, 0);
  res.json({ balance: parseFloat(balance.toFixed(2)), transactions: txs });
});

app.get("/vendor/settlements", vendorAuth, (req, res) => {
  res.json({ settlements: db.prepare("SELECT * FROM settlements WHERE vendor_name=? ORDER BY created_at DESC").all(req.vendor) });
});

app.get("/vendor/settlements/:id", vendorAuth, (req, res) => {
  const s = db.prepare("SELECT * FROM settlements WHERE id=? AND vendor_name=?").get(req.params.id, req.vendor);
  if (!s) return res.status(404).json({ error: "Not found." });
  res.json({ settlement: s, orders: db.prepare("SELECT * FROM settlement_orders WHERE settlement_id=?").all(req.params.id) });
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
