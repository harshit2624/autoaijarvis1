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

// ── Profile tables ────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS croscrow_profile (
    id           INTEGER PRIMARY KEY DEFAULT 1,
    company_name TEXT DEFAULT 'CrosCrow Marketplace',
    email        TEXT DEFAULT '',
    phone        TEXT DEFAULT '',
    address      TEXT DEFAULT '',
    city         TEXT DEFAULT '',
    state        TEXT DEFAULT '',
    pincode      TEXT DEFAULT '',
    gst_no       TEXT DEFAULT '',
    pan_no       TEXT DEFAULT '',
    bank_name    TEXT DEFAULT '',
    account_no   TEXT DEFAULT '',
    ifsc         TEXT DEFAULT '',
    website      TEXT DEFAULT ''
  );
  INSERT OR IGNORE INTO croscrow_profile (id) VALUES (1);

  CREATE TABLE IF NOT EXISTS vendor_profiles (
    vendor_name  TEXT PRIMARY KEY,
    email        TEXT DEFAULT '',
    phone        TEXT DEFAULT '',
    address      TEXT DEFAULT '',
    city         TEXT DEFAULT '',
    state        TEXT DEFAULT '',
    pincode      TEXT DEFAULT '',
    gst_no       TEXT DEFAULT '',
    pan_no       TEXT DEFAULT '',
    bank_name    TEXT DEFAULT '',
    account_no   TEXT DEFAULT '',
    ifsc         TEXT DEFAULT '',
    commission_pct REAL,
    updated_at   TEXT DEFAULT ''
  );
`);

// ── Migrate: add editable columns to settlements (safe to run on existing DB)
["extra_discount REAL DEFAULT 0","shipping_adjustment REAL DEFAULT 0","extra_advance REAL DEFAULT 0","invoice_notes TEXT DEFAULT ''","custom_commission_pct REAL"].forEach(col => {
  try { db.exec(`ALTER TABLE settlements ADD COLUMN ${col}`); } catch {}
});
// ── Migrate: add shipping_charge to settlement_orders
try { db.exec("ALTER TABLE settlement_orders ADD COLUMN shipping_charge REAL DEFAULT 0"); } catch {}
// ── Migrate: add total_shipping to settlements
try { db.exec("ALTER TABLE settlements ADD COLUMN total_shipping REAL DEFAULT 0"); } catch {}
// ── Migrate: delivery_status tracking
try { db.exec("ALTER TABLE order_meta ADD COLUMN delivery_status TEXT DEFAULT ''"); } catch {}
try { db.exec("ALTER TABLE order_meta ADD COLUMN delivery_status_updated_at TEXT DEFAULT ''"); } catch {}

// ── Tag mappings table ────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS tag_mappings (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    shopify_tag TEXT NOT NULL,
    stage       TEXT NOT NULL,
    created_at  TEXT DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS vendor_shipping_partners (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    vendor_name  TEXT NOT NULL,
    partner      TEXT NOT NULL,
    credentials  TEXT NOT NULL,
    active       INTEGER DEFAULT 1,
    connected_at TEXT DEFAULT '',
    UNIQUE(vendor_name, partner)
  );
  CREATE TABLE IF NOT EXISTS global_shipping_creds (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    partner      TEXT NOT NULL UNIQUE,
    credentials  TEXT NOT NULL,
    connected_at TEXT DEFAULT ''
  );
`);

// Derive payment_type from Shopify financial_status
function paymentTypeFromFinancial(financialStatus) {
  if (financialStatus === "paid")            return "prepaid";
  if (financialStatus === "partially_paid")  return "partial";
  return "cod"; // pending, voided, refunded, etc.
}

// Apply tag mappings + auto-detect payment_type for one order
function applyTagMappings(orderId, tags, financialStatus) {
  const now = new Date().toISOString();
  const payType = paymentTypeFromFinancial(financialStatus || "pending");
  const sid = String(orderId);

  // Step 1: set payment_type from Shopify financial_status
  db.prepare(`INSERT INTO order_meta (shopify_id, payment_type) VALUES (?, ?)
    ON CONFLICT(shopify_id) DO UPDATE SET payment_type=excluded.payment_type, updated_at=?`)
    .run(sid, payType, now);

  if (!tags) return;
  const orderTags = tags.split(",").map(t => t.trim());

  // Step 2: scan ALL tags for partial advance pattern — independent of mappings
  // e.g. "99 partial", "150 partial collected", "500 Partial" → advance_paid
  for (const tag of orderTags) {
    const advMatch = tag.match(/^(\d+(?:\.\d+)?)\s+partial/i);
    if (advMatch) {
      const advancePaid = parseFloat(advMatch[1]);
      db.prepare(`INSERT INTO order_meta (shopify_id, advance_paid, payment_type) VALUES (?,?,?)
        ON CONFLICT(shopify_id) DO UPDATE SET advance_paid=excluded.advance_paid, payment_type='cod', updated_at=?`)
        .run(sid, advancePaid, "cod", now);
      break;
    }
  }

  // Step 3: apply stage from tag_mappings (first match wins)
  const mappings = db.prepare("SELECT * FROM tag_mappings").all();
  for (const m of mappings) {
    const hit = orderTags.find(t => t.toLowerCase() === m.shopify_tag.toLowerCase().trim());
    if (hit) {
      db.prepare(`INSERT INTO order_meta (shopify_id, stage) VALUES (?,?)
        ON CONFLICT(shopify_id) DO UPDATE SET stage=excluded.stage, updated_at=?`)
        .run(sid, m.stage, now);
      break;
    }
  }
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

// ── JARVIS store snapshot builder ─────────────────────────────────────────
// ── JARVIS tool definitions — AI calls these to fetch any data it needs ──────
const JARVIS_TOOLS = [
  {
    type: "function",
    function: {
      name: "get_order_stats",
      description: "Get order counts and revenue for any time period. Use for: totals, today, this week, this month, any date range, COD vs prepaid split, fulfillment stats.",
      parameters: {
        type: "object",
        properties: {
          period: { type: "string", enum: ["today","week","month","all","custom"], description: "Time period" },
          from: { type: "string", description: "ISO date string for custom period start (e.g. 2024-01-01)" },
          to:   { type: "string", description: "ISO date string for custom period end" },
        },
        required: ["period"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_customers",
      description: "Get customer data. Use for: repeat customers, top spenders, new vs returning, city/location breakdown.",
      parameters: {
        type: "object",
        properties: {
          type: { type: "string", enum: ["repeat","top_spenders","all","city_breakdown"], description: "What customer data to fetch" },
          limit: { type: "number", description: "Max results to return (default 20)" },
        },
        required: ["type"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_products",
      description: "Get product performance data. Use for: top selling products, slow movers, units sold, revenue by product.",
      parameters: {
        type: "object",
        properties: {
          sort_by: { type: "string", enum: ["units","revenue"], description: "Sort by units sold or revenue" },
          limit: { type: "number", description: "Max results (default 10)" },
          period: { type: "string", enum: ["today","week","month","all"], description: "Time period (default all)" },
        },
        required: ["sort_by"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_vendor_stats",
      description: "Get vendor performance: revenue, order counts, RTO rates per vendor. Use for vendor comparisons or specific vendor questions.",
      parameters: {
        type: "object",
        properties: {
          vendor: { type: "string", description: "Specific vendor name, or omit for all vendors" },
          include_rto: { type: "boolean", description: "Include RTO rate breakdown (default true)" },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_settlements",
      description: "Get settlement data: pending, paid, amounts owed to vendors.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "get_delivery_stats",
      description: "Get delivery/shipping status breakdown: in-transit, delivered, RTO, pending dispatch. Use for logistics questions.",
      parameters: {
        type: "object",
        properties: {
          period: { type: "string", enum: ["today","week","month","all"], description: "Time period (default all)" },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_orders_list",
      description: "Get a list of actual orders with details. Use for: pending orders, COD orders, specific order lookups, RTO orders, orders by vendor.",
      parameters: {
        type: "object",
        properties: {
          status:   { type: "string", enum: ["pending","fulfilled","cancelled","any"], description: "Fulfillment status filter" },
          payment:  { type: "string", enum: ["cod","prepaid","any"], description: "Payment type filter" },
          stage:    { type: "string", description: "Internal stage from order_meta: rto, advance_paid, etc." },
          vendor:   { type: "string", description: "Filter by vendor name" },
          period:   { type: "string", enum: ["today","week","month","all"], description: "Time period" },
          limit:    { type: "number", description: "Max orders to return (default 15)" },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_city_stats",
      description: "Get order breakdown by city or state. Use for geographic analysis, where orders come from, top delivery locations.",
      parameters: {
        type: "object",
        properties: {
          period: { type: "string", enum: ["today","week","month","all"], description: "Time period (default all)" },
          limit:  { type: "number", description: "Top N cities (default 10)" },
        },
        required: [],
      },
    },
  },
];

// ── JARVIS tool executor — runs whichever tool the AI asked for ───────────────
async function runJarvisTool(name, args) {
  const allOrders = await fetchAllOrders("any", "2020-01-01T00:00:00Z");
  const metas     = Object.fromEntries(db.prepare("SELECT * FROM order_meta").all().map(m=>[m.shopify_id,m]));

  const now      = new Date();
  const today    = new Date(now); today.setHours(0,0,0,0);
  const weekAgo  = new Date(today); weekAgo.setDate(today.getDate()-7);
  const monthAgo = new Date(today); monthAgo.setDate(today.getDate()-30);

  function filterByPeriod(orders, period, from, to) {
    if (period === "today")  return orders.filter(o=>new Date(o.created_at)>=today);
    if (period === "week")   return orders.filter(o=>new Date(o.created_at)>=weekAgo);
    if (period === "month")  return orders.filter(o=>new Date(o.created_at)>=monthAgo);
    if (period === "custom" && from) {
      const f=new Date(from), t=to?new Date(to):now;
      return orders.filter(o=>{const d=new Date(o.created_at);return d>=f&&d<=t;});
    }
    return orders;
  }

  const rev = os => Math.round(os.reduce((s,o)=>s+parseFloat(o.total_price||0),0));
  const isCOD  = o => o.financial_status !== "paid";
  const isRTO  = o => metas[String(o.id)]?.stage==="rto" || o.tags?.includes("RTO");

  if (name === "get_order_stats") {
    const os = filterByPeriod(allOrders, args.period, args.from, args.to);
    return {
      period: args.period,
      total: os.length,
      revenue: rev(os),
      avgOrderValue: Math.round(os.length ? rev(os)/os.length : 0),
      fulfilled: os.filter(o=>o.fulfillment_status==="fulfilled").length,
      pending: os.filter(o=>!o.fulfillment_status||o.fulfillment_status==="unfulfilled").length,
      cancelled: os.filter(o=>o.fulfillment_status==="cancelled").length,
      cod: os.filter(isCOD).length,
      prepaid: os.filter(o=>!isCOD(o)).length,
      rto: os.filter(isRTO).length,
    };
  }

  if (name === "get_customers") {
    const lim = args.limit || 20;
    const map = {};
    allOrders.forEach(o=>{
      const email = o.email || o.customer?.email;
      const name  = o.billing_address?.name || `${o.customer?.first_name||""} ${o.customer?.last_name||""}`.trim() || email || "Unknown";
      const city  = o.shipping_address?.city || "Unknown";
      if (!email) return;
      if (!map[email]) map[email] = { email, name, city, orders:0, revenue:0, lastOrder: o.created_at };
      map[email].orders++;
      map[email].revenue += parseFloat(o.total_price||0);
      if (new Date(o.created_at) > new Date(map[email].lastOrder)) map[email].lastOrder = o.created_at;
    });
    const all = Object.values(map).map(c=>({...c, revenue:Math.round(c.revenue)}));

    if (args.type === "repeat")       return { repeatCustomers: all.filter(c=>c.orders>1).sort((a,b)=>b.orders-a.orders).slice(0,lim), totalRepeat: all.filter(c=>c.orders>1).length };
    if (args.type === "top_spenders") return { topSpenders: all.sort((a,b)=>b.revenue-a.revenue).slice(0,lim) };
    if (args.type === "city_breakdown") {
      const cities = {};
      all.forEach(c=>{ cities[c.city]=(cities[c.city]||0)+1; });
      return { topCities: Object.entries(cities).sort((a,b)=>b[1]-a[1]).slice(0,lim).map(([city,count])=>({city,customers:count})) };
    }
    return { total: all.length, returning: all.filter(c=>c.orders>1).length, new: all.filter(c=>c.orders===1).length };
  }

  if (name === "get_products") {
    const os = filterByPeriod(allOrders, args.period||"all");
    const lim = args.limit || 10;
    const tally = {};
    os.forEach(o=>(o.line_items||[]).forEach(li=>{
      if(!tally[li.title]) tally[li.title]={name:li.title, vendor:li.vendor, units:0, revenue:0};
      tally[li.title].units   += li.quantity||1;
      tally[li.title].revenue += parseFloat(li.price||0)*(li.quantity||1);
    }));
    const sorted = Object.values(tally)
      .map(p=>({...p,revenue:Math.round(p.revenue)}))
      .sort((a,b)=> args.sort_by==="revenue" ? b.revenue-a.revenue : b.units-a.units)
      .slice(0,lim);
    return { period: args.period||"all", products: sorted };
  }

  if (name === "get_vendor_stats") {
    const vendRev={}, vendOrders={}, vendRTOc={}, vendTotal={};
    allOrders.forEach(o=>{
      const rto = isRTO(o);
      (o.line_items||[]).forEach(li=>{
        if(!li.vendor)return;
        if(args.vendor && li.vendor.toLowerCase()!==args.vendor.toLowerCase())return;
        vendRev[li.vendor]   = (vendRev[li.vendor]||0)+parseFloat(li.price||0)*(li.quantity||1);
        vendOrders[li.vendor]= (vendOrders[li.vendor]||0)+1;
        vendTotal[li.vendor] = (vendTotal[li.vendor]||0)+1;
        if(rto) vendRTOc[li.vendor]=(vendRTOc[li.vendor]||0)+1;
      });
    });
    return Object.keys(vendRev).map(v=>({
      vendor: v,
      revenue: Math.round(vendRev[v]),
      orders: vendOrders[v],
      rto: vendRTOc[v]||0,
      rtoRate: `${Math.round(((vendRTOc[v]||0)/vendTotal[v])*100)}%`,
    })).sort((a,b)=>b.revenue-a.revenue);
  }

  if (name === "get_settlements") {
    return db.prepare("SELECT status, COUNT(*) as count, ROUND(SUM(net_payable),2) as total FROM settlements GROUP BY status").all();
  }

  if (name === "get_delivery_stats") {
    const os = filterByPeriod(allOrders, args.period||"all");
    const statuses = {};
    os.forEach(o=>{
      const ds = metas[String(o.id)]?.delivery_status || o.fulfillment_status || "pending";
      statuses[ds]=(statuses[ds]||0)+1;
    });
    return { period: args.period||"all", breakdown: statuses, total: os.length };
  }

  if (name === "get_orders_list") {
    let os = filterByPeriod(allOrders, args.period||"all");
    if (args.status && args.status!=="any") {
      if (args.status==="pending") os=os.filter(o=>!o.fulfillment_status||o.fulfillment_status==="unfulfilled");
      else os=os.filter(o=>o.fulfillment_status===args.status);
    }
    if (args.payment && args.payment!=="any") {
      if (args.payment==="cod") os=os.filter(isCOD);
      else os=os.filter(o=>!isCOD(o));
    }
    if (args.stage) os=os.filter(o=>metas[String(o.id)]?.stage===args.stage);
    if (args.vendor) os=os.filter(o=>(o.line_items||[]).some(li=>li.vendor?.toLowerCase()===args.vendor.toLowerCase()));
    return os.slice(0,args.limit||15).map(o=>({
      id: o.id,
      name: o.name,
      customer: o.billing_address?.name || o.email,
      city: o.shipping_address?.city,
      total: parseFloat(o.total_price||0),
      payment: isCOD(o)?"COD":"Prepaid",
      status: o.fulfillment_status||"unfulfilled",
      stage: metas[String(o.id)]?.stage||null,
      date: o.created_at?.slice(0,10),
      vendors: [...new Set((o.line_items||[]).map(li=>li.vendor).filter(Boolean))],
    }));
  }

  if (name === "get_city_stats") {
    const os = filterByPeriod(allOrders, args.period||"all");
    const lim = args.limit || 10;
    const cities = {}, states = {};
    os.forEach(o=>{
      const city  = o.shipping_address?.city||"Unknown";
      const state = o.shipping_address?.province||"Unknown";
      cities[city]  = (cities[city]||0)+1;
      states[state] = (states[state]||0)+1;
    });
    return {
      topCities: Object.entries(cities).sort((a,b)=>b[1]-a[1]).slice(0,lim).map(([city,orders])=>({city,orders})),
      topStates: Object.entries(states).sort((a,b)=>b[1]-a[1]).slice(0,5).map(([state,orders])=>({state,orders})),
    };
  }

  return { error: "Unknown tool" };
}

// ── POST /jarvis — tool-calling AI, fetches only what it needs ───────────────
app.post("/jarvis", async (req, res) => {
  const { query = "", history = [] } = req.body;
  const GROQ_KEY      = process.env.GROQ_API_KEY;
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

  if (!GROQ_KEY && !ANTHROPIC_KEY) {
    return res.json({ reply: "No AI key set. Add GROQ_API_KEY (free at console.groq.com) to your .env." });
  }

  const systemPrompt = `You are JARVIS, a razor-sharp e-commerce operations assistant for CrosCrow — a multi-vendor Shopify store.
You have tools to fetch any live store data. Always call the right tool(s) to get real data before answering.

Rules:
- ALWAYS use tools to fetch data. Never guess or make up numbers.
- Be concise — bullet points preferred. Max 8 lines unless a detailed breakdown is asked.
- Currency is INR (₹). Format large numbers with commas.
- Spot patterns, anomalies, and risks proactively when relevant.
- If data is zero or missing, say so clearly.
- Today's date: ${new Date().toLocaleDateString('en-IN', {weekday:'long', year:'numeric', month:'long', day:'numeric'})}`;

  const msgs = [
    ...history.filter(m=>m.role&&m.text).map(m=>({
      role: m.role==="bot"?"assistant":"user",
      content: m.text,
    })),
    { role:"user", content: query },
  ];

  try {
    if (GROQ_KEY) {
      // ── Groq tool-calling loop ──────────────────────────────────────────
      const messages = [{ role:"system", content: systemPrompt }, ...msgs];
      let finalReply = "";

      for (let turn = 0; turn < 5; turn++) {
        const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type":"application/json", "Authorization":`Bearer ${GROQ_KEY}` },
          body: JSON.stringify({
            model: "llama-3.3-70b-versatile",
            max_tokens: 1000,
            messages,
            tools: JARVIS_TOOLS,
            tool_choice: "auto",
          }),
        });
        const d = await r.json();
        if (!r.ok) throw new Error(d.error?.message || `Groq ${r.status}`);

        const choice = d.choices?.[0];
        const msg    = choice?.message;

        if (choice?.finish_reason === "tool_calls" && msg?.tool_calls?.length) {
          // AI wants data — execute all requested tools in parallel
          messages.push(msg);
          const toolResults = await Promise.all(msg.tool_calls.map(async tc => {
            let args = {};
            try { args = JSON.parse(tc.function.arguments || "{}"); } catch(_){}
            console.log(`🔧 JARVIS tool: ${tc.function.name}`, args);
            const result = await runJarvisTool(tc.function.name, args);
            return { role:"tool", tool_call_id: tc.id, content: JSON.stringify(result) };
          }));
          messages.push(...toolResults);
          continue; // let AI respond with the data
        }

        finalReply = msg?.content || "No response.";
        break;
      }

      return res.json({ reply: finalReply || "No response after tool calls." });
    }

    // ── Anthropic fallback ─────────────────────────────────────────────────
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type":"application/json", "x-api-key":ANTHROPIC_KEY, "anthropic-version":"2023-06-01" },
      body: JSON.stringify({ model:"claude-haiku-4-5-20251001", max_tokens:700, system:systemPrompt, messages:msgs }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error?.message || `Anthropic ${r.status}`);
    return res.json({ reply: d.content?.[0]?.text || "No response." });

  } catch (aiErr) {
    console.error("❌ /jarvis AI:", aiErr.message);
    return res.status(500).json({ error: aiErr.message });
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
  let all = [];
  let { data, link } = await shopifyRESTRaw(`/products.json?limit=250&fields=vendor`);
  all.push(...(data.products || []));

  while (link) {
    const match = link.match(/<([^>]+)>;\s*rel="next"/);
    if (!match) break;
    const pageInfo = new URL(match[1]).searchParams.get("page_info");
    if (!pageInfo) break;
    ({ data, link } = await shopifyRESTRaw(`/products.json?limit=250&fields=vendor&page_info=${pageInfo}`));
    all.push(...(data.products || []));
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

    const metas   = db.prepare("SELECT * FROM order_meta").all();
    const metaMap = Object.fromEntries(metas.map(m => [m.shopify_id, m]));

    const orders = allOrders
      .filter(o => (o.line_items || []).some(li => (li.vendor || "").toLowerCase() === vName))
      .map(o => {
        const myItems = (o.line_items || []).filter(li => (li.vendor || "").toLowerCase() === vName);
        const myRevenue = myItems.reduce((s, li) => s + parseFloat(li.price || 0) * (li.quantity || 1), 0);
        const meta = metaMap[String(o.id)] || {};
        const payType = meta.payment_type || (o.financial_status === "paid" ? "prepaid" : "cod");
        // Shipping + advance split equally by vendor count — COD only
        const ordVendors = new Set((o.line_items || []).map(li => li.vendor).filter(Boolean));
        const vendorCount = ordVendors.size || 1;
        const orderShipping = (o.shipping_lines || []).reduce((s, l) => s + parseFloat(l.price || 0), 0);
        const shippingCharge = payType !== "prepaid"
          ? parseFloat((orderShipping / vendorCount).toFixed(2)) : 0;
        const advancePaid = parseFloat(((meta.advance_paid || 0) / vendorCount).toFixed(2));
        return {
          id:           o.name,
          shopifyId:    String(o.id),
          customer:     o.customer ? `${o.customer.first_name ?? ""} ${o.customer.last_name ?? ""}`.trim() : "Guest",
          email:        o.email        ?? "",
          phone:        o.shipping_address?.phone ?? o.customer?.phone ?? "",
          date:         (o.created_at ?? "").split("T")[0],
          status:       mapStatus(o.fulfillment_status),
          stage:        meta.stage || "new",
          financial:    o.financial_status ?? "—",
          tags:         o.tags ?? "",
          currency:     o.currency ?? "INR",
          myRevenue:    parseFloat(myRevenue.toFixed(2)),
          shippingCharge,
          advancePaid,
          totalCollectable: parseFloat((myRevenue + shippingCharge).toFixed(2)),
          remainingCOD:     parseFloat(Math.max(0, myRevenue + shippingCharge - advancePaid).toFixed(2)),
          awb:          meta.awb     || (o.fulfillments||[]).find(f=>f.tracking_number)?.tracking_number || "",
          courier:      meta.courier || (o.fulfillments||[]).find(f=>f.tracking_company)?.tracking_company || "",
          trackingUrl:  meta.tracking_url || (o.fulfillments||[]).find(f=>f.tracking_url)?.tracking_url || "",
          deliveryStatus: meta.delivery_status || (o.fulfillments||[]).find(f=>f.shipment_status)?.shipment_status || "",
          shopifyFulfilled: !meta.awb && (o.fulfillments||[]).length > 0,
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
        awb:            meta.awb || (o.fulfillments||[]).find(f=>f.tracking_number)?.tracking_number || "",
        courier:        meta.courier || (o.fulfillments||[]).find(f=>f.tracking_company)?.tracking_company || "",
        trackingUrl:    meta.tracking_url || (o.fulfillments||[]).find(f=>f.tracking_url)?.tracking_url || "",
        deliveryStatus: meta.delivery_status || (o.fulfillments||[]).find(f=>f.shipment_status)?.shipment_status || "",
        shopifyFulfilled: !meta.awb && (o.fulfillments||[]).length > 0,
        tags:           o.tags || "",
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
    // Commission priority: vendor_profiles → vendor_config → default 20%
    const vProfile = db.prepare("SELECT commission_pct FROM vendor_profiles WHERE vendor_name=?").get(vendor_name);
    const vConfig  = db.prepare("SELECT commission_pct FROM vendor_config WHERE vendor_name=?").get(vendor_name);
    const config   = { commission_pct: vProfile?.commission_pct ?? vConfig?.commission_pct ?? 20 };
    const metas  = db.prepare("SELECT * FROM order_meta").all();
    const metaMap = Object.fromEntries(metas.map(m => [m.shopify_id, m]));

    // Only settle delivered orders
    const vendorDelivered = allOrders.filter(o => {
      const meta = metaMap[String(o.id)];
      return (meta?.stage || "new") === "delivered" &&
        (o.line_items || []).some(li => (li.vendor || "").toLowerCase() === vName);
    });

    let totalRev = 0, totalComm = 0, totalGst = 0, totalAdv = 0, totalNet = 0, totalShipping = 0;
    const orderDetails = [];

    vendorDelivered.forEach(o => {
      const meta    = metaMap[String(o.id)] || {};
      const payType = meta.payment_type || "cod";
      const isCod   = payType !== "prepaid";
      const myItems = (o.line_items || []).filter(li => (li.vendor || "").toLowerCase() === vName);
      const myRev   = myItems.reduce((s, li) => s + parseFloat(li.price || 0) * (li.quantity || 1), 0);
      const calc    = calcCommission(myRev, payType, config.commission_pct, meta.advance_paid || 0);

      // Shipping: read from Shopify shipping_lines, split by unique vendor count in order
      const ordVendors = new Set((o.line_items || []).map(li => li.vendor).filter(Boolean));
      const orderShipping = (o.shipping_lines || []).reduce((s, l) => s + parseFloat(l.price || 0), 0);
      const shippingSplit = isCod && ordVendors.size > 0 ? parseFloat((orderShipping / ordVendors.size).toFixed(2)) : 0;

      totalRev      += myRev;
      totalComm     += calc.commission;
      totalGst      += calc.gst;
      totalAdv      += (meta.advance_paid || 0);
      totalShipping += shippingSplit;
      totalNet      += calc.net + shippingSplit; // shipping vendor collected → owes CrosCrow (COD only)

      orderDetails.push({
        shopify_order_id: String(o.id),
        order_name:       o.name,
        my_revenue:       parseFloat(myRev.toFixed(2)),
        payment_type:     payType,
        commission_pct:   config.commission_pct,
        commission:       calc.commission,
        gst:              calc.gst,
        advance_paid:     meta.advance_paid || 0,
        shipping_charge:  shippingSplit,
        net:              parseFloat((calc.net + shippingSplit).toFixed(2)),
      });
    });

    // netPayable: positive = vendor pays CrosCrow, negative = CrosCrow pays vendor
    const netPayable = parseFloat(totalNet.toFixed(2));
    const invoiceNo  = `CC-${vendor_name.toUpperCase().replace(/\s+/g,"").slice(0,6)}-${period_start.slice(0,7).replace("-","")}-${String(Date.now()).slice(-4)}`;

    const { lastInsertRowid: settlId } = db.prepare(
      `INSERT INTO settlements (vendor_name,period_start,period_end,total_orders,gross_revenue,commission,gst_amount,advance_total,net_payable,total_shipping,status,invoice_no,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(vendor_name, period_start, period_end, vendorDelivered.length,
      parseFloat(totalRev.toFixed(2)), parseFloat(totalComm.toFixed(2)),
      parseFloat(totalGst.toFixed(2)), parseFloat(totalAdv.toFixed(2)),
      netPayable, parseFloat(totalShipping.toFixed(2)), "pending", invoiceNo, new Date().toISOString());

    const ins = db.prepare(
      `INSERT INTO settlement_orders (settlement_id,shopify_order_id,order_name,my_revenue,payment_type,commission_pct,commission,gst,advance_paid,shipping_charge,net)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    );
    orderDetails.forEach(od => ins.run(settlId, od.shopify_order_id, od.order_name, od.my_revenue,
      od.payment_type, od.commission_pct, od.commission, od.gst, od.advance_paid, od.shipping_charge, od.net));

    auditLog("admin", "settlement_generated", String(settlId), { vendor_name, period_start, period_end, netPayable });
    res.json({ success: true, settlementId: settlId, invoiceNo, totalOrders: vendorDelivered.length, netPayable });
  } catch (err) {
    console.error("❌ /admin/settlements/generate:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /admin/delivered-summary ─────────────────────────────────────────
app.get("/admin/delivered-summary", adminAuth, async (req, res) => {
  try {
    const allOrders = await fetchAllOrders("any", "2020-01-01T00:00:00Z");
    const metas = db.prepare("SELECT * FROM order_meta").all();
    const metaMap = Object.fromEntries(metas.map(m => [m.shopify_id, m]));
    const vProfiles = db.prepare("SELECT * FROM vendor_profiles").all();
    const vConfigs  = db.prepare("SELECT * FROM vendor_config").all();
    const vProfileMap = Object.fromEntries(vProfiles.map(v => [v.vendor_name, v]));
    const vConfigMap  = Object.fromEntries(vConfigs.map(v => [v.vendor_name, v]));

    // Aggregate settled amounts per vendor from paid invoices
    const paidSettlements = db.prepare("SELECT vendor_name, SUM(net_payable) as total_settled FROM settlements WHERE status='paid' GROUP BY vendor_name").all();
    const settledMap = Object.fromEntries(paidSettlements.map(s => [s.vendor_name, s.total_settled]));

    const vendorMap = {};

    allOrders.forEach(o => {
      const meta = metaMap[String(o.id)] || {};
      if ((meta.stage || "new") !== "delivered") return;
      const payType = meta.payment_type || "cod";
      const isCod = payType !== "prepaid";
      // Shipping from Shopify order, split equally by unique vendor count
      const orderShipping = (o.shipping_lines || []).reduce((s, l) => s + parseFloat(l.price || 0), 0);
      const ordVendorSet = new Set((o.line_items || []).map(li => li.vendor).filter(Boolean));
      const shippingPerVendor = ordVendorSet.size > 0 ? orderShipping / ordVendorSet.size : 0;

      (o.line_items || []).forEach(li => {
        const vendor = li.vendor;
        if (!vendor) return;
        if (!vendorMap[vendor]) vendorMap[vendor] = { orders: new Set(), gross: 0, prepaidDiscount: 0, commission: 0, gst: 0, advance: 0, shipping: 0, net: 0 };
        vendorMap[vendor].orders.add(String(o.id));
        const itemRev = parseFloat(li.price || 0) * (li.quantity || 1);
        const commPct = vProfileMap[vendor]?.commission_pct ?? vConfigMap[vendor]?.commission_pct ?? 20;
        const calc = calcCommission(itemRev, payType, commPct, 0);
        vendorMap[vendor].gross += itemRev;
        if (!isCod) vendorMap[vendor].prepaidDiscount += (itemRev - calc.base);
        vendorMap[vendor].commission += calc.commission;
        vendorMap[vendor].gst += calc.gst;
        vendorMap[vendor].net += calc.net;
      });

      // advance + shipping split equally among vendors in this order (COD only for shipping)
      ordVendorSet.forEach(vendor => {
        if (!vendorMap[vendor]) return;
        if ((meta.advance_paid || 0) > 0) vendorMap[vendor].advance += (meta.advance_paid || 0) / ordVendorSet.size;
        if (isCod && shippingPerVendor > 0) {
          vendorMap[vendor].shipping += shippingPerVendor;
          vendorMap[vendor].net += shippingPerVendor; // shipping vendor collected → owes to CrosCrow
        }
      });
    });

    const vendors = Object.entries(vendorMap).map(([name, d]) => {
      const commPct = vProfileMap[name]?.commission_pct ?? vConfigMap[name]?.commission_pct ?? 20;
      const gross = parseFloat(d.gross.toFixed(2));
      const prepaidDiscount = parseFloat(d.prepaidDiscount.toFixed(2));
      const commissionableSale = parseFloat((gross - prepaidDiscount).toFixed(2));
      const commission = parseFloat(d.commission.toFixed(2));
      const gst = parseFloat(d.gst.toFixed(2));
      const advance = parseFloat(d.advance.toFixed(2));
      const shipping = parseFloat(d.shipping.toFixed(2));
      const netPayable = parseFloat(d.net.toFixed(2));
      const totalSettled = parseFloat((settledMap[name] || 0).toFixed(2));
      const pendingSettlement = parseFloat((netPayable - totalSettled).toFixed(2));
      return { vendor: name, totalOrders: d.orders.size, gross, prepaidDiscount, commissionableSale, commissionPct: commPct, commission, gst, advance, shipping, netPayable, totalSettled, pendingSettlement };
    }).sort((a, b) => b.gross - a.gross);

    // Overall totals
    const totals = vendors.reduce((acc, v) => {
      acc.totalOrders += v.totalOrders;
      acc.gross += v.gross;
      acc.prepaidDiscount += v.prepaidDiscount;
      acc.commissionableSale += v.commissionableSale;
      acc.commission += v.commission;
      acc.gst += v.gst;
      acc.advance += v.advance;
      acc.shipping += v.shipping;
      acc.netPayable += v.netPayable;
      acc.totalSettled += v.totalSettled;
      acc.pendingSettlement += v.pendingSettlement;
      return acc;
    }, { totalOrders: 0, gross: 0, prepaidDiscount: 0, commissionableSale: 0, commission: 0, gst: 0, advance: 0, shipping: 0, netPayable: 0, totalSettled: 0, pendingSettlement: 0 });

    Object.keys(totals).forEach(k => { if (typeof totals[k] === 'number') totals[k] = parseFloat(totals[k].toFixed(2)); });

    res.json({ vendors, totals });
  } catch (err) {
    console.error("❌ /admin/delivered-summary:", err.message);
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
  const croscrow    = db.prepare("SELECT * FROM croscrow_profile WHERE id=1").get() || {};
  const vendorProfile = db.prepare("SELECT * FROM vendor_profiles WHERE vendor_name=?").get(settlement.vendor_name) || {};
  res.json({ settlement, orders, croscrow, vendorProfile });
});

// ── DELETE /admin/settlements/:id ────────────────────────────────────────
app.delete("/admin/settlements/:id", adminAuth, (req, res) => {
  const s = db.prepare("SELECT * FROM settlements WHERE id=?").get(req.params.id);
  if (!s) return res.status(404).json({ error: "Not found." });
  db.prepare("DELETE FROM settlement_orders WHERE settlement_id=?").run(req.params.id);
  db.prepare("DELETE FROM wallet_tx WHERE ref_id=?").run(String(s.id));
  db.prepare("DELETE FROM settlements WHERE id=?").run(req.params.id);
  auditLog("admin", "settlement_deleted", req.params.id, { vendor: s.vendor_name, invoice: s.invoice_no });
  res.json({ success: true });
});

// ── PUT /admin/settlements/:id/edit ───────────────────────────────────────
app.put("/admin/settlements/:id/edit", adminAuth, (req, res) => {
  const s = db.prepare("SELECT * FROM settlements WHERE id=?").get(req.params.id);
  if (!s) return res.status(404).json({ error: "Not found." });

  const {
    custom_commission_pct,
    extra_discount     = 0,
    shipping_adjustment = 0,
    extra_advance      = 0,
    invoice_notes      = "",
  } = req.body || {};

  const orders = db.prepare("SELECT * FROM settlement_orders WHERE settlement_id=?").all(req.params.id);

  // Recalculate per-order commission if % changed
  let newCommission = s.commission, newGst = s.gst_amount;
  if (custom_commission_pct != null && parseFloat(custom_commission_pct) !== (s.custom_commission_pct || 0)) {
    newCommission = 0; newGst = 0;
    const updOrd = db.prepare("UPDATE settlement_orders SET commission_pct=?,commission=?,gst=?,net=? WHERE id=?");
    orders.forEach(o => {
      const calc = calcCommission(o.my_revenue, o.payment_type, parseFloat(custom_commission_pct), o.advance_paid);
      newCommission += calc.commission;
      newGst        += calc.gst;
      updOrd.run(parseFloat(custom_commission_pct), calc.commission, calc.gst, calc.net, o.id);
    });
    newCommission = parseFloat(newCommission.toFixed(2));
    newGst        = parseFloat(newGst.toFixed(2));
  }

  // Sum base net from (possibly updated) orders
  const updatedOrders = db.prepare("SELECT * FROM settlement_orders WHERE settlement_id=?").all(req.params.id);
  const baseNet = updatedOrders.reduce((sum, o) => sum + (o.net || 0), 0);

  // Apply adjustments: discount & extra advance reduce what vendor owes; shipping_adjustment adds to it
  const adjustedNet = parseFloat((
    baseNet
    - parseFloat(extra_discount || 0)
    - parseFloat(extra_advance  || 0)
    + parseFloat(shipping_adjustment || 0)
  ).toFixed(2));

  db.prepare(`UPDATE settlements SET
    commission=?, gst_amount=?,
    extra_discount=?, shipping_adjustment=?, extra_advance=?,
    invoice_notes=?, custom_commission_pct=?, net_payable=?
    WHERE id=?`)
    .run(newCommission, newGst,
      parseFloat(extra_discount||0), parseFloat(shipping_adjustment||0), parseFloat(extra_advance||0),
      invoice_notes || "", custom_commission_pct != null ? parseFloat(custom_commission_pct) : null,
      adjustedNet, req.params.id);

  auditLog("admin", "settlement_edited", req.params.id, req.body);
  res.json({ success: true, netPayable: adjustedNet, commission: newCommission, gst: newGst });
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

// ── Tag Mapping endpoints ─────────────────────────────────────────────────
app.get("/admin/order-tags", adminAuth, async (req, res) => {
  try {
    const allOrders = await fetchAllOrders("any", "2020-01-01T00:00:00Z");
    const tagSet = new Set();
    allOrders.forEach(o => {
      if (o.tags) o.tags.split(",").map(t => t.trim()).filter(Boolean).forEach(t => tagSet.add(t));
    });
    res.json({ tags: [...tagSet].sort((a,b)=>a.toLowerCase().localeCompare(b.toLowerCase())) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get("/admin/tag-mappings", adminAuth, (req, res) => {
  res.json({ mappings: db.prepare("SELECT * FROM tag_mappings ORDER BY id").all() });
});

app.post("/admin/tag-mappings", adminAuth, (req, res) => {
  const { shopify_tag, stage } = req.body || {};
  if (!shopify_tag || !stage) return res.status(400).json({ error: "shopify_tag and stage required." });
  const existing = db.prepare("SELECT id FROM tag_mappings WHERE lower(shopify_tag)=lower(?)").get(shopify_tag);
  if (existing) return res.status(400).json({ error: "A mapping for this tag already exists." });
  const { lastInsertRowid } = db.prepare("INSERT INTO tag_mappings (shopify_tag, stage, created_at) VALUES (?,?,?)")
    .run(shopify_tag.trim(), stage, new Date().toISOString());
  res.json({ success: true, id: lastInsertRowid });
});

app.delete("/admin/tag-mappings/:id", adminAuth, (req, res) => {
  db.prepare("DELETE FROM tag_mappings WHERE id=?").run(req.params.id);
  res.json({ success: true });
});

// Sync: scan ALL orders — set payment_type from financial_status + apply tag mappings
app.post("/admin/tag-mappings/sync", adminAuth, async (req, res) => {
  try {
    const allOrders = await fetchAllOrders("any", "2020-01-01T00:00:00Z");
    let updated = 0;
    const before = db.prepare("SELECT shopify_id, stage, payment_type, advance_paid FROM order_meta").all();
    const beforeMap = Object.fromEntries(before.map(r => [r.shopify_id, r]));

    for (const o of allOrders) {
      const prev = beforeMap[String(o.id)];
      applyTagMappings(o.id, o.tags, o.financial_status);
      const after = db.prepare("SELECT stage, payment_type, advance_paid FROM order_meta WHERE shopify_id=?").get(String(o.id));
      if (!prev || prev.stage !== after?.stage || prev.payment_type !== after?.payment_type || prev.advance_paid !== after?.advance_paid) {
        updated++;
      }
    }
    res.json({ success: true, updated, total: allOrders.length });
  } catch (err) {
    console.error("❌ tag-mappings/sync:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET/PUT /admin/croscrow-profile ──────────────────────────────────────
app.get("/admin/croscrow-profile", adminAuth, (req, res) => {
  res.json(db.prepare("SELECT * FROM croscrow_profile WHERE id=1").get() || {});
});
app.put("/admin/croscrow-profile", adminAuth, (req, res) => {
  const f = req.body || {};
  db.prepare(`UPDATE croscrow_profile SET company_name=?,email=?,phone=?,address=?,city=?,state=?,pincode=?,gst_no=?,pan_no=?,bank_name=?,account_no=?,ifsc=?,website=? WHERE id=1`)
    .run(f.company_name||'CrosCrow Marketplace',f.email||'',f.phone||'',f.address||'',f.city||'',f.state||'',f.pincode||'',f.gst_no||'',f.pan_no||'',f.bank_name||'',f.account_no||'',f.ifsc||'',f.website||'');
  auditLog("admin","profile_update","croscrow",{});
  res.json({ success:true });
});

// ── GET/PUT /admin/vendors/:name/profile ──────────────────────────────────
app.get("/admin/vendors/:name/profile", adminAuth, (req, res) => {
  const name = decodeURIComponent(req.params.name);
  const p = db.prepare("SELECT * FROM vendor_profiles WHERE vendor_name=?").get(name) || { vendor_name: name };
  const cfg = db.prepare("SELECT commission_pct FROM vendor_config WHERE vendor_name=?").get(name);
  if (!p.commission_pct && cfg) p.commission_pct = cfg.commission_pct;
  res.json(p);
});
app.put("/admin/vendors/:name/profile", adminAuth, (req, res) => {
  const name = decodeURIComponent(req.params.name);
  const f = req.body || {};
  db.prepare(`INSERT INTO vendor_profiles (vendor_name,email,phone,address,city,state,pincode,gst_no,pan_no,bank_name,account_no,ifsc,commission_pct,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(vendor_name) DO UPDATE SET email=excluded.email,phone=excluded.phone,address=excluded.address,city=excluded.city,state=excluded.state,pincode=excluded.pincode,gst_no=excluded.gst_no,pan_no=excluded.pan_no,bank_name=excluded.bank_name,account_no=excluded.account_no,ifsc=excluded.ifsc,commission_pct=excluded.commission_pct,updated_at=excluded.updated_at`)
    .run(name,f.email||'',f.phone||'',f.address||'',f.city||'',f.state||'',f.pincode||'',f.gst_no||'',f.pan_no||'',f.bank_name||'',f.account_no||'',f.ifsc||'',f.commission_pct!=null?parseFloat(f.commission_pct):null,new Date().toISOString());
  // sync to vendor_config too
  if (f.commission_pct != null) {
    db.prepare(`INSERT INTO vendor_config (vendor_name,commission_pct) VALUES (?,?) ON CONFLICT(vendor_name) DO UPDATE SET commission_pct=excluded.commission_pct`)
      .run(name, parseFloat(f.commission_pct));
  }
  auditLog("admin","vendor_profile_update",name,{ commission_pct: f.commission_pct });
  res.json({ success:true });
});

// ── GET/PUT /admin/audit ──────────────────────────────────────────────────
app.get("/admin/audit", adminAuth, (req, res) => {
  res.json({ logs: db.prepare("SELECT * FROM audit_log ORDER BY created_at DESC LIMIT 500").all() });
});

// ── GET /admin/audit ──────────────────────────────────────────────────────
app.get("/admin/audit", adminAuth, (req, res) => {
  res.json({ logs: db.prepare("SELECT * FROM audit_log ORDER BY created_at DESC LIMIT 500").all() });
});

// ── Vendor wallet + settlements ───────────────────────────────────────────
// ── GET/PUT /vendor/profile ───────────────────────────────────────────────
app.get("/vendor/profile", vendorAuth, (req, res) => {
  const p = db.prepare("SELECT * FROM vendor_profiles WHERE vendor_name=?").get(req.vendor) || { vendor_name: req.vendor };
  const cfg = db.prepare("SELECT commission_pct FROM vendor_config WHERE vendor_name=?").get(req.vendor);
  if (!p.commission_pct && cfg) p.commission_pct = cfg.commission_pct;
  res.json(p);
});
app.put("/vendor/profile", vendorAuth, (req, res) => {
  const f = req.body || {};
  // Vendor cannot change commission_pct — strip it
  db.prepare(`INSERT INTO vendor_profiles (vendor_name,email,phone,address,city,state,pincode,gst_no,pan_no,bank_name,account_no,ifsc,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(vendor_name) DO UPDATE SET email=excluded.email,phone=excluded.phone,address=excluded.address,city=excluded.city,state=excluded.state,pincode=excluded.pincode,gst_no=excluded.gst_no,pan_no=excluded.pan_no,bank_name=excluded.bank_name,account_no=excluded.account_no,ifsc=excluded.ifsc,updated_at=excluded.updated_at`)
    .run(req.vendor,f.email||'',f.phone||'',f.address||'',f.city||'',f.state||'',f.pincode||'',f.gst_no||'',f.pan_no||'',f.bank_name||'',f.account_no||'',f.ifsc||'',new Date().toISOString());
  res.json({ success:true });
});

app.get("/vendor/wallet", vendorAuth, (req, res) => {
  const txs     = db.prepare("SELECT * FROM wallet_tx WHERE vendor_name=? ORDER BY created_at DESC").all(req.vendor);
  const balance = txs.reduce((s, t) => t.type === "credit" ? s + t.amount : s - t.amount, 0);
  res.json({ balance: parseFloat(balance.toFixed(2)), transactions: txs });
});

// ── GET /vendor/delivered-summary ────────────────────────────────────────
app.get("/vendor/delivered-summary", vendorAuth, async (req, res) => {
  try {
    const vName = req.vendor.toLowerCase();
    const allOrders = await fetchAllOrders("any", "2020-01-01T00:00:00Z");
    const metas = db.prepare("SELECT * FROM order_meta").all();
    const metaMap = Object.fromEntries(metas.map(m => [m.shopify_id, m]));
    const vProfile = db.prepare("SELECT * FROM vendor_profiles WHERE vendor_name=?").get(req.vendor);
    const vConfig  = db.prepare("SELECT * FROM vendor_config WHERE vendor_name=?").get(req.vendor);
    const commPct  = vProfile?.commission_pct ?? vConfig?.commission_pct ?? 20;

    const paidSettlements = db.prepare("SELECT SUM(net_payable) as total_settled FROM settlements WHERE vendor_name=? AND status='paid'").get(req.vendor);
    const totalSettled = paidSettlements?.total_settled || 0;

    let totalOrders = 0, gross = 0, prepaidDiscount = 0, commission = 0, gst = 0, advance = 0, shipping = 0, net = 0;

    allOrders.forEach(o => {
      const meta = metaMap[String(o.id)] || {};
      if ((meta.stage || "new") !== "delivered") return;
      const myItems = (o.line_items || []).filter(li => (li.vendor || "").toLowerCase() === vName);
      if (!myItems.length) return;
      totalOrders++;
      const payType = meta.payment_type || "cod";
      const isCod   = payType !== "prepaid";
      const ordVendors = new Set((o.line_items || []).map(li => li.vendor).filter(Boolean));
      const orderShipping = (o.shipping_lines || []).reduce((s, l) => s + parseFloat(l.price || 0), 0);
      const shippingSplit = isCod && ordVendors.size > 0 ? orderShipping / ordVendors.size : 0;

      myItems.forEach(li => {
        const itemRev = parseFloat(li.price || 0) * (li.quantity || 1);
        const calc = calcCommission(itemRev, payType, commPct, 0);
        gross += itemRev;
        if (!isCod) prepaidDiscount += (itemRev - calc.base);
        commission += calc.commission;
        gst += calc.gst;
        net += calc.net;
      });
      if ((meta.advance_paid || 0) > 0) advance += (meta.advance_paid || 0) / ordVendors.size;
      if (isCod && shippingSplit > 0) { shipping += shippingSplit; net += shippingSplit; }
    });

    const netPayable = parseFloat(net.toFixed(2));
    const pendingSettlement = parseFloat((netPayable - totalSettled).toFixed(2));
    res.json({
      totalOrders, gross: parseFloat(gross.toFixed(2)),
      prepaidDiscount: parseFloat(prepaidDiscount.toFixed(2)),
      commissionableSale: parseFloat((gross - prepaidDiscount).toFixed(2)),
      commissionPct: commPct,
      commission: parseFloat(commission.toFixed(2)), gst: parseFloat(gst.toFixed(2)),
      advance: parseFloat(advance.toFixed(2)),
      shipping: parseFloat(shipping.toFixed(2)),
      netPayable,
      totalSettled: parseFloat(totalSettled.toFixed(2)), pendingSettlement,
    });
  } catch (err) {
    console.error("❌ /vendor/delivered-summary:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get("/vendor/settlements", vendorAuth, (req, res) => {
  res.json({ settlements: db.prepare("SELECT * FROM settlements WHERE vendor_name=? ORDER BY created_at DESC").all(req.vendor) });
});

app.get("/vendor/settlements/:id", vendorAuth, (req, res) => {
  const s = db.prepare("SELECT * FROM settlements WHERE id=? AND vendor_name=?").get(req.params.id, req.vendor);
  if (!s) return res.status(404).json({ error: "Not found." });
  const croscrow      = db.prepare("SELECT * FROM croscrow_profile WHERE id=1").get() || {};
  const vendorProfile = db.prepare("SELECT * FROM vendor_profiles WHERE vendor_name=?").get(req.vendor) || {};
  const orders = db.prepare("SELECT * FROM settlement_orders WHERE settlement_id=?").all(req.params.id);
  res.json({ settlement: s, orders, croscrow, vendorProfile });
});

// ── Shipping Partners ──────────────────────────────────────────────────────

// GET /vendor/shipping/partners
app.get("/vendor/shipping/partners", vendorAuth, (req, res) => {
  const rows = db.prepare("SELECT partner, active, connected_at FROM vendor_shipping_partners WHERE vendor_name=?").all(req.vendor);
  res.json({ partners: rows });
});

// POST /vendor/shipping/partners — save/update credentials
app.post("/vendor/shipping/partners", vendorAuth, (req, res) => {
  const { partner, credentials } = req.body || {};
  if (!partner || !credentials) return res.status(400).json({ error: "partner and credentials required" });
  const allowed = ["shiprocket", "delhivery"];
  if (!allowed.includes(partner)) return res.status(400).json({ error: "Unknown partner" });
  db.prepare(`INSERT INTO vendor_shipping_partners (vendor_name, partner, credentials, active, connected_at)
    VALUES (?,?,?,1,?)
    ON CONFLICT(vendor_name, partner) DO UPDATE SET credentials=excluded.credentials, active=1, connected_at=excluded.connected_at`)
    .run(req.vendor, partner, JSON.stringify(credentials), new Date().toISOString());
  res.json({ success: true });
});

// DELETE /vendor/shipping/partners/:partner — disconnect
app.delete("/vendor/shipping/partners/:partner", vendorAuth, (req, res) => {
  db.prepare("DELETE FROM vendor_shipping_partners WHERE vendor_name=? AND partner=?").run(req.vendor, req.params.partner);
  res.json({ success: true });
});

// POST /vendor/orders/:shopifyId/create-shipment — create shipment via connected partner
app.post("/vendor/orders/:shopifyId/create-shipment", vendorAuth, async (req, res) => {
  try {
    const { partner, weight = 0.5, length = 15, breadth = 12, height = 8 } = req.body || {};
    if (!partner) return res.status(400).json({ error: "partner required" });

    const row = db.prepare("SELECT credentials FROM vendor_shipping_partners WHERE vendor_name=? AND partner=? AND active=1")
      .get(req.vendor, partner);
    if (!row) return res.status(404).json({ error: "Partner not connected. Go to Shipping Settings to connect." });

    const creds = JSON.parse(row.credentials);

    // Fetch order from Shopify
    const { order: shopifyOrder } = await shopifyREST(`/orders/${req.params.shopifyId}.json`);

    if (!shopifyOrder) return res.status(404).json({ error: "Order not found on Shopify" });

    const addr   = shopifyOrder.shipping_address || {};
    const items  = (shopifyOrder.line_items || []).filter(li => (li.vendor || "").toLowerCase() === req.vendor.toLowerCase());
    const cod    = shopifyOrder.financial_status !== "paid";
    const codAmt = cod ? parseFloat(shopifyOrder.total_price || 0) : 0;

    let result;

    if (partner === "shiprocket") {
      // Authenticate
      const authRes = await fetch("https://apiv2.shiprocket.in/v1/external/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: creds.email, password: creds.password }),
      }).then(r => r.json());
      if (!authRes.token) return res.status(400).json({ error: "Shiprocket auth failed. Check credentials." });

      const srToken = authRes.token;
      const payload = {
        order_id:         shopifyOrder.name,
        order_date:       shopifyOrder.created_at,
        pickup_location:  creds.pickup_location || "Primary",
        billing_customer_name:  addr.first_name || shopifyOrder.customer?.first_name || "Customer",
        billing_last_name:      addr.last_name  || shopifyOrder.customer?.last_name  || "",
        billing_address:        addr.address1   || "",
        billing_address_2:      addr.address2   || "",
        billing_city:           addr.city        || "",
        billing_pincode:        addr.zip         || "",
        billing_state:          addr.province    || "",
        billing_country:        addr.country     || "India",
        billing_email:          shopifyOrder.email || "",
        billing_phone:          addr.phone || "",
        shipping_is_billing:    true,
        order_items: items.map(li => ({
          name:     li.title,
          sku:      li.sku || li.title.slice(0, 40),
          units:    li.quantity,
          selling_price: parseFloat(li.price || 0),
        })),
        payment_method: cod ? "COD" : "Prepaid",
        sub_total:      parseFloat(shopifyOrder.subtotal_price || 0),
        length, breadth, height, weight,
      };
      if (cod) payload.collect_amount = codAmt;

      const srRes = await fetch("https://apiv2.shiprocket.in/v1/external/orders/create/adhoc", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${srToken}` },
        body: JSON.stringify(payload),
      }).then(r => r.json());

      if (srRes.status_code === 1) {
        result = { success: true, orderId: srRes.order_id, shipmentId: srRes.shipment_id, awb: srRes.awb_code };
      } else {
        return res.status(400).json({ error: srRes.message || JSON.stringify(srRes) });
      }

    } else if (partner === "delhivery") {
      const totalQty = items.reduce((s, li) => s + (li.quantity || 1), 0);
      const custName = `${addr.first_name || ""} ${addr.last_name || ""}`.trim() || "Customer";
      // Delhivery order date must be YYYY-MM-DD HH:MM:SS (no T, no Z)
      const orderDateStr = (shopifyOrder.created_at || new Date().toISOString())
        .replace("T", " ").replace(/\.\d+Z$/, "").replace("Z", "");

      const shipData = {
        pickup_location: { name: creds.pickup_location || "Primary" },
        shipments: [{
          name:          custName,
          add:           addr.address1 || "",
          add2:          addr.address2 || "",
          pin:           addr.zip      || "",
          city:          addr.city     || "",
          state:         addr.province || "",
          country:       "India",
          phone:         (addr.phone || "").replace(/\D/g, "").slice(-10),
          order:         shopifyOrder.name,
          payment_mode:  cod ? "COD" : "Pre-paid",
          return_pin:    creds.return_pincode || "",
          return_city:   creds.return_city    || "",
          return_phone:  creds.return_phone   || "",
          return_name:   creds.company_name   || req.vendor,
          return_add:    creds.return_address || "",
          return_state:  creds.return_state   || "",
          return_country:"India",
          products_desc: items.map(li => li.title).join(", ").slice(0, 250),
          hsn_code:      "",
          cod_amount:    cod ? codAmt : "",
          order_date:    orderDateStr,
          total_amount:  parseFloat(shopifyOrder.total_price || 0),
          seller_inv:    shopifyOrder.name,
          quantity:      String(totalQty),
          shipment_width:  String(breadth),
          shipment_height: String(height),
          weight:          String(weight),
          seller_name:   creds.company_name || req.vendor,
          seller_add:    creds.return_address || "",
          seller_city:   creds.return_city   || "",
          seller_state:  creds.return_state  || "",
          seller_pin:    creds.return_pincode || "",
          seller_country:"India",
        }],
      };
      const dlBody = new URLSearchParams();
      dlBody.append("format", "json");
      dlBody.append("data", JSON.stringify(shipData));
      const dlRaw  = await fetch("https://track.delhivery.com/api/cmu/create.json", {
        method:  "POST",
        headers: { "Authorization": `Token ${creds.api_token}`, "Content-Type": "application/x-www-form-urlencoded" },
        body:    dlBody.toString(),
      });
      const dlRes = await dlRaw.json();

      if (dlRes.packages?.[0]?.waybill) {
        result = { success: true, awb: dlRes.packages[0].waybill };
      } else {
        const errMsg = dlRes.packages?.[0]?.remarks
          || dlRes.rmk
          || (typeof dlRes === "string" ? dlRes : JSON.stringify(dlRes));
        return res.status(400).json({ error: errMsg });
      }
    }

    // Auto-save AWB to order_meta
    if (result?.awb) {
      db.prepare(`INSERT INTO order_meta (shopify_id, awb, courier, updated_at) VALUES (?,?,?,?)
        ON CONFLICT(shopify_id) DO UPDATE SET awb=excluded.awb, courier=excluded.courier, updated_at=excluded.updated_at`)
        .run(String(shopifyOrder.id), result.awb, partner, new Date().toISOString());
    }

    res.json(result);
  } catch (err) {
    console.error("❌ /create-shipment:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Admin Global Shipping Credentials ────────────────────────────────────────
app.get("/admin/shipping-creds", adminAuth, (req, res) => {
  const rows = db.prepare("SELECT id, partner, connected_at FROM global_shipping_creds").all();
  res.json({ partners: rows });
});

app.post("/admin/shipping-creds", adminAuth, (req, res) => {
  const { partner, credentials } = req.body || {};
  if (!partner || !credentials) return res.status(400).json({ error: "partner and credentials required" });
  db.prepare(`INSERT INTO global_shipping_creds (partner, credentials, connected_at) VALUES (?,?,?)
    ON CONFLICT(partner) DO UPDATE SET credentials=excluded.credentials, connected_at=excluded.connected_at`)
    .run(partner, JSON.stringify(credentials), new Date().toISOString());
  res.json({ ok: true });
});

app.delete("/admin/shipping-creds/:partner", adminAuth, (req, res) => {
  db.prepare("DELETE FROM global_shipping_creds WHERE partner=?").run(req.params.partner);
  res.json({ ok: true });
});

// Debug endpoint — shows every step of tracking for an AWB
app.get("/admin/debug-tracking", adminAuth, async (req, res) => {
  const { awb, partner = "delhivery" } = req.query;
  if (!awb) return res.json({ error: "Pass ?awb=YOURAWB&partner=delhivery" });

  const log = [];
  try {
    const credRow = db.prepare("SELECT credentials FROM global_shipping_creds WHERE partner=?").get(partner);
    if (!credRow) return res.json({ error: `No credentials saved for ${partner}`, log });
    const creds = JSON.parse(credRow.credentials);
    log.push({ step: "creds_loaded", partner, keys: Object.keys(creds) });

    if (partner === "delhivery") {
      const url = `https://track.delhivery.com/api/v1/packages/json/?waybill=${awb}`;
      log.push({ step: "fetching", url });
      const r = await fetch(url, { headers: { "Authorization": `Token ${creds.api_token}`, "Content-Type": "application/json" } });
      const raw = await r.json();
      log.push({ step: "raw_response", status: r.status, body: raw });
      const status = raw?.ShipmentData?.[0]?.Shipment?.Status?.Status || null;
      log.push({ step: "parsed_status", status });
      return res.json({ status, log });
    }

    if (partner === "shiprocket") {
      log.push({ step: "authenticating" });
      const authRes = await fetch("https://apiv2.shiprocket.in/v1/external/auth/login", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: creds.email, password: creds.password }),
      }).then(r => r.json());
      log.push({ step: "auth_response", token: authRes.token ? "✓ received" : "✗ missing", error: authRes.message });
      if (!authRes.token) return res.json({ error: "Auth failed", log });

      const url = `https://apiv2.shiprocket.in/v1/external/courier/track/awb/${awb}`;
      log.push({ step: "fetching", url });
      const r = await fetch(url, { headers: { Authorization: `Bearer ${authRes.token}` } });
      const raw = await r.json();
      log.push({ step: "raw_response", status: r.status, body: raw });
      const status = raw?.tracking_data?.shipment_track?.[0]?.current_status || raw?.tracking_data?.shipment_status_name || null;
      log.push({ step: "parsed_status", status });
      return res.json({ status, log });
    }

    res.json({ error: `partner ${partner} not supported in debug`, log });
  } catch (err) {
    log.push({ step: "error", message: err.message });
    res.json({ error: err.message, log });
  }
});

// Admin delivery status refresh — uses global creds
app.get("/admin/orders/:shopifyId/delivery-status", adminAuth, async (req, res) => {
  try {
    const { shopifyId } = req.params;
    // Get AWB from our DB or Shopify fulfillments
    let meta = db.prepare("SELECT awb, courier, delivery_status FROM order_meta WHERE shopify_id=?").get(shopifyId) || {};
    let awb = meta.awb;
    let courier = (meta.courier || "").toLowerCase();

    if (!awb) {
      // Fall back to Shopify fulfillment data
      const { data } = await shopifyRESTRaw(`/orders/${shopifyId}.json?fields=fulfillments`);
      const fulfillment = (data.order?.fulfillments || []).find(f => f.tracking_number);
      if (fulfillment) {
        awb = fulfillment.tracking_number;
        courier = (fulfillment.tracking_company || "").toLowerCase();
      }
    }
    if (!awb) return res.json({ status: "", awb: "" });

    // Try global creds for the detected courier
    const detectPartner = c => {
      if (c.includes("delhivery")) return "delhivery";
      if (c.includes("shiprocket")) return "shiprocket";
      if (c.includes("bluedart") || c.includes("blue dart")) return "bluedart";
      if (c.includes("dtdc")) return "dtdc";
      if (c.includes("xpressbees")) return "xpressbees";
      return c;
    };
    const partner = detectPartner(courier);
    const credRow = db.prepare("SELECT credentials FROM global_shipping_creds WHERE partner=?").get(partner);
    if (!credRow) return res.json({ status: meta.delivery_status || "", awb, message: `No global credentials saved for ${partner}` });

    const creds = JSON.parse(credRow.credentials);
    const status = await fetchDeliveryStatus(partner, creds, awb);
    if (status) db.prepare(`INSERT INTO order_meta (shopify_id, awb, courier, delivery_status, delivery_status_updated_at)
      VALUES (?,?,?,?,?) ON CONFLICT(shopify_id) DO UPDATE SET delivery_status=excluded.delivery_status,
      delivery_status_updated_at=excluded.delivery_status_updated_at`)
      .run(shopifyId, awb, courier, status, new Date().toISOString());

    res.json({ status, awb });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin bulk sync delivery status for all orders with AWB
app.post("/admin/shipping/sync-status", adminAuth, async (req, res) => {
  try {
    const allCreds = db.prepare("SELECT partner, credentials FROM global_shipping_creds").all();
    if (!allCreds.length) return res.json({ updated: 0, message: "No global shipping credentials configured" });

    const orders = db.prepare("SELECT shopify_id, awb, courier FROM order_meta WHERE awb != '' AND awb IS NOT NULL").all();
    let updated = 0;
    for (const o of orders) {
      const partner = (o.courier || "").toLowerCase().includes("delhivery") ? "delhivery"
        : (o.courier || "").toLowerCase().includes("shiprocket") ? "shiprocket" : (o.courier || "").toLowerCase();
      const credRow = allCreds.find(c => c.partner === partner);
      if (!credRow) continue;
      try {
        const creds = JSON.parse(credRow.credentials);
        const status = await fetchDeliveryStatus(partner, creds, o.awb);
        if (status) {
          db.prepare("UPDATE order_meta SET delivery_status=?, delivery_status_updated_at=? WHERE shopify_id=?")
            .run(status, new Date().toISOString(), o.shopify_id);
          updated++;
        }
      } catch {}
    }
    res.json({ updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Delivery Status Tracking ───────────────────────────────────────────────

async function fetchDeliveryStatus(partner, creds, awb) {
  if (partner === "shiprocket") {
    const authRes = await fetch("https://apiv2.shiprocket.in/v1/external/auth/login", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: creds.email, password: creds.password }),
    }).then(r => r.json());
    if (!authRes.token) throw new Error("Shiprocket auth failed");
    const track = await fetch(
      `https://apiv2.shiprocket.in/v1/external/courier/track/awb/${awb}`,
      { headers: { "Authorization": `Bearer ${authRes.token}` } }
    ).then(r => r.json());
    const status = track?.tracking_data?.shipment_track?.[0]?.current_status
      || track?.tracking_data?.shipment_status_name
      || "";
    return status;
  }
  if (partner === "delhivery") {
    const dlRes = await fetch(
      `https://track.delhivery.com/api/v1/packages/json/?waybill=${awb}`,
      { headers: { "Authorization": `Token ${creds.api_token}`, "Content-Type": "application/json" } }
    ).then(r => r.json());
    const status = dlRes?.ShipmentData?.[0]?.Shipment?.Status?.Status || "";
    return status;
  }
  return "";
}

// GET /vendor/orders/:shopifyId/delivery-status — fetch live status from partner
app.get("/vendor/orders/:shopifyId/delivery-status", vendorAuth, async (req, res) => {
  try {
    const meta = db.prepare("SELECT awb, courier, delivery_status FROM order_meta WHERE shopify_id=?").get(req.params.shopifyId);
    if (!meta?.awb) return res.json({ status: "", awb: "" });

    const partner = (meta.courier || "").toLowerCase();
    const partnerRow = db.prepare("SELECT credentials FROM vendor_shipping_partners WHERE vendor_name=? AND partner=? AND active=1")
      .get(req.vendor, partner);

    let status = meta.delivery_status || "";
    if (partnerRow) {
      try {
        const creds = JSON.parse(partnerRow.credentials);
        status = await fetchDeliveryStatus(partner, creds, meta.awb);
        db.prepare("UPDATE order_meta SET delivery_status=?, delivery_status_updated_at=? WHERE shopify_id=?")
          .run(status, new Date().toISOString(), req.params.shopifyId);
      } catch {}
    }
    res.json({ status, awb: meta.awb });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /vendor/shipping/sync-status — bulk refresh delivery statuses for all orders with AWB
app.post("/vendor/shipping/sync-status", vendorAuth, async (req, res) => {
  try {
    const partners = db.prepare("SELECT partner, credentials FROM vendor_shipping_partners WHERE vendor_name=? AND active=1").all(req.vendor);
    if (!partners.length) return res.json({ updated: 0 });

    const orders = db.prepare("SELECT shopify_id, awb, courier FROM order_meta WHERE awb != '' AND awb IS NOT NULL").all();
    let updated = 0;
    for (const o of orders) {
      const partner = (o.courier || "").toLowerCase();
      const partnerRow = partners.find(p => p.partner === partner);
      if (!partnerRow) continue;
      try {
        const creds = JSON.parse(partnerRow.credentials);
        const status = await fetchDeliveryStatus(partner, creds, o.awb);
        if (status) {
          db.prepare("UPDATE order_meta SET delivery_status=?, delivery_status_updated_at=? WHERE shopify_id=?")
            .run(status, new Date().toISOString(), o.shopify_id);
          updated++;
        }
      } catch {}
    }
    res.json({ updated });
  } catch (err) {
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
