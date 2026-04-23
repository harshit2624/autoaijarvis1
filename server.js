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

const express    = require("express");
const cors       = require("cors");
const crypto     = require("crypto");
const fetch      = (...a) => import("node-fetch").then(({ default: f }) => f(...a));
const nodemailer = require("nodemailer");
const { MongoClient } = require("mongodb");
require("dotenv").config();

// ── MongoDB connection ─────────────────────────────────────────────────────
const MONGO_URI = process.env.MONGO_URI || "mongodb+srv://sicos2725:Harshit4321@cluster27.i8cmlu4.mongodb.net/jarvis?appName=Cluster27";
let mdb = null; // MongoDB database handle — null until connected

async function startServer() {
  try {
    const client = await MongoClient.connect(MONGO_URI, { tls: true, tlsAllowInvalidCertificates: false });
    mdb = client.db("jarvis");
    console.log("✅  MongoDB connected");

    // Drop stale indexes from pre-migration schema
    await mdb.collection('tag_mappings').dropIndex('tag_1').catch(() => {});

    const idxOps = [
      mdb.collection("vendor_config").createIndex({ vendor_name: 1 }, { unique: true }),
      mdb.collection("order_meta").createIndex({ shopify_id: 1 }, { unique: true }),
      mdb.collection("email_settings").createIndex({ id: 1 }, { unique: true }),
      mdb.collection("vendor_shopify_connections").createIndex({ vendor_name: 1 }, { unique: true }),
      mdb.collection("vendor_product_mappings").createIndex({ vendor_name: 1, vendor_variant_id: 1 }, { unique: true }),
      mdb.collection("order_vendor_stage").createIndex({ shopify_id: 1, vendor_name: 1 }, { unique: true }),
      mdb.collection("order_penalties").createIndex({ shopify_id: 1, vendor_name: 1 }),
      mdb.collection("order_notes").createIndex({ shopify_id: 1 }),
      mdb.collection("delay_remarks").createIndex({ shopify_id: 1, vendor_name: 1 }),
      mdb.collection("croscrow_profile").createIndex({ id: 1 }, { unique: true }),
      mdb.collection("vendor_profiles").createIndex({ vendor_name: 1 }, { unique: true }),
      mdb.collection("tag_mappings").createIndex({ shopify_tag: 1 }, { unique: true }),
      mdb.collection("global_shipping_creds").createIndex({ partner: 1 }, { unique: true }),
      mdb.collection("vendor_shipping_partners").createIndex({ vendor_name: 1, partner: 1 }, { unique: true }),
      mdb.collection("email_log").createIndex({ sent_at: -1 }),
      mdb.collection("settlements").createIndex({ vendor_name: 1, period_start: 1, period_end: 1 }, { unique: true }),
      mdb.collection("settlements").createIndex({ status: 1 }),
      mdb.collection("settlement_orders").createIndex({ settlement_id: 1 }),
      mdb.collection("settlement_penalties").createIndex({ settlement_id: 1 }),
      mdb.collection("wallet_tx").createIndex({ vendor_name: 1, created_at: -1 }),
      mdb.collection("audit_log").createIndex({ created_at: -1 }),
    ];
    await Promise.all(idxOps.map(p => p.catch(()=>{})));

    // Ensure croscrow_profile doc exists
    await mdb.collection('croscrow_profile').updateOne({ id: 1 }, { $setOnInsert: { id: 1, company_name: 'CrosCrow Marketplace', email:'',phone:'',address:'',city:'',state:'',pincode:'',gst_no:'',pan_no:'',bank_name:'',account_no:'',ifsc:'',website:'' } }, { upsert: true });
  } catch (err) {
    console.error("❌  MongoDB connection failed — cannot start:", err.message);
    process.exit(1);
  }

  app.listen(PORT, () => {
    console.log(`\n🚀  JARVIS Shopify Server running on port ${PORT}`);
    console.log(`    Shop    : ${SHOP}.myshopify.com`);
    console.log(`    Health  : /health`);
    console.log(`    Orders  : /orders`);
    console.log(`    Stats   : /orders/stats`);
    console.log(`    Export  : /orders/export`);
    console.log(`    Webhook : POST /webhooks/orders\n`);
  });
}

startServer();

// ── MongoDB helpers ───────────────────────────────────────────────────────
const mCol = (name) => mdb.collection(name);

// Auto-increment counter for integer IDs (replaces SQLite AUTOINCREMENT)
async function nextId(name) {
  const r = await mdb.collection('_counters').findOneAndUpdate(
    { _id: name }, { $inc: { seq: 1 } }, { upsert: true, returnDocument: 'after' }
  );
  return r.seq;
}

const VC = {
  async all() {
    return mdb.collection('vendor_config').find({}, { projection: { _id: 0 } }).toArray();
  },
  async get(vendor_name) {
    return mdb.collection('vendor_config').findOne({ vendor_name }, { projection: { _id: 0 } });
  },
  async upsert(vendor_name, fields) {
    await mdb.collection('vendor_config').updateOne({ vendor_name }, { $set: { vendor_name, ...fields, _updated: new Date() } }, { upsert: true });
  },
};

const ES = {
  async get() {
    return mdb.collection('email_settings').findOne({}, { projection: { _id: 0 } });
  },
  async save(fields) {
    await mdb.collection('email_settings').updateOne({}, { $set: { ...fields, _updated: new Date() } }, { upsert: true });
  },
};

const OM = {
  async upsert(shopify_id, fields) {
    const sid = String(shopify_id);
    await mdb.collection('order_meta').updateOne(
      { shopify_id: sid },
      { $set: { shopify_id: sid, ...fields, _updated: new Date() } },
      { upsert: true }
    );
  },
};

const OVS = {
  async upsert(shopify_id, vendor_name, fields) {
    const sid = String(shopify_id);
    await mdb.collection('order_vendor_stage').updateOne(
      { shopify_id: sid, vendor_name },
      { $set: { shopify_id: sid, vendor_name, ...fields, _updated: new Date() } },
      { upsert: true }
    );
  },
};

const VSC = {
  async get(vendor_name) {
    return mdb.collection('vendor_shopify_connections').findOne({ vendor_name }, { projection: { _id: 0 } });
  },
  async all() {
    return mdb.collection('vendor_shopify_connections').find({}, { projection: { _id: 0 } }).toArray();
  },
  async upsert(vendor_name, fields) {
    await mdb.collection('vendor_shopify_connections').updateOne(
      { vendor_name }, { $set: { vendor_name, ...fields, _updated: new Date() } }, { upsert: true }
    );
  },
  async delete(vendor_name) {
    await mdb.collection('vendor_shopify_connections').deleteOne({ vendor_name });
  },
};

const VPM = {
  async allForVendor(vendor_name) {
    return mdb.collection('vendor_product_mappings').find({ vendor_name }, { projection: { _id: 0 } }).toArray();
  },
  async all(vendor_name) {
    const q = vendor_name ? { vendor_name } : {};
    return mdb.collection('vendor_product_mappings').find(q, { projection: { _id: 0 } }).sort({ _id: -1 }).toArray();
  },
  async upsert(vendor_name, vendor_variant_id, fields) {
    const vvid = String(vendor_variant_id);
    await mdb.collection('vendor_product_mappings').updateOne(
      { vendor_name, vendor_variant_id: vvid },
      { $set: { vendor_name, vendor_variant_id: vvid, ...fields, _updated: new Date() } },
      { upsert: true }
    );
  },
  async updateSynced(vendor_name, vendor_variant_id) {
    const vvid = String(vendor_variant_id);
    await mdb.collection('vendor_product_mappings').updateOne(
      { vendor_name, vendor_variant_id: vvid }, { $set: { last_synced_at: Date.now(), _updated: new Date() } }
    );
  },
  async delete(id) {
    await mdb.collection('vendor_product_mappings').deleteOne({ id: parseInt(id) });
  },
};

const ON = {
  async allFor(shopify_id) {
    return mdb.collection('order_notes').find({ shopify_id: String(shopify_id) }, { projection: { _id: 0 } }).sort({ created_at: 1 }).toArray();
  },
  async insert(shopify_id, role, author, note) {
    const sid = String(shopify_id);
    const created_at = new Date().toISOString();
    await mdb.collection('order_notes').insertOne({ shopify_id: sid, role, author, note, created_at });
  },
};

const DR = {
  async allFor(shopify_id, vendor_name) {
    const q = vendor_name ? { shopify_id: String(shopify_id), vendor_name } : { shopify_id: String(shopify_id) };
    return mdb.collection('delay_remarks').find(q, { projection: { _id: 0 } }).sort({ submitted_at: 1 }).toArray();
  },
  async latest(shopify_id, vendor_name) {
    return mdb.collection('delay_remarks').findOne({ shopify_id: String(shopify_id), vendor_name }, { projection: { _id: 0 }, sort: { submitted_at: -1 } });
  },
  async insert(shopify_id, vendor_name, reason, eta_date) {
    const sid = String(shopify_id);
    const submitted_at = Date.now();
    await mdb.collection('delay_remarks').insertOne({ shopify_id: sid, vendor_name, reason, eta_date, submitted_at, eta_penalty_triggered: 0 });
  },
  async markEtaPenalty(_id) {
    await mdb.collection('delay_remarks').updateOne({ _id }, { $set: { eta_penalty_triggered: 1 } });
  },
  async expiredEta(today) {
    return mdb.collection('delay_remarks').find({ eta_date: { $lt: today }, eta_penalty_triggered: 0 }, { projection: { _id: 0 } }).toArray();
  },
};

// ── order_penalties: MongoDB primary ──────────────────────────────────────
const OP = {
  async all(status) {
    const q = status && status !== 'all' ? { status } : {};
    return mdb.collection('order_penalties').find(q, { projection: { _id: 0 } }).sort({ triggered_at: -1 }).toArray();
  },
  async get(id) {
    return mdb.collection('order_penalties').findOne({ id: parseInt(id) }, { projection: { _id: 0 } });
  },
  async hasPending(shopify_id, vendor_name) {
    return !!(await mdb.collection('order_penalties').findOne({ shopify_id: String(shopify_id), vendor_name, status: 'pending' }));
  },
  async insert(shopify_id, vendor_name, order_name, trigger_reason) {
    const sid = String(shopify_id);
    const id = await nextId('order_penalties');
    const triggered_at = Date.now();
    await mdb.collection('order_penalties').insertOne({ id, shopify_id: sid, vendor_name, order_name: order_name || '', triggered_at, trigger_reason, status: 'pending' });
  },
  async resolve(id, status, penalty_amount, admin_note) {
    const resolved_at = Date.now();
    await mdb.collection('order_penalties').updateOne({ id: parseInt(id) }, { $set: { status, penalty_amount, admin_note: admin_note || '', resolved_at, resolved_by: 'admin' } });
  },
};

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
const SHOP              = process.env.SHOP_NAME;
const CLIENT_ID         = process.env.SHOPIFY_CLIENT_ID;
const CLIENT_SECRET     = process.env.SHOPIFY_CLIENT_SECRET;
const PORT              = process.env.PORT || 3001;
const VENDOR_APP_CLIENT_ID  = process.env.VENDOR_APP_CLIENT_ID  || '';
const VENDOR_APP_SECRET     = process.env.VENDOR_APP_SECRET     || '';

if (!SHOP || !CLIENT_ID || !CLIENT_SECRET) {
  console.error("❌  Missing env vars: SHOP_NAME, SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET");
  process.exit(1);
}


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


// Derive payment_type from Shopify financial_status
function paymentTypeFromFinancial(financialStatus) {
  if (financialStatus === "paid")            return "prepaid";
  if (financialStatus === "partially_paid")  return "partial";
  return "cod"; // pending, voided, refunded, etc.
}

// Apply tag mappings + auto-detect payment_type for one order
async function applyTagMappings(orderId, tags, financialStatus) {
  const now = new Date().toISOString();
  const payType = paymentTypeFromFinancial(financialStatus || "pending");
  const sid = String(orderId);

  // Step 1: set payment_type from Shopify financial_status
  await OM.upsert(sid, { payment_type: payType, updated_at: now });

  if (!tags) return;
  const orderTags = tags.split(",").map(t => t.trim());

  // Step 2: scan ALL tags for partial advance pattern
  for (const tag of orderTags) {
    const advMatch = tag.match(/^(\d+(?:\.\d+)?)\s+partial/i);
    if (advMatch) {
      await OM.upsert(sid, { advance_paid: parseFloat(advMatch[1]), payment_type: 'cod', updated_at: now });
      break;
    }
  }

  // Step 3: apply stage from tag_mappings — lowest priority number wins
  const mappings = await mdb.collection('tag_mappings').find({}, { projection: { _id: 0 } }).sort({ priority: 1, id: 1 }).toArray();
  let winner = null;
  for (const m of mappings) {
    const hit = orderTags.find(t => t.toLowerCase() === m.shopify_tag.toLowerCase().trim());
    if (hit) { winner = m; break; }
  }
  if (winner) {
    const prev = await mdb.collection('order_meta').findOne({ shopify_id: sid }, { projection: { stage: 1 } });
    await OM.upsert(sid, { stage: winner.stage, updated_at: now });
    if (!prev || prev.stage !== winner.stage) {
      fireStageEmails(sid, winner.stage).catch(()=>{});
      // Sync into order_vendor_stage so penalty cron can track 48hr timer.
      // Never downgrade a vendor who already has AWB/tracking submitted (pickup or beyond).
      if (['confirmed','partial'].includes(winner.stage)) {
        const ADVANCED = ['ready','pickup','transit','delivered','rto','cancelled'];
        try {
          const od = await shopifyREST(`/orders/${sid}.json?fields=id,line_items`);
          const vendors = [...new Set((od?.order?.line_items || []).map(li => li.vendor).filter(Boolean))];
          const nowMs = Date.now();
          for (const vendor of vendors) {
            const existing = await mdb.collection('order_vendor_stage').findOne({ shopify_id: sid, vendor_name: vendor }, { projection: { stage: 1, stage_started_at: 1, _id: 0 } });
            // Skip: vendor already dispatched or further ahead — don't pull them back
            if (existing && ADVANCED.includes(existing.stage)) continue;
            await OVS.upsert(sid, vendor, { stage: winner.stage, updated_at: now, stage_started_at: existing?.stage_started_at || nowMs, warning_sent: 0, penalty_triggered: 0 });
          }
        } catch(e) { console.error('applyTagMappings vendor sync error:', e.message); }
      }
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
  mdb.collection('audit_log').insertOne({
    actor, action,
    target_id: String(targetId),
    details: typeof details === "object" ? JSON.stringify(details) : String(details || ""),
    created_at: new Date().toISOString(),
  }).catch(() => {});
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

// ══════════════════════════════════════════════════════════════════════════
// WEBHOOK REGISTRATION
// ══════════════════════════════════════════════════════════════════════════

// All webhooks we want registered on Shopify
const DESIRED_WEBHOOKS = [
  { topic: 'orders/create',       format: 'json', path: '/webhooks/orders' },
  { topic: 'orders/updated',      format: 'json', path: '/webhooks/orders' },
  { topic: 'orders/paid',         format: 'json', path: '/webhooks/orders' },
  { topic: 'orders/cancelled',    format: 'json', path: '/webhooks/orders' },
  { topic: 'fulfillments/create', format: 'json', path: '/webhooks/fulfillments' },
  { topic: 'fulfillments/update', format: 'json', path: '/webhooks/fulfillments' },
];

// ── GET /admin/webhooks — list all webhooks registered on Shopify ──────────
app.get("/admin/webhooks", adminAuth, async (req, res) => {
  try {
    const token = await getAccessToken();
    const r = await fetch(`https://${SHOP}.myshopify.com/admin/api/2025-01/webhooks.json`,
      { headers: { "X-Shopify-Access-Token": token } });
    const d = await r.json();
    res.json({ webhooks: d.webhooks || [] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── POST /admin/setup-webhooks — idempotently register all desired webhooks ─
app.post("/admin/setup-webhooks", adminAuth, async (req, res) => {
  try {
    const token = await getAccessToken();
    const base  = SERVER_BASE; // e.g. https://your-app.onrender.com

    // Fetch existing
    const listRes = await fetch(`https://${SHOP}.myshopify.com/admin/api/2025-01/webhooks.json`,
      { headers: { "X-Shopify-Access-Token": token } });
    const listData = await listRes.json();
    const existing = listData.webhooks || [];

    const results = [];
    for (const wh of DESIRED_WEBHOOKS) {
      const callbackUrl = `${base}${wh.path}`;
      const alreadyExists = existing.find(e => e.topic === wh.topic && e.address === callbackUrl);
      if (alreadyExists) {
        results.push({ topic: wh.topic, status: 'already_registered', id: alreadyExists.id });
        continue;
      }
      // Remove any stale webhook for same topic (different URL)
      const stale = existing.filter(e => e.topic === wh.topic && e.address !== callbackUrl);
      for (const s of stale) {
        await fetch(`https://${SHOP}.myshopify.com/admin/api/2025-01/webhooks/${s.id}.json`,
          { method: 'DELETE', headers: { "X-Shopify-Access-Token": token } });
      }
      // Register fresh
      const createRes = await fetch(`https://${SHOP}.myshopify.com/admin/api/2025-01/webhooks.json`, {
        method: 'POST',
        headers: { "X-Shopify-Access-Token": token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ webhook: { topic: wh.topic, address: callbackUrl, format: wh.format } }),
      });
      const createData = await createRes.json();
      if (createData.webhook) {
        results.push({ topic: wh.topic, status: 'registered', id: createData.webhook.id, address: callbackUrl });
        console.log(`✅ Webhook registered: ${wh.topic} → ${callbackUrl}`);
      } else {
        results.push({ topic: wh.topic, status: 'error', detail: JSON.stringify(createData.errors || createData) });
      }
    }
    res.json({ results });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── DELETE /admin/webhooks/:id ─────────────────────────────────────────────
app.delete("/admin/webhooks/:id", adminAuth, async (req, res) => {
  try {
    const token = await getAccessToken();
    await fetch(`https://${SHOP}.myshopify.com/admin/api/2025-01/webhooks/${req.params.id}.json`,
      { method: 'DELETE', headers: { "X-Shopify-Access-Token": token } });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════════════════════════════════════
// WEBHOOK HMAC VERIFIER
// ══════════════════════════════════════════════════════════════════════════
function verifyShopifyHmac(req) {
  const hmac = req.headers["x-shopify-hmac-sha256"];
  if (!CLIENT_SECRET || !hmac) return true; // skip check if not configured
  const computed = crypto.createHmac("sha256", CLIENT_SECRET).update(req.body).digest("base64");
  return crypto.timingSafeEqual(Buffer.from(hmac), Buffer.from(computed));
}

// ══════════════════════════════════════════════════════════════════════════
// WEBHOOK HANDLERS — core automation engine
// ══════════════════════════════════════════════════════════════════════════

// ── POST /webhooks/orders ─────────────────────────────────────────────────
app.post("/webhooks/orders", (req, res) => {
  if (!verifyShopifyHmac(req)) {
    console.warn("⚠️  Webhook HMAC mismatch — rejected");
    return res.status(401).json({ error: "Unauthorized" });
  }
  const topic = req.headers["x-shopify-topic"] ?? "unknown";
  let payload = {};
  try { payload = JSON.parse(req.body.toString()); } catch {}
  logWebhook(topic, payload);
  res.status(200).json({ received: true }); // respond immediately

  // Process async — never let errors reach Shopify
  (async () => {
    try {
      const sid = String(payload.id || '');

      // ── orders/create: email customer + notify vendors ─────────────────
      if (topic === 'orders/create') {
        const settingsRow = await ES.get();
        if (settingsRow?.enabled === 0) return;
        const cfg = await getSmtpConfig();
        if (!cfg?.host) return;

        if (payload.email) {
          const enriched = await enrichOrderImages(payload);
          await sendEmail({
            to: payload.email,
            subject: `Your Order ${payload.name} — Please Confirm on WhatsApp`,
            html: templateNewOrderCustomerSky({ order: enriched }),
            shopifyId: sid, trigger: 'new_order_customer',
          });
        }

        // Notify each vendor with their line items
        const vendors = [...new Set((payload.line_items || []).map(li => li.vendor).filter(Boolean))];
        const vcfgs = await VC.all();
        for (const vendorName of vendors) {
          const vc = vcfgs.find(v => v.vendor_name === vendorName);
          if (vc?.email) {
            await sendEmail({
              to: vc.email,
              subject: `New Order Received: ${payload.name}`,
              html: templateNewOrderVendor({ order: payload, vendorName }),
              shopifyId: sid, trigger: 'new_order_vendor',
            });
          }
        }
        console.log(`📦 orders/create processed: ${payload.name}`);
      }

      // ── orders/updated: tag → stage auto-mapping ───────────────────────
      if (topic === 'orders/updated' && sid) {
        // Use the same applyTagMappings function as the sync button — handles case-insensitive matching + priority
        await applyTagMappings(sid, payload.tags || '', payload.financial_status || '');
        const newMeta = await mdb.collection('order_meta').findOne({ shopify_id: sid }, { projection: { stage: 1 } });
        console.log(`🏷️  orders/updated processed: ${payload.name} → stage: ${newMeta?.stage || 'unchanged'}`);

        // Sync financial status change (e.g. COD → paid after collection)
        if (payload.financial_status === 'paid') {
          const meta = await mdb.collection('order_meta').findOne({ shopify_id: sid }, { projection: { payment_type: 1 } });
          if (!meta?.payment_type || meta.payment_type === 'cod') {
            await OM.upsert(sid, { payment_type: 'prepaid', updated_at: new Date().toISOString() });
            auditLog("webhook", "payment_auto_prepaid", sid, {});
          }
        }
      }

      // ── orders/paid: mark prepaid ──────────────────────────────────────
      if (topic === 'orders/paid' && sid) {
        await OM.upsert(sid, { payment_type: 'prepaid', updated_at: new Date().toISOString() });
        auditLog("webhook", "payment_auto_prepaid", sid, { trigger: 'orders/paid' });
        console.log(`💳 orders/paid: ${payload.name} marked prepaid`);
      }

      // ── orders/cancelled: set stage cancelled ──────────────────────────
      if (topic === 'orders/cancelled' && sid) {
        await OM.upsert(sid, { stage: 'cancelled', updated_at: new Date().toISOString() });
        // Also cancel all vendor stages
        const vendors = [...new Set((payload.line_items || []).map(li => li.vendor).filter(Boolean))];
        for (const v of vendors) {
          await OVS.upsert(sid, v, { stage: 'cancelled', updated_at: new Date().toISOString() });
        }
        auditLog("webhook", "order_cancelled", sid, {});
        console.log(`❌ orders/cancelled: ${payload.name}`);
      }

    } catch (err) {
      console.error(`❌ webhook orders handler (${topic}):`, err.message);
    }
  })();
});

// ── POST /webhooks/fulfillments ───────────────────────────────────────────
app.post("/webhooks/fulfillments", (req, res) => {
  if (!verifyShopifyHmac(req)) {
    console.warn("⚠️  Webhook HMAC mismatch — rejected");
    return res.status(401).json({ error: "Unauthorized" });
  }
  const topic = req.headers["x-shopify-topic"] ?? "unknown";
  let payload = {};
  try { payload = JSON.parse(req.body.toString()); } catch {}
  logWebhook(topic, payload);
  res.status(200).json({ received: true });

  (async () => {
    try {
      // payload is a fulfillment object — has order_id, line_items, tracking_number, tracking_company, tracking_url, shipment_status
      const shopifyId = String(payload.order_id || '');
      const awb       = payload.tracking_number || '';
      const courier   = payload.tracking_company || '';
      const trackUrl  = payload.tracking_url || '';
      const status    = payload.shipment_status || ''; // in_transit, out_for_delivery, delivered, etc.

      if (!shopifyId) return;

      // Fetch full order to find vendor of these line items
      const orderRes = await shopifyREST(`/orders/${shopifyId}.json?fields=id,name,email,line_items,shipping_address,financial_status`);
      const order = orderRes?.order;
      if (!order) return;

      const fulfilledLineItemIds = new Set((payload.line_items || []).map(li => li.id));
      const fulfilledLineItems   = (order.line_items || []).filter(li => fulfilledLineItemIds.has(li.id));
      const vendors = [...new Set(fulfilledLineItems.map(li => li.vendor).filter(Boolean))];

      if (topic === 'fulfillments/create') {
        for (const vendorName of vendors) {
          const vendorItems = fulfilledLineItems.filter(li => li.vendor === vendorName);

          // Skip if vendor already has their own AWB saved (fulfilled via our system)
          const existing = await mdb.collection('order_vendor_stage').findOne(
            { shopify_id: shopifyId, vendor_name: vendorName },
            { projection: { awb: 1, _id: 0 } }
          );
          if (existing?.awb) {
            console.log(`⏭ fulfillments/create: ${vendorName} already has AWB ${existing.awb}, skipping`);
            continue;
          }

          await OVS.upsert(shopifyId, vendorName, {
            stage: 'pickup', awb, courier, tracking_url: trackUrl,
            updated_at: new Date().toISOString(),
          });
          auditLog("webhook", "fulfillment_auto_pickup", shopifyId, { vendorName, awb });

          // Email customer about this vendor's shipment
          const cfg = await getSmtpConfig();
          if (cfg && order.email && vendorItems.length) {
            await sendEmail({
              to: order.email,
              subject: `Your Items from ${vendorName} Have Shipped! 🚚`,
              html: templateVendorShipped({ order, vendorName, items: vendorItems, awb, courier, trackingUrl: trackUrl }),
              shopifyId, trigger: 'vendor_shipped',
            });
          }
        }
        console.log(`📦 fulfillments/create: order ${order.name}, vendors: ${vendors.join(', ')}, AWB: ${awb}`);
      }

      if (topic === 'fulfillments/update' && status) {
        // Map Shopify shipment_status → our stage
        const statusMap = {
          in_transit:        'transit',
          out_for_delivery:  'transit',
          delivered:         'delivered',
          failure:           'rto',
          attempted_delivery:'transit',
        };
        const mappedStage = statusMap[status];
        if (mappedStage) {
          for (const vendorName of vendors) {
            await OVS.upsert(shopifyId, vendorName, { stage: mappedStage, updated_at: new Date().toISOString() });
          }
          // Also update order-level delivery status
          await OM.upsert(shopifyId, { delivery_status: status, updated_at: new Date().toISOString() });
          auditLog("webhook", "fulfillment_status_sync", shopifyId, { status, mappedStage, vendors });
          console.log(`🚚 fulfillments/update: order ${order.name} → ${mappedStage} (${status})`);
        }
      }

    } catch (err) {
      console.error(`❌ webhook fulfillments handler (${topic}):`, err.message);
    }
  })();
});

// ── JARVIS store snapshot builder ─────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════
// EMAIL ENGINE
// ══════════════════════════════════════════════════════════════════════════

async function getSmtpConfig() {
  const row = await ES.get();
  if (!row) return null;
  try { return typeof row.smtp === 'string' ? JSON.parse(row.smtp) : row.smtp; } catch { return null; }
}

function createTransporter(cfg) {
  return nodemailer.createTransport({
    host: cfg.host,
    port: parseInt(cfg.port) || 587,
    secure: parseInt(cfg.port) === 465,
    auth: { user: cfg.user, pass: cfg.pass },
  });
}

function logEmail(shopifyId, trigger, recipient, subject, status, error='') {
  const sent_at = new Date().toISOString();
  mdb.collection('email_log').insertOne({ shopify_id: String(shopifyId||''), trigger, recipient, subject, status, error, sent_at }).catch(() => {});
}

// ── HTML Email Templates ──────────────────────────────────────────────────
function emailBase(title, accentColor, bodyHtml) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  body{margin:0;padding:0;background:#f0f4f8;font-family:'Segoe UI',Arial,sans-serif;}
  .wrap{max-width:600px;margin:32px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);}
  .header{background:${accentColor};padding:32px 36px;}
  .header-logo{font-size:22px;font-weight:800;color:#fff;letter-spacing:3px;}
  .header-sub{font-size:12px;color:rgba(255,255,255,0.7);letter-spacing:2px;margin-top:4px;}
  .body{padding:32px 36px;}
  .title{font-size:22px;font-weight:700;color:#1a2a3a;margin-bottom:8px;}
  .subtitle{font-size:14px;color:#6b7280;margin-bottom:28px;}
  .info-box{background:#f8fafc;border-radius:8px;padding:20px 24px;margin-bottom:20px;}
  .info-row{display:flex;justify-content:space-between;padding:7px 0;border-bottom:1px solid #e5e7eb;font-size:13px;}
  .info-row:last-child{border-bottom:none;}
  .info-label{color:#6b7280;font-weight:500;}
  .info-val{color:#1a2a3a;font-weight:600;text-align:right;}
  .badge{display:inline-block;padding:4px 12px;border-radius:20px;font-size:12px;font-weight:700;}
  .items-table{width:100%;border-collapse:collapse;margin-bottom:20px;}
  .items-table th{background:#f1f5f9;color:#6b7280;font-size:11px;text-transform:uppercase;letter-spacing:1px;padding:10px 14px;text-align:left;}
  .items-table td{padding:11px 14px;border-bottom:1px solid #f1f5f9;font-size:13px;color:#374151;}
  .footer{background:#f8fafc;padding:20px 36px;text-align:center;font-size:11px;color:#9ca3af;border-top:1px solid #e5e7eb;}
  .cta{display:inline-block;margin:20px 0;padding:13px 32px;background:${accentColor};color:#fff;text-decoration:none;border-radius:8px;font-weight:700;font-size:14px;}
</style></head><body>
<div class="wrap">
  <div class="header">
    <div class="header-logo">CROSCROW</div>
    <div class="header-sub">ORDER NOTIFICATION</div>
  </div>
  <div class="body">
    <div class="title">${title}</div>
    ${bodyHtml}
  </div>
  <div class="footer">© CrosCrow · This is an automated notification · Do not reply to this email</div>
</div></body></html>`;
}

function templateOrderConfirmedCustomer({ order }) {
  const isPrepaid = order.financial_status === 'paid';
  const body = `
    <div class="subtitle">Your order has been confirmed and is being prepared.</div>
    ${isPrepaid ? `<div style="background:#f0fdf4;border:2px solid #10b981;border-radius:8px;padding:12px 18px;margin-bottom:20px;text-align:center;font-weight:700;color:#065f46;font-size:14px;letter-spacing:1px;">✅ PREPAID ORDER — No payment due on delivery</div>` : ''}
    <div class="info-box">
      <div class="info-row"><span class="info-label">Order ID</span><span class="info-val">${order.name}</span></div>
      <div class="info-row"><span class="info-label">Date</span><span class="info-val">${new Date(order.created_at).toLocaleDateString('en-IN',{day:'numeric',month:'long',year:'numeric'})}</span></div>
      <div class="info-row"><span class="info-label">Payment Mode</span><span class="info-val">${isPrepaid ? '✅ Prepaid (Paid Online)' : '💵 Cash on Delivery'}</span></div>
      <div class="info-row"><span class="info-label">Order Total</span><span class="info-val" style="color:#10b981;font-size:16px;font-weight:800">₹${parseFloat(order.total_price).toFixed(2)}</span></div>
      ${order.shipping_address ? `<div class="info-row"><span class="info-label">Deliver To</span><span class="info-val">${order.shipping_address.name}, ${order.shipping_address.city}, ${order.shipping_address.province} ${order.shipping_address.zip}</span></div>` : ''}
    </div>
    ${itemsTableHtml(order.line_items || [])}
    <p style="font-size:13px;color:#6b7280;line-height:1.7">We'll notify you once your order is shipped. Thank you for shopping with CrosCrow!</p>
  `;
  return emailBase(`Order Confirmed: ${order.name}`, '#10b981', body);
}

function itemsTableHtml(lineItems, showVendor = false) {
  const rows = lineItems.map(li => {
    const img = li.image_url
      ? `<img src="${li.image_url}" width="48" height="48" style="width:48px;height:48px;object-fit:cover;border-radius:6px;border:1px solid #e5e7eb;display:block;" alt="${li.title}">`
      : `<div style="width:48px;height:48px;background:#f1f5f9;border-radius:6px;border:1px solid #e5e7eb;display:flex;align-items:center;justify-content:center;font-size:20px;">📦</div>`;
    return `<tr>
      <td style="padding:10px 12px;border-bottom:1px solid #f1f5f9;vertical-align:middle;width:60px">${img}</td>
      <td style="padding:10px 12px;border-bottom:1px solid #f1f5f9;font-size:13px;color:#374151;vertical-align:middle">
        <strong>${li.title}</strong>${li.variant_title ? `<br><span style="font-size:11px;color:#9ca3af">${li.variant_title}</span>` : ''}
        ${li.sku ? `<br><span style="font-size:10px;color:#d1d5db">SKU: ${li.sku}</span>` : ''}
        ${showVendor && li.vendor ? `<br><span style="font-size:10px;color:#6366f1">${li.vendor}</span>` : ''}
      </td>
      <td style="padding:10px 12px;border-bottom:1px solid #f1f5f9;font-size:13px;text-align:center;vertical-align:middle;color:#6b7280">${li.quantity}</td>
      <td style="padding:10px 12px;border-bottom:1px solid #f1f5f9;font-size:13px;text-align:right;vertical-align:middle;font-weight:600;color:#1a2a3a">₹${parseFloat(li.price).toFixed(2)}</td>
    </tr>`;
  }).join('');
  return `<table style="width:100%;border-collapse:collapse;margin-bottom:20px;">
    <thead><tr style="background:#f8fafc">
      <th style="padding:10px 12px;text-align:left;font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:1px;width:60px"></th>
      <th style="padding:10px 12px;text-align:left;font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:1px">Item</th>
      <th style="padding:10px 12px;text-align:center;font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:1px">Qty</th>
      <th style="padding:10px 12px;text-align:right;font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:1px">Price</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

const WA_ICON = `<svg width="36" height="36" viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="20" cy="20" r="20" fill="#25d366"/><path d="M28.5 11.5C26.3 9.3 23.3 8 20 8C13.4 8 8 13.4 8 20C8 22.1 8.6 24.1 9.6 25.9L8 32L14.3 30.4C16 31.3 17.9 31.8 20 31.8C26.6 31.8 32 26.4 32 19.8C32 16.6 30.7 13.7 28.5 11.5ZM20 29.8C18.1 29.8 16.3 29.3 14.7 28.4L14.3 28.2L10.7 29.1L11.6 25.6L11.4 25.2C10.4 23.5 9.9 21.8 9.9 19.9C9.9 14.4 14.4 9.9 20 9.9C22.7 9.9 25.2 10.9 27.1 12.8C29 14.7 30 17.2 30 19.9C30 25.5 25.5 29.8 20 29.8ZM25.4 22.5C25.1 22.4 23.6 21.6 23.3 21.5C23 21.4 22.8 21.4 22.6 21.7C22.4 22 21.8 22.7 21.6 22.9C21.4 23.1 21.3 23.1 21 23C19.1 22 17.9 21.3 16.6 19.1C16.3 18.6 16.9 18.6 17.4 17.6C17.5 17.4 17.4 17.2 17.4 17C17.3 16.8 16.7 15.3 16.4 14.7C16.2 14.1 15.9 14.2 15.7 14.2C15.5 14.2 15.3 14.2 15.1 14.2C14.9 14.2 14.5 14.3 14.2 14.6C13.9 14.9 13.1 15.7 13.1 17.2C13.1 18.7 14.2 20.1 14.4 20.3C14.6 20.5 16.7 23.7 19.9 25C22 25.9 22.8 25.9 23.8 25.8C24.4 25.7 25.7 25 26 24.2C26.3 23.4 26.3 22.8 26.2 22.6C26.1 22.6 25.7 22.6 25.4 22.5Z" fill="white"/></svg>`;

// ── Sky-theme new order template (preview/test version) ───────────────────
function templateNewOrderCustomerSky({ order }) {
  const isPrepaid = order.financial_status === 'paid';
  const waNum  = (process.env.WHATSAPP_NUMBER || '').replace(/\D/g, '');
  const waLink = waNum ? `https://wa.me/${waNum}?text=${encodeURIComponent('Hi! I confirm my order ' + order.name + ' placed on CrosCrow. Please proceed.')}` : '#';
  const items  = order.line_items || [];
  const total  = parseFloat(order.total_price || 0);
  const addr   = order.shipping_address;
  const IMG    = 'https://i.ibb.co/YFCVGFxR/Concrete-is-a-construct-So-are-the-rules-The-jungle-isn-t-wild-it-s-designed.jpg';
  const LOGO   = 'https://i.ibb.co/DHx0VCZb/Untitled-design-1.jpg';

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
</head>
<body style="margin:0;padding:0;background:#0d0d0d;font-family:Arial,sans-serif;">
<div style="max-width:620px;margin:0 auto;">

  <!-- HERO IMAGE -->
  <div style="position:relative;line-height:0;">
    <img src="${IMG}" width="620" alt="CrosCrow" style="width:100%;max-width:620px;display:block;object-fit:cover;max-height:340px;">
    <!-- Dark overlay text on image -->
    <div style="position:absolute;bottom:0;left:0;right:0;padding:28px 32px;background:linear-gradient(to top,rgba(0,0,0,0.92) 0%,rgba(0,0,0,0.4) 70%,transparent 100%);">
      <div style="font-size:9px;font-weight:700;letter-spacing:4px;color:rgba(255,255,255,0.45);text-transform:uppercase;margin-bottom:8px;">60+ BRANDS &nbsp;|&nbsp; ONE STOP</div>
      <div style="font-size:28px;font-weight:900;color:#ffffff;letter-spacing:3px;text-transform:uppercase;line-height:1.1;">ORDER<br>RECEIVED.</div>
    </div>
  </div>

  <!-- ORDER ID BAR -->
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#111111;">
    <tr>
      <td style="padding:18px 32px;">
        <div style="font-size:9px;letter-spacing:4px;color:#555;text-transform:uppercase;margin-bottom:4px;">Order ID</div>
        <div style="font-size:20px;font-weight:900;color:#ffffff;letter-spacing:2px;">${order.name}</div>
      </td>
      <td style="padding:18px 32px;text-align:right;">
        <div style="font-size:9px;letter-spacing:4px;color:#555;text-transform:uppercase;margin-bottom:4px;">Total</div>
        <div style="font-size:20px;font-weight:900;color:#7eb8f7;letter-spacing:1px;">&#8377;${total.toFixed(2)}</div>
      </td>
    </tr>
  </table>

  <!-- BODY -->
  <div style="background:#161616;padding:32px;">

    <!-- Greeting -->
    <div style="margin-bottom:24px;">
      <div style="font-size:17px;font-weight:700;color:#f0f0f0;margin-bottom:6px;">Hey ${addr?.first_name || order.email?.split('@')[0] || 'there'} —</div>
      <div style="font-size:13px;color:#888;line-height:1.8;">Your order is confirmed and under review. We'll notify you once it's dispatched. Sit tight.</div>
    </div>

    ${!isPrepaid ? `
    <!-- WhatsApp confirm -->
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#0d1f0d;border:1px solid #1a4a1a;border-radius:8px;margin-bottom:24px;">
      <tr><td style="padding:20px 24px;">
        <div style="font-size:9px;font-weight:700;letter-spacing:4px;color:#3d9e3d;text-transform:uppercase;margin-bottom:8px;">Action Required</div>
        <div style="font-size:13px;color:#aaa;line-height:1.7;margin-bottom:16px;">Confirm your order on WhatsApp to get it processed. Quick and easy.</div>
        <a href="${waLink}" style="display:inline-block;background:#25d366;color:#fff;text-decoration:none;font-weight:800;font-size:11px;letter-spacing:3px;text-transform:uppercase;padding:12px 24px;border-radius:4px;">Confirm on WhatsApp</a>
      </td></tr>
    </table>` : `
    <!-- Prepaid -->
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#0d1520;border:1px solid #1a3a6a;border-radius:8px;margin-bottom:24px;">
      <tr><td style="padding:18px 24px;">
        <div style="font-size:9px;font-weight:700;letter-spacing:4px;color:#7eb8f7;text-transform:uppercase;margin-bottom:6px;">Prepaid — All Set</div>
        <div style="font-size:13px;color:#aaa;">Payment received. No action needed from your side.</div>
      </td></tr>
    </table>`}

    <!-- Divider label -->
    <div style="font-size:9px;font-weight:700;letter-spacing:4px;color:#444;text-transform:uppercase;margin-bottom:14px;margin-top:8px;">Your Items</div>

    <!-- Items -->
    ${items.map(li => {
      const img = li.image?.src || (li.properties?.find(p => p.name === '_image')?.value) || '';
      return `
    <table width="100%" cellpadding="0" cellspacing="0" style="border-bottom:1px solid #1e1e1e;margin-bottom:0;">
      <tr>
        ${img ? `<td style="padding:14px 14px 14px 0;width:64px;vertical-align:top;">
          <img src="${img}" width="60" height="60" alt="" style="border-radius:6px;object-fit:cover;display:block;background:#222;">
        </td>` : `<td style="padding:14px 14px 14px 0;width:64px;vertical-align:top;">
          <div style="width:60px;height:60px;background:#1e1e1e;border-radius:6px;display:flex;align-items:center;justify-content:center;">
            <span style="font-size:20px;">&#128247;</span>
          </div>
        </td>`}
        <td style="padding:14px 0;vertical-align:top;">
          <div style="font-size:13px;font-weight:700;color:#e8e8e8;">${li.title}</div>
          ${li.variant_title && li.variant_title !== 'Default Title' ? `<div style="font-size:10px;color:#555;margin-top:3px;letter-spacing:1px;">${li.variant_title}</div>` : ''}
          <div style="font-size:9px;letter-spacing:3px;color:#444;margin-top:5px;text-transform:uppercase;">Qty ${li.quantity}</div>
        </td>
        <td style="padding:14px 0;text-align:right;vertical-align:top;">
          <div style="font-size:14px;font-weight:800;color:#f0f0f0;">&#8377;${(parseFloat(li.price||0)*li.quantity).toFixed(2)}</div>
        </td>
      </tr>
    </table>`;
    }).join('')}

    <!-- Total -->
    <table width="100%" cellpadding="0" cellspacing="0" style="margin:20px 0;background:#0f0f0f;border-radius:6px;">
      <tr>
        <td style="padding:16px 20px;font-size:10px;font-weight:700;letter-spacing:3px;color:#555;text-transform:uppercase;">Order Total</td>
        <td style="padding:16px 20px;text-align:right;font-size:20px;font-weight:900;color:#7eb8f7;">&#8377;${total.toFixed(2)}</td>
      </tr>
    </table>

    <!-- Ship to -->
    ${addr ? `
    <div style="margin-bottom:24px;margin-top:4px;">
      <div style="font-size:9px;font-weight:700;letter-spacing:4px;color:#444;text-transform:uppercase;margin-bottom:12px;">Shipping To</div>
      <div style="font-size:13px;color:#888;line-height:1.9;">
        <span style="font-weight:700;color:#ccc;">${addr.name}</span><br>
        ${addr.address1}${addr.address2 ? ', ' + addr.address2 : ''}<br>
        ${addr.city}, ${addr.province} ${addr.zip}<br>
        ${addr.phone ? `<span style="color:#555;font-size:12px;">${addr.phone}</span>` : ''}
      </div>
    </div>` : ''}

    <!-- Payment -->
    <div style="margin-top:4px;">
      <div style="font-size:9px;font-weight:700;letter-spacing:4px;color:#444;text-transform:uppercase;margin-bottom:8px;">Payment Method</div>
      <div style="font-size:13px;font-weight:700;color:${isPrepaid ? '#3d9e3d' : '#c9922a'};">
        ${isPrepaid ? '&#10003; Prepaid — Paid Online' : '&#9711; Cash on Delivery (COD)'}
      </div>
    </div>

  </div>

  <!-- FOOTER -->
  <div style="background:#0d0d0d;padding:32px;text-align:center;border-top:1px solid #1a1a1a;">
    <img src="${LOGO}" width="160" alt="CrosCrow" style="display:inline-block;margin-bottom:14px;border-radius:6px;">
    <div style="font-size:11px;color:#444;line-height:1.8;">Questions? Reach us on WhatsApp or reply to this email.</div>
    <div style="font-size:9px;color:#2a2a2a;margin-top:16px;letter-spacing:2px;text-transform:uppercase;">&#169; CrosCrow &middot; Automated Notification &middot; Do Not Reply</div>
  </div>

</div>
</body></html>`;
}

function templateNewOrderCustomer({ order }) {
  const isPrepaid = order.financial_status === 'paid';
  const waNum = (process.env.WHATSAPP_NUMBER || '').replace(/\D/g, '');
  const waLink = waNum ? `https://wa.me/${waNum}?text=${encodeURIComponent('Hi! I confirm my order ' + order.name + ' placed on CrosCrow. Please proceed.')}` : '#';
  const body = `
    <div class="subtitle">Thank you for your order! We've received it and it's pending confirmation.</div>

    <!-- WhatsApp Confirm Section -->
    <div style="background:#f0fdf4;border:2px solid #25d366;border-radius:10px;padding:20px 24px;margin-bottom:24px;">
      <table width="100%" cellpadding="0" cellspacing="0"><tr>
        <td width="48" valign="middle" style="padding-right:16px">${WA_ICON}</td>
        <td valign="middle">
          <div style="font-weight:700;color:#065f46;font-size:15px;margin-bottom:4px;">Check Your WhatsApp to Confirm Order</div>
          <div style="font-size:12px;color:#374151;line-height:1.6;margin-bottom:12px;">
            We've sent you a WhatsApp message to verify your order. Please open WhatsApp and tap the button below to confirm — your order will only be processed after confirmation.
          </div>
          <a href="${waLink}" style="display:inline-block;background:#25d366;color:#fff;text-decoration:none;padding:11px 24px;border-radius:7px;font-weight:700;font-size:13px;letter-spacing:0.5px;">
            ✅ Confirm Order
          </a>
        </td>
      </tr></table>
    </div>

    ${isPrepaid ? `<div style="background:#f0fdf4;border:2px solid #10b981;border-radius:8px;padding:12px 18px;margin-bottom:20px;text-align:center;font-weight:700;color:#065f46;font-size:14px;letter-spacing:1px;">✅ PREPAID ORDER — No payment due on delivery</div>` : ''}
    <div class="info-box">
      <div class="info-row"><span class="info-label">Order ID</span><span class="info-val">${order.name}</span></div>
      <div class="info-row"><span class="info-label">Date</span><span class="info-val">${new Date(order.created_at).toLocaleDateString('en-IN',{day:'numeric',month:'long',year:'numeric'})}</span></div>
      <div class="info-row"><span class="info-label">Payment</span><span class="info-val">${isPrepaid ? '✅ Prepaid' : '💵 Cash on Delivery'}</span></div>
      <div class="info-row"><span class="info-label">Order Total</span><span class="info-val" style="color:#10b981;font-size:16px;font-weight:800">₹${parseFloat(order.total_price).toFixed(2)}</span></div>
      ${order.shipping_address ? `<div class="info-row"><span class="info-label">Deliver To</span><span class="info-val">${order.shipping_address.name}, ${order.shipping_address.city}, ${order.shipping_address.province} ${order.shipping_address.zip}</span></div>` : ''}
    </div>
    ${itemsTableHtml(order.line_items || [])}
    <p style="font-size:12px;color:#9ca3af;line-height:1.7;margin-top:8px;">If you did not place this order, please ignore this email or contact us immediately.</p>
  `;
  return emailBase(`New Order Received: ${order.name} — Action Required`, '#25d366', body);
}

// Sent on orders/create webhook — heads up only, not yet confirmed
function templateNewOrderVendor({ order, vendorName }) {
  const myItems = (order.line_items || []).filter(li => li.vendor === vendorName);
  const subTotal = myItems.reduce((s, li) => s + parseFloat(li.price || 0) * (li.quantity || 1), 0);
  const body = `
    <div class="subtitle">A new order has been placed on CrosCrow that includes your products.</div>
    <div style="background:#f0f9ff;border:1px solid #bae6fd;border-radius:8px;padding:14px 18px;margin-bottom:20px;font-size:13px;color:#0c4a6e;line-height:1.7;">
      <strong>Please note —</strong> this is an early notification. Your order will be formally confirmed by the CrosCrow team shortly.
      You will receive a separate confirmation email once the order is verified and approved. <strong>Do not dispatch yet.</strong>
    </div>
    <div class="info-box">
      <div class="info-row"><span class="info-label">Order ID</span><span class="info-val" style="color:#6366f1;font-size:15px">${order.name}</span></div>
      <div class="info-row"><span class="info-label">Date</span><span class="info-val">${new Date(order.created_at).toLocaleDateString('en-IN',{day:'numeric',month:'long',year:'numeric'})}</span></div>
      <div class="info-row"><span class="info-label">Your Items Value</span><span class="info-val">₹${subTotal.toFixed(2)}</span></div>
      <div class="info-row"><span class="info-label">Items</span><span class="info-val">${myItems.length} product${myItems.length !== 1 ? 's' : ''}</span></div>
    </div>
    ${itemsTableHtml(myItems)}
    <div style="background:#f8fafc;border-radius:8px;padding:14px 18px;margin-bottom:16px;font-size:12px;color:#6b7280;line-height:1.8;">
      <strong style="color:#374151;">What happens next?</strong><br>
      1. CrosCrow reviews and confirms the order with the customer.<br>
      2. You receive a <strong>Confirmation Email</strong> with full dispatch instructions.<br>
      3. Pack and ship within 24–48 hours of the confirmation email.
    </div>
    <div style="text-align:center;margin-bottom:8px;">
      <a href="https://autoaijarvis1.onrender.com/" style="display:inline-block;background:#6366f1;color:#fff;text-decoration:none;font-weight:700;font-size:13px;padding:11px 28px;border-radius:8px;letter-spacing:0.5px;">Login to Vendor Panel →</a>
    </div>
  `;
  return emailBase(`New Order Received: ${order.name}`, '#1e40af', body);
}

// Sent when admin sets stage → confirmed — action required
function templateOrderConfirmedVendor({ order, vendorName, meta = {} }) {
  const isPrepaid   = order.financial_status === 'paid';
  const myItems     = (order.line_items || []).filter(li => li.vendor === vendorName);
  const subTotal    = myItems.reduce((s, li) => s + parseFloat(li.price || 0) * (li.quantity || 1), 0);
  const shipping    = parseFloat(order.total_shipping_price_set?.shop_money?.amount || 0);
  const advance     = parseFloat(meta.advance_paid || 0);
  const codAmount   = isPrepaid ? 0 : Math.max(0, subTotal + shipping - advance);
  const addr        = order.shipping_address;

  const body = `
    <div class="subtitle">Order <strong>${order.name}</strong> has been confirmed by CrosCrow. Please prepare and dispatch immediately.</div>

    ${isPrepaid
      ? `<div style="background:#f0fdf4;border:2px solid #10b981;border-radius:8px;padding:12px 18px;margin-bottom:16px;text-align:center;font-weight:700;color:#065f46;font-size:14px;letter-spacing:1px;">PREPAID — Payment collected. Do not collect cash on delivery.</div>`
      : advance > 0
        ? `<div style="background:#fffbeb;border:2px solid #f59e0b;border-radius:8px;padding:12px 18px;margin-bottom:16px;text-align:center;font-weight:700;color:#92400e;font-size:14px;letter-spacing:1px;">COD — Advance of ₹${advance.toFixed(2)} collected. Collect ₹${codAmount.toFixed(2)} on delivery.</div>`
        : `<div style="background:#fffbeb;border:2px solid #f59e0b;border-radius:8px;padding:12px 18px;margin-bottom:16px;text-align:center;font-weight:700;color:#92400e;font-size:14px;letter-spacing:1px;">COD — Collect ₹${codAmount.toFixed(2)} on delivery.</div>`
    }

    <div class="info-box">
      <div class="info-row"><span class="info-label">Order ID</span><span class="info-val" style="color:#6366f1;font-size:15px">${order.name}</span></div>
      <div class="info-row"><span class="info-label">Confirmed On</span><span class="info-val">${new Date().toLocaleDateString('en-IN',{day:'numeric',month:'long',year:'numeric'})}</span></div>
      <div class="info-row"><span class="info-label">Customer</span><span class="info-val">${addr?.name || order.email || '—'}</span></div>
      ${addr ? `<div class="info-row"><span class="info-label">Ship To</span><span class="info-val">${addr.address1}${addr.address2 ? ', '+addr.address2 : ''}, ${addr.city}, ${addr.province} ${addr.zip}</span></div>` : ''}
      ${addr?.phone ? `<div class="info-row"><span class="info-label">Customer Phone</span><span class="info-val">${addr.phone}</span></div>` : ''}
    </div>

    ${itemsTableHtml(myItems)}

    <table style="width:100%;border-collapse:collapse;margin-bottom:20px;font-size:13px;">
      <tr><td style="padding:7px 0;color:#6b7280;border-bottom:1px solid #f1f5f9">Items Subtotal</td><td style="text-align:right;padding:7px 0;border-bottom:1px solid #f1f5f9;font-weight:600">₹${subTotal.toFixed(2)}</td></tr>
      ${!isPrepaid ? `<tr><td style="padding:7px 0;color:#6b7280;border-bottom:1px solid #f1f5f9">Shipping</td><td style="text-align:right;padding:7px 0;border-bottom:1px solid #f1f5f9;font-weight:600">₹${shipping.toFixed(2)}</td></tr>` : ''}
      ${advance > 0 ? `<tr><td style="padding:7px 0;color:#10b981;border-bottom:1px solid #f1f5f9">Advance Collected</td><td style="text-align:right;padding:7px 0;border-bottom:1px solid #f1f5f9;font-weight:600;color:#10b981">− ₹${advance.toFixed(2)}</td></tr>` : ''}
      <tr style="background:#f8fafc"><td style="padding:10px;font-weight:800;font-size:14px;color:#1a2a3a;">Amount to Collect on Delivery</td>
        <td style="text-align:right;padding:10px;font-weight:800;font-size:16px;color:${isPrepaid ? '#10b981' : '#dc2626'}">
          ${isPrepaid ? '₹0.00 &nbsp;(Prepaid)' : `₹${codAmount.toFixed(2)}`}
        </td>
      </tr>
    </table>

    <div style="background:#fef2f2;border-left:4px solid #dc2626;border-radius:4px;padding:14px 18px;margin-bottom:16px;">
      <div style="font-weight:700;color:#991b1b;font-size:13px;margin-bottom:4px;">Dispatch Window — 24 to 48 Hours</div>
      <div style="font-size:12px;color:#7f1d1d;line-height:1.7;">Pack and hand over to courier within <strong>48 hours</strong>. Delays beyond this window may attract penalties. Dispatch within <strong>24 hours</strong> earns a seller reward.</div>
    </div>

    <div style="text-align:center;margin-bottom:12px;">
      <a href="https://wa.me/${process.env.WHATSAPP_NUMBER}?text=${encodeURIComponent(`Hi CrosCrow, I need help with order ${order.name}`)}"
         style="display:inline-flex;align-items:center;gap:8px;background:#25d366;color:#fff;text-decoration:none;font-weight:700;font-size:13px;padding:10px 22px;border-radius:8px;">
        <img src="https://upload.wikimedia.org/wikipedia/commons/6/6b/WhatsApp.svg" width="18" height="18" style="vertical-align:middle" alt="WhatsApp">
        Need help? Reach us on WhatsApp
      </a>
    </div>
    <div style="text-align:center;margin-bottom:8px;">
      <a href="https://autoaijarvis1.onrender.com/" style="display:inline-block;background:#6366f1;color:#fff;text-decoration:none;font-weight:700;font-size:13px;padding:11px 28px;border-radius:8px;letter-spacing:0.5px;">Login to Vendor Panel →</a>
    </div>
  `;
  return emailBase(`Order Confirmed: ${order.name} — Dispatch Now`, '#6366f1', body);
}

function templateInTransit({ order, awb, courier }) {
  const body = `
    <div class="subtitle">Your order is on its way!</div>
    <div class="info-box">
      <div class="info-row"><span class="info-label">Order ID</span><span class="info-val">${order.name}</span></div>
      <div class="info-row"><span class="info-label">Courier</span><span class="info-val">${courier || 'Our delivery partner'}</span></div>
      ${awb ? `<div class="info-row"><span class="info-label">Tracking AWB</span><span class="info-val" style="font-family:monospace;color:#6366f1">${awb}</span></div>` : ''}
      <div class="info-row"><span class="info-label">Deliver To</span><span class="info-val">${order.shipping_address?.city || ''}, ${order.shipping_address?.province || ''}</span></div>
    </div>
    ${itemsTableHtml(order.line_items || [])}
    ${awb && courier ? `<div style="text-align:center"><a class="cta" href="https://www.${(courier||'').toLowerCase().includes('delhivery') ? `delhivery.com/track/package/${awb}` : `shiprocket.co/tracking/${awb}`}">Track Your Order →</a></div>` : ''}
    <p style="font-size:13px;color:#6b7280;line-height:1.7">Estimated delivery in 3–7 business days. You'll receive another update once it's delivered.</p>
  `;
  return emailBase(`Your Order is Shipped! 🚚`, '#6366f1', body);
}

function templateVendorShipped({ order, vendorName, items, awb, courier, trackingUrl }) {
  const itemRows = (items || []).map(li =>
    `<div class="info-row"><span class="info-label">${li.title || li.name}</span><span class="info-val">Qty: ${li.quantity || li.qty || 1} — ₹${parseFloat(li.price||0).toFixed(2)}</span></div>`
  ).join('');
  const trackLink = trackingUrl || (courier && awb
    ? `https://www.${(courier||'').toLowerCase().includes('delhivery') ? `delhivery.com/track/package/${awb}` : `shiprocket.co/tracking/${awb}`}`
    : '');
  const body = `
    <div class="subtitle">Part of your order has left the facility and is on its way!</div>
    <div class="info-box">
      <div class="info-row"><span class="info-label">Order ID</span><span class="info-val">${order.name}</span></div>
      <div class="info-row"><span class="info-label">Shipped By</span><span class="info-val">${vendorName}</span></div>
      <div class="info-row"><span class="info-label">Courier</span><span class="info-val">${courier || 'Our delivery partner'}</span></div>
      ${awb ? `<div class="info-row"><span class="info-label">Tracking AWB</span><span class="info-val" style="font-family:monospace;color:#6366f1">${awb}</span></div>` : ''}
      <div class="info-row"><span class="info-label">Deliver To</span><span class="info-val">${order.shipping_address?.city || ''}, ${order.shipping_address?.province || ''}</span></div>
    </div>
    <div style="margin:18px 0 8px;font-weight:600;font-size:13px;color:#374151">Items Shipped</div>
    <div class="info-box">${itemRows}</div>
    ${trackLink ? `<div style="text-align:center;margin:20px 0"><a class="cta" href="${trackLink}">Track Your Shipment →</a></div>` : ''}
    <p style="font-size:13px;color:#6b7280;line-height:1.7">Your remaining items (if any) will be shipped separately. You'll get another update once everything is on its way.</p>
  `;
  return emailBase(`Your Items Have Shipped! 🚚`, '#6366f1', body);
}

function templateDelivered({ order, forRole = 'customer' }) {
  const titles = { customer: '🎉 Order Delivered!', vendor: `Order Delivered: ${order.name}`, admin: `Delivered: ${order.name}` };
  const subtitles = {
    customer: 'Your order has been successfully delivered.',
    vendor: 'This order has been marked as delivered.',
    admin: `Order ${order.name} has been delivered to the customer.`,
  };
  const body = `
    <div class="subtitle">${subtitles[forRole]}</div>
    <div class="info-box">
      <div class="info-row"><span class="info-label">Order ID</span><span class="info-val">${order.name}</span></div>
      <div class="info-row"><span class="info-label">Customer</span><span class="info-val">${order.shipping_address?.name || order.email}</span></div>
      <div class="info-row"><span class="info-label">Total</span><span class="info-val">₹${parseFloat(order.total_price).toFixed(2)}</span></div>
      <div class="info-row"><span class="info-label">Payment</span><span class="info-val">${order.financial_status === 'paid' ? '✅ Prepaid' : '💵 COD'}</span></div>
      ${order.shipping_address ? `<div class="info-row"><span class="info-label">Delivered To</span><span class="info-val">${order.shipping_address.city}, ${order.shipping_address.province}</span></div>` : ''}
    </div>
    ${itemsTableHtml(order.line_items || [])}
    ${forRole === 'customer' ? `<p style="font-size:13px;color:#6b7280;line-height:1.7">We hope you love your purchase! If you have any issues, please contact us.</p>` : ''}
    ${forRole === 'vendor' ? `<div style="text-align:center;margin-top:16px;"><a href="https://autoaijarvis1.onrender.com/" style="display:inline-block;background:#6366f1;color:#fff;text-decoration:none;font-weight:700;font-size:13px;padding:11px 28px;border-radius:8px;letter-spacing:0.5px;">Login to Vendor Panel →</a></div>` : ''}
  `;
  return emailBase(titles[forRole], '#10b981', body);
}

function templatePartialAdvanceVendor({ order, vendorName, meta = {} }) {
  const myItems     = (order.line_items || []).filter(li => li.vendor === vendorName);
  const subTotal    = myItems.reduce((s, li) => s + parseFloat(li.price || 0) * (li.quantity || 1), 0);
  const vendorCount = new Set((order.line_items || []).map(li => li.vendor).filter(Boolean)).size || 1;
  const totalShipping = parseFloat(order.total_shipping_price_set?.shop_money?.amount || (order.shipping_lines||[]).reduce((s,l)=>s+parseFloat(l.price||0),0));
  const shipping    = parseFloat((totalShipping / vendorCount).toFixed(2));
  const advance     = parseFloat(((meta.advance_paid || 0) / vendorCount).toFixed(2));
  const newCOD      = Math.max(0, subTotal + shipping - advance);
  const addr      = order.shipping_address;

  const body = `
    <div class="subtitle">Advance payment has been collected for order <strong>${order.name}</strong>. Please note the updated COD amount below.</div>

    <div style="background:#fffbeb;border:2px solid #f59e0b;border-radius:8px;padding:14px 18px;margin-bottom:20px;text-align:center">
      <div style="font-size:12px;color:#92400e;font-weight:600;margin-bottom:4px;">💵 UPDATED COD TO COLLECT ON DELIVERY</div>
      <div style="font-size:28px;font-weight:800;color:#b45309;">₹${newCOD.toFixed(2)}</div>
      <div style="font-size:11px;color:#92400e;margin-top:4px;">After deducting ₹${advance.toFixed(2)} advance (your share of ${vendorCount > 1 ? `total advance split across ${vendorCount} vendors` : 'advance collected'})</div>
    </div>

    <div class="info-box">
      <div class="info-row"><span class="info-label">Order ID</span><span class="info-val" style="color:#6366f1">${order.name}</span></div>
      <div class="info-row"><span class="info-label">Customer</span><span class="info-val">${addr?.name || order.email || '—'}</span></div>
      ${addr ? `<div class="info-row"><span class="info-label">Deliver To</span><span class="info-val">${addr.address1}${addr.address2?', '+addr.address2:''}, ${addr.city}, ${addr.province} ${addr.zip}</span></div>` : ''}
      ${addr?.phone ? `<div class="info-row"><span class="info-label">Phone</span><span class="info-val">${addr.phone}</span></div>` : ''}
    </div>

    ${itemsTableHtml(myItems)}

    <table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:20px;">
      <tr><td style="padding:7px 0;color:#6b7280;border-bottom:1px solid #f1f5f9">Items Subtotal</td><td style="text-align:right;padding:7px 0;border-bottom:1px solid #f1f5f9;font-weight:600">₹${subTotal.toFixed(2)}</td></tr>
      <tr><td style="padding:7px 0;color:#6b7280;border-bottom:1px solid #f1f5f9">Shipping Charge</td><td style="text-align:right;padding:7px 0;border-bottom:1px solid #f1f5f9;font-weight:600">₹${shipping.toFixed(2)}</td></tr>
      <tr><td style="padding:7px 0;color:#10b981;border-bottom:1px solid #f1f5f9">Advance Collected</td><td style="text-align:right;padding:7px 0;border-bottom:1px solid #f1f5f9;font-weight:600;color:#10b981">— ₹${advance.toFixed(2)}</td></tr>
      <tr style="background:#fffbeb"><td style="padding:10px;font-weight:800;font-size:14px;color:#92400e">💵 Collect on Delivery</td><td style="text-align:right;padding:10px;font-weight:800;font-size:18px;color:#b45309">₹${newCOD.toFixed(2)}</td></tr>
    </table>

    <p style="font-size:12px;color:#6b7280;line-height:1.7">Please ensure you collect exactly <strong>₹${newCOD.toFixed(2)}</strong> at the time of delivery. Do not collect the full amount — customer has already paid the advance.</p>

    <div style="background:#fef2f2;border-left:4px solid #dc2626;border-radius:4px;padding:14px 18px;margin-bottom:16px;">
      <div style="font-weight:700;color:#991b1b;font-size:13px;margin-bottom:4px;">Dispatch Window — 24 to 48 Hours</div>
      <div style="font-size:12px;color:#7f1d1d;line-height:1.7;">Pack and hand over to courier within <strong>48 hours</strong>. Delays beyond this window may attract penalties. Dispatch within <strong>24 hours</strong> earns a seller reward.</div>
    </div>

    <div style="text-align:center;margin-bottom:8px;">
      <a href="https://autoaijarvis1.onrender.com/" style="display:inline-block;background:#6366f1;color:#fff;text-decoration:none;font-weight:700;font-size:13px;padding:11px 28px;border-radius:8px;letter-spacing:0.5px;">Login to Vendor Panel →</a>
    </div>
  `;
  return emailBase(`Advance Collected: ${order.name} — Updated COD`, '#f59e0b', body);
}

function templatePartialAdvanceCustomer({ order, meta = {} }) {
  const allItems  = order.line_items || [];
  const subTotal  = allItems.reduce((s, li) => s + parseFloat(li.price || 0) * (li.quantity || 1), 0);
  const shipping  = parseFloat(order.total_shipping_price_set?.shop_money?.amount || (order.shipping_lines||[]).reduce((s,l)=>s+parseFloat(l.price||0),0));
  const advance   = parseFloat(meta.advance_paid || 0);
  const remaining = Math.max(0, subTotal + shipping - advance);
  const addr      = order.shipping_address;

  const body = `
    <!-- Hero drip -->
    <div style="text-align:center;padding:8px 0 24px">
      <div style="font-size:40px;margin-bottom:8px">🎉</div>
      <div style="font-size:22px;font-weight:800;color:#f8fafc;letter-spacing:-0.5px">You're almost there!</div>
      <div style="font-size:14px;color:#94a3b8;margin-top:6px;">Your advance payment has been received. Your order <strong style="color:#a5b4fc">${order.name}</strong> is confirmed and being prepared.</div>
    </div>

    <!-- Advance badge -->
    <div style="background:linear-gradient(135deg,#10b981 0%,#059669 100%);border-radius:12px;padding:18px 24px;margin-bottom:20px;text-align:center;">
      <div style="font-size:11px;font-weight:700;color:#d1fae5;letter-spacing:1.5px;text-transform:uppercase;margin-bottom:4px;">✅ Advance Received</div>
      <div style="font-size:32px;font-weight:800;color:#fff;">₹${advance.toFixed(2)}</div>
      <div style="font-size:12px;color:#a7f3d0;margin-top:4px;">Thank you for paying in advance — your order is secured!</div>
    </div>

    <!-- Delivery info -->
    <div class="info-box">
      <div class="info-row"><span class="info-label">Order</span><span class="info-val" style="color:#a5b4fc;font-weight:700">${order.name}</span></div>
      ${addr ? `<div class="info-row"><span class="info-label">Delivering To</span><span class="info-val">${addr.name ? addr.name+', ':''} ${addr.address1}${addr.address2?', '+addr.address2:''}, ${addr.city} ${addr.zip}</span></div>` : ''}
      ${addr?.phone ? `<div class="info-row"><span class="info-label">Contact</span><span class="info-val">${addr.phone}</span></div>` : ''}
    </div>

    ${itemsTableHtml(allItems)}

    <!-- Amount breakdown -->
    <table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:20px;">
      <tr><td style="padding:7px 0;color:#6b7280;border-bottom:1px solid #1e293b">Items Subtotal</td><td style="text-align:right;padding:7px 0;border-bottom:1px solid #1e293b;font-weight:600;color:#e2e8f0">₹${subTotal.toFixed(2)}</td></tr>
      <tr><td style="padding:7px 0;color:#6b7280;border-bottom:1px solid #1e293b">Shipping</td><td style="text-align:right;padding:7px 0;border-bottom:1px solid #1e293b;font-weight:600;color:#e2e8f0">₹${shipping.toFixed(2)}</td></tr>
      <tr><td style="padding:7px 0;color:#10b981;border-bottom:1px solid #1e293b">✅ Advance Paid</td><td style="text-align:right;padding:7px 0;border-bottom:1px solid #1e293b;font-weight:700;color:#10b981">− ₹${advance.toFixed(2)}</td></tr>
      ${remaining > 0
        ? `<tr style="background:#fffbeb"><td style="padding:12px 10px;font-weight:800;font-size:14px;color:#92400e;border-radius:6px 0 0 6px">💵 Pay on Delivery</td><td style="text-align:right;padding:12px 10px;font-weight:800;font-size:20px;color:#b45309;border-radius:0 6px 6px 0">₹${remaining.toFixed(2)}</td></tr>`
        : `<tr style="background:#f0fdf4"><td style="padding:12px 10px;font-weight:800;font-size:14px;color:#065f46;border-radius:6px 0 0 6px">✅ Fully Paid</td><td style="text-align:right;padding:12px 10px;font-weight:800;font-size:20px;color:#059669;border-radius:0 6px 6px 0">₹0.00</td></tr>`
      }
    </table>

    ${remaining > 0 ? `
    <div style="background:#1e293b;border:1px solid #334155;border-radius:8px;padding:14px 18px;margin-bottom:20px;font-size:13px;color:#94a3b8;line-height:1.7;text-align:center;">
      Please keep <strong style="color:#fbbf24">₹${remaining.toFixed(2)}</strong> ready to pay the delivery person when your order arrives. 🚚
    </div>` : ''}

    <p style="font-size:13px;color:#64748b;text-align:center;line-height:1.7">Questions? Reply to this email or reach us on WhatsApp anytime.</p>
  `;
  return emailBase(`Order Confirmed: ${order.name} — ₹${advance.toFixed(2)} Advance Received 🎉`, '#10b981', body);
}

// ── Send email helper ─────────────────────────────────────────────────────
async function sendEmail({ to, subject, html, shopifyId, trigger }) {
  const settingsRow = await ES.get();
  if (settingsRow && settingsRow.enabled === 0) {
    logEmail(shopifyId, trigger, to, subject, 'skipped', 'Emails disabled globally');
    return;
  }
  const cfg = await getSmtpConfig();
  if (!cfg?.host || !cfg?.user || !cfg?.pass) {
    logEmail(shopifyId, trigger, to, subject, 'skipped', 'SMTP not configured');
    return;
  }
  try {
    const transporter = createTransporter(cfg);
    await transporter.sendMail({ from: `"${cfg.fromName || 'CrosCrow'}" <${cfg.fromEmail || cfg.user}>`, to, subject, html });
    logEmail(shopifyId, trigger, to, subject, 'sent');
    console.log(`📧 Email sent [${trigger}] → ${to}`);
  } catch (err) {
    logEmail(shopifyId, trigger, to, subject, 'failed', err.message);
    console.error(`❌ Email failed [${trigger}] → ${to}:`, err.message);
  }
}

// ── Enrich order line items with product images ───────────────────────────
async function enrichOrderImages(order) {
  try {
    const token = await getAccessToken();
    const productIds = [...new Set((order.line_items || []).map(li => li.product_id).filter(Boolean))];
    const imageMap = {}; // { product_id: imageUrl }
    await Promise.all(productIds.map(async pid => {
      try {
        const d = await shopifyREST(`/products/${pid}.json?fields=id,image,variants,images`);
        if (d.product?.image?.src) imageMap[pid] = d.product.image.src;
        else if (d.product?.images?.[0]?.src) imageMap[pid] = d.product.images[0].src;
      } catch {}
    }));
    // Attach image to each line item
    order.line_items = (order.line_items || []).map(li => ({
      ...li,
      image_url: imageMap[li.product_id] || null,
    }));
  } catch {}
  return order;
}

// ── Fire emails on stage change ───────────────────────────────────────────
async function fireStageEmails(shopifyId, newStage) {
  try {
    const cfg = await getSmtpConfig();
    if (!cfg?.host) return; // no SMTP configured, skip silently

    const token = await getAccessToken();
    const r = await fetch(`https://${SHOP}.myshopify.com/admin/api/2025-01/orders/${shopifyId}.json`, {
      headers: { "X-Shopify-Access-Token": token }
    });
    if (!r.ok) return;
    let { order } = await r.json();
    order = await enrichOrderImages(order);
    const meta = await mdb.collection('order_meta').findOne({ shopify_id: String(shopifyId) }, { projection: { _id: 0 } }) || {};

    const adminEmail = cfg.adminEmail;
    const customerEmail = order.email;
    const vendors = [...new Set((order.line_items || []).map(li => li.vendor).filter(Boolean))];

    if (newStage === 'confirmed') {
      for (const vendor of vendors) {
        const vendorRow = await VC.get(vendor);
        const vendorMeta = await mdb.collection('order_meta').findOne({ shopify_id: String(order.id) }, { projection: { _id: 0 } }) || {};
        if (vendorRow?.email) await sendEmail({ to: vendorRow.email, subject: `Order Confirmed: ${order.name} — Dispatch Now`, html: templateOrderConfirmedVendor({ order, vendorName: vendor, meta: vendorMeta }), shopifyId, trigger: 'confirmed_vendor' });
      }
    }

    if (newStage === 'partial') {
      const vendorMeta = await mdb.collection('order_meta').findOne({ shopify_id: String(order.id) }, { projection: { _id: 0 } }) || {};
      // Customer email
      if (customerEmail) await sendEmail({
        to: customerEmail,
        subject: `Your Advance is Confirmed — ${order.name} 🎉`,
        html: templatePartialAdvanceCustomer({ order, meta: vendorMeta }),
        shopifyId, trigger: 'partial_customer'
      });
      // Vendor emails
      for (const vendor of vendors) {
        const vendorRow = await VC.get(vendor);
        if (vendorRow?.email) await sendEmail({
          to: vendorRow.email,
          subject: `Advance Collected — Updated COD for ${order.name}`,
          html: templatePartialAdvanceVendor({ order, vendorName: vendor, meta: vendorMeta }),
          shopifyId, trigger: 'partial_vendor'
        });
      }
    }

    if (newStage === 'transit') {
      if (customerEmail) await sendEmail({ to: customerEmail, subject: `Your Order is Shipped! 🚚 AWB: ${meta.awb || ''}`, html: templateInTransit({ order, awb: meta.awb, courier: meta.courier }), shopifyId, trigger: 'transit' });
    }

    if (newStage === 'delivered') {
      if (customerEmail) await sendEmail({ to: customerEmail, subject: `Your Order Has Been Delivered! 🎉`, html: templateDelivered({ order, forRole: 'customer' }), shopifyId, trigger: 'delivered_customer' });
      if (adminEmail)    await sendEmail({ to: adminEmail,    subject: `Delivered: ${order.name}`, html: templateDelivered({ order, forRole: 'admin' }), shopifyId, trigger: 'delivered_admin' });
      for (const vendor of vendors) {
        const vendorRow = await VC.get(vendor);
        if (vendorRow?.email) await sendEmail({ to: vendorRow.email, subject: `Order Delivered: ${order.name}`, html: templateDelivered({ order, forRole: 'vendor' }), shopifyId, trigger: 'delivered_vendor' });
      }
    }
  } catch (err) {
    console.error('❌ fireStageEmails:', err.message);
  }
}

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
  const metas     = Object.fromEntries((await mdb.collection('order_meta').find({}, { projection: { _id: 0 } }).toArray()).map(m=>[m.shopify_id,m]));

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
    const allSettl = await mdb.collection('settlements').find({}, { projection: { status: 1, net_payable: 1, _id: 0 } }).toArray();
    const grouped = {};
    allSettl.forEach(s => {
      if (!grouped[s.status]) grouped[s.status] = { status: s.status, count: 0, total: 0 };
      grouped[s.status].count++;
      grouped[s.status].total = parseFloat((grouped[s.status].total + (s.net_payable || 0)).toFixed(2));
    });
    return Object.values(grouped);
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

    const metas   = await mdb.collection('order_meta').find({}, { projection: { _id: 0 } }).toArray();
    const metaMap = Object.fromEntries(metas.map(m => [m.shopify_id, m]));
    const vStages = await mdb.collection('order_vendor_stage').find({ vendor_name: req.vendor }, { projection: { shopify_id: 1, stage: 1, awb: 1, courier: 1, tracking_url: 1, _id: 0 } }).toArray();
    const vStageMap = Object.fromEntries(vStages.map(r => [r.shopify_id, r]));

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
          stage:        vStageMap[String(o.id)]?.stage || meta.stage || "new",
          financial:    o.financial_status ?? "—",
          tags:         o.tags ?? "",
          currency:     o.currency ?? "INR",
          myRevenue:    parseFloat(myRevenue.toFixed(2)),
          shippingCharge,
          advancePaid,
          totalCollectable: parseFloat((myRevenue + shippingCharge).toFixed(2)),
          remainingCOD:     parseFloat(Math.max(0, myRevenue + shippingCharge - advancePaid).toFixed(2)),
          awb:          vStageMap[String(o.id)]?.awb || meta.awb || (o.fulfillments||[]).find(f=>f.tracking_number)?.tracking_number || "",
          courier:      vStageMap[String(o.id)]?.courier || meta.courier || (o.fulfillments||[]).find(f=>f.tracking_company)?.tracking_company || "",
          trackingUrl:  vStageMap[String(o.id)]?.tracking_url || meta.tracking_url || (o.fulfillments||[]).find(f=>f.tracking_url)?.tracking_url || "",
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
// Partially fulfills ONLY this vendor's line items — not the whole order
app.post("/vendor/orders/:shopifyId/fulfill", vendorAuth, async (req, res) => {
  const { shopifyId } = req.params;
  const vendorName = req.vendor; // set by vendorAuth middleware
  const { courier, awb, trackingUrl } = req.body || {};
  if (!awb) return res.status(400).json({ error: "AWB / tracking number is required." });

  try {
    const token = await getAccessToken();

    // Step 1: fetch full order to know which line items belong to this vendor
    const orderRes = await shopifyREST(`/orders/${shopifyId}.json?fields=id,name,email,line_items,shipping_address,financial_status`);
    const order = orderRes?.order;
    if (!order) return res.status(404).json({ error: "Order not found." });

    const vendorLineItems = (order.line_items || []).filter(li =>
      (li.vendor || '').toLowerCase() === vendorName.toLowerCase()
    );
    if (!vendorLineItems.length) return res.status(400).json({ error: `No line items found for vendor ${vendorName}.` });
    const vendorLineItemIds = new Set(vendorLineItems.map(li => li.id));

    // Step 2: fetch fulfillment orders and match only this vendor's FO line items
    const foRes = await fetch(
      `https://${SHOP}.myshopify.com/admin/api/2025-01/orders/${shopifyId}/fulfillment_orders.json`,
      { headers: { "X-Shopify-Access-Token": token } }
    );
    if (!foRes.ok) throw new Error(`Could not get fulfillment orders: ${foRes.status}`);
    const foData = await foRes.json();
    const openFOs = (foData.fulfillment_orders || []).filter(fo => fo.status === "open");
    if (!openFOs.length) return res.status(400).json({ error: "No open fulfillment orders found. Items may already be fulfilled." });

    // Build line_items_by_fulfillment_order with only this vendor's items
    const line_items_by_fulfillment_order = [];
    for (const fo of openFOs) {
      const matchingItems = (fo.line_items || []).filter(foli => vendorLineItemIds.has(foli.line_item_id));
      if (matchingItems.length) {
        line_items_by_fulfillment_order.push({
          fulfillment_order_id: fo.id,
          fulfillment_order_line_items: matchingItems.map(foli => ({ id: foli.id, quantity: foli.quantity })),
        });
      }
    }
    if (!line_items_by_fulfillment_order.length) {
      return res.status(400).json({ error: "Your items are already fulfilled or not found in open fulfillment orders." });
    }

    // Step 3: create partial fulfillment on Shopify
    const fulfillBody = {
      fulfillment: {
        line_items_by_fulfillment_order,
        tracking_info: { number: awb, url: trackingUrl || "", company: courier || "" },
        notify_customer: false, // we send our own email
      },
    };
    const fRes = await fetch(
      `https://${SHOP}.myshopify.com/admin/api/2025-01/fulfillments.json`,
      { method: "POST", headers: { "X-Shopify-Access-Token": token, "Content-Type": "application/json" }, body: JSON.stringify(fulfillBody) }
    );
    if (!fRes.ok) {
      const err = await fRes.json().catch(() => ({}));
      throw new Error(JSON.stringify(err.errors || err));
    }
    const fData = await fRes.json();

    // Step 4: save AWB to this vendor's stage record only
    await OVS.upsert(shopifyId, vendorName, {
      stage: 'pickup', awb, courier: courier || '', tracking_url: trackingUrl || '',
      updated_at: new Date().toISOString(),
    });
    auditLog("vendor", "vendor_fulfill", shopifyId, { vendorName, awb, courier });

    // Step 5: email customer about this vendor's shipment
    const cfg = await getSmtpConfig();
    if (cfg && order.email) {
      await sendEmail({
        to: order.email,
        subject: `Your Items from ${vendorName} Have Shipped! 🚚`,
        html: templateVendorShipped({ order, vendorName, items: vendorLineItems, awb, courier, trackingUrl }),
        shopifyId, trigger: 'vendor_shipped',
      });
    }

    console.log(`📦 Vendor fulfill: order ${order.name}, vendor: ${vendorName}, AWB: ${awb}`);
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

// ── POST /admin/orders/:id/tag ────────────────────────────────────────────
app.post("/admin/orders/:id/tag", adminAuth, async (req, res) => {
  const { id } = req.params;
  const { tags } = req.body || {};
  if (tags === undefined) return res.status(400).json({ error: "tags field required." });
  try {
    const token = await getAccessToken();
    const r = await fetch(
      `https://${SHOP}.myshopify.com/admin/api/2025-01/orders/${id}.json`,
      { method: "PUT", headers: { "X-Shopify-Access-Token": token, "Content-Type": "application/json" },
        body: JSON.stringify({ order: { id, tags } }) }
    );
    if (!r.ok) throw new Error(`Shopify error ${r.status}`);
    const d = await r.json();
    // Re-apply tag mappings with new tags
    applyTagMappings(id, d.order.tags, d.order.financial_status);
    auditLog("admin", "update_tags", id, { tags });
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
    const metas  = await mdb.collection('order_meta').find({}, { projection: { _id: 0 } }).toArray();
    const metaMap = Object.fromEntries(metas.map(m => [m.shopify_id, m]));

    const STAGES = ["new","confirmed","partial","ready","pickup","transit","delivered","rto","hold","cancelled"];
    const stageCounts = Object.fromEntries(STAGES.map(s => [s, 0]));
    let totalRevenue = 0;

    raw.forEach(o => {
      const meta  = metaMap[String(o.id)];
      const stage = meta?.stage || "new";
      if (stageCounts[stage] !== undefined) stageCounts[stage]++;
      totalRevenue += parseFloat(o.total_price || 0);
    });

    const pendDocs = await mdb.collection('settlements').find({ status: 'pending' }, { projection: { commission: 1, gst_amount: 1, _id: 0 } }).toArray();
    const pendRow = { t: pendDocs.reduce((s, d) => s + (d.commission || 0) + (d.gst_amount || 0), 0) };
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

// ── GET /admin/analytics ─────────────────────────────────────────────────
app.get("/admin/analytics", adminAuth, async (req, res) => {
  try {
    const raw     = await fetchAllOrders("any", "2000-01-01T00:00:00Z", null);
    const metas   = await mdb.collection('order_meta').find({}, { projection: { _id: 0 } }).toArray();
    const metaMap = Object.fromEntries(metas.map(m => [m.shopify_id, m]));

    const now      = Date.now();
    const DAY      = 86400000;
    const today    = new Date(); today.setHours(0,0,0,0);

    // ── Selected period (from query params, default last 30d)
    const fromParam = req.query.from;
    const toParam   = req.query.to;
    const periodFrom = fromParam ? new Date(fromParam+'T00:00:00') : new Date(now - 29*DAY);
    const periodTo   = toParam   ? new Date(toParam+'T23:59:59')   : new Date();
    // Prior period of same length for growth comparison
    const periodLen  = periodTo - periodFrom;
    const priorFrom  = new Date(periodFrom - periodLen);
    const priorTo    = new Date(periodFrom - 1);

    // ── Helpers
    const isCOD    = o => o.financial_status !== 'paid';
    const isPrepaid = o => o.financial_status === 'paid';
    const isPartial = o => o.financial_status === 'partially_paid';
    const inWindow  = (o, from, to) => { const d=new Date(o.created_at); return d>=from && d<=to; };

    // ── Revenue & order counts by window
    const ordersToday  = raw.filter(o => new Date(o.created_at) >= today);
    const orders7d     = raw.filter(o => new Date(o.created_at) >= new Date(now - 6*DAY));
    const ordersMain   = raw.filter(o => inWindow(o, periodFrom, periodTo));
    const ordersPrior  = raw.filter(o => inWindow(o, priorFrom,  priorTo));
    // keep orders30d alias for fulfillment/payment stats
    const orders30d    = ordersMain;

    const rev = arr => parseFloat(arr.reduce((s,o)=>s+parseFloat(o.total_price||0),0).toFixed(2));

    // Growth: compare selected period vs prior period of same length
    const revMain  = rev(ordersMain);
    const revPrior = rev(ordersPrior);
    const revenueGrowth = revPrior > 0 ? parseFloat(((revMain - revPrior)/revPrior*100).toFixed(1)) : null;
    const orderGrowth   = ordersPrior.length > 0 ? parseFloat(((ordersMain.length - ordersPrior.length)/ordersPrior.length*100).toFixed(1)) : null;

    // ── Fulfillment stats (30d)
    const fulfillStats = (() => {
      let fulfilled=0, unfulfilled=0, partial_ship=0, cancelled=0, rto=0;
      orders30d.forEach(o => {
        const meta  = metaMap[String(o.id)] || {};
        const stage = meta.stage || 'new';
        if (stage === 'delivered' || stage === 'transit' || o.fulfillment_status === 'fulfilled') fulfilled++;
        else if (o.cancelled_at || stage === 'cancelled') cancelled++;
        else if (stage === 'rto') rto++;
        else if (o.fulfillment_status === 'partial') partial_ship++;
        else unfulfilled++;
      });
      const total = orders30d.length || 1;
      return { fulfilled, unfulfilled, partial_ship, cancelled, rto,
               fulfill_rate: Math.round(fulfilled/total*100) };
    })();

    // ── Payment split (30d)
    const paymentSplit = {
      prepaid: orders30d.filter(isPrepaid).length,
      cod:     orders30d.filter(o => !isPrepaid(o) && !isPartial(o)).length,
      partial: orders30d.filter(isPartial).length,
    };

    // ── Top products by quantity sold (all time)
    const productMap = {};
    raw.forEach(o => {
      (o.line_items || []).forEach(li => {
        const key = li.product_id || li.title;
        if (!productMap[key]) productMap[key] = { title: li.title, vendor: li.vendor || '—', qty: 0, revenue: 0, orders: new Set() };
        productMap[key].qty     += li.quantity || 1;
        productMap[key].revenue += parseFloat(li.price || 0) * (li.quantity || 1);
        productMap[key].orders.add(String(o.id));
      });
    });
    const topProducts = Object.values(productMap)
      .map(p => ({ ...p, orders: p.orders.size, revenue: parseFloat(p.revenue.toFixed(2)) }))
      .sort((a,b) => b.qty - a.qty)
      .slice(0, 10);

    // ── Top brands/vendors by revenue (all time)
    const brandMap = {};
    raw.forEach(o => {
      (o.line_items || []).forEach(li => {
        const vn = li.vendor || 'Unknown';
        if (!brandMap[vn]) brandMap[vn] = { name: vn, qty: 0, revenue: 0, orders: new Set() };
        brandMap[vn].qty     += li.quantity || 1;
        brandMap[vn].revenue += parseFloat(li.price || 0) * (li.quantity || 1);
        brandMap[vn].orders.add(String(o.id));
      });
    });
    const topBrands = Object.values(brandMap)
      .map(b => ({ ...b, orders: b.orders.size, revenue: parseFloat(b.revenue.toFixed(2)) }))
      .sort((a,b) => b.revenue - a.revenue)
      .slice(0, 8);

    // ── Daily revenue trend — span of selected period (cap at 90 days)
    const trendFrom = new Date(Math.max(periodFrom.getTime(), now - 89*DAY));
    const trendDays = Math.round((periodTo - trendFrom) / DAY) + 1;
    const trendMap = {};
    for (let i = 0; i < trendDays; i++) {
      const d = new Date(trendFrom.getTime() + i * DAY);
      const key = d.toISOString().slice(0,10);
      trendMap[key] = { date: key, orders: 0, revenue: 0 };
    }
    ordersMain.forEach(o => {
      const key = o.created_at.slice(0,10);
      if (trendMap[key]) {
        trendMap[key].orders++;
        trendMap[key].revenue = parseFloat((trendMap[key].revenue + parseFloat(o.total_price||0)).toFixed(2));
      }
    });
    const trend14d = Object.values(trendMap);

    // ── AOV
    const aovMain = ordersMain.length ? parseFloat((revMain/ordersMain.length).toFixed(2)) : 0;
    const aov7    = orders7d.length   ? parseFloat((rev(orders7d)/orders7d.length).toFixed(2)) : 0;

    // ── RTO rate (selected period)
    const rtoCountMain = ordersMain.filter(o => (metaMap[String(o.id)] || {}).stage === 'rto').length;
    const rtoRate30    = ordersMain.length ? parseFloat((rtoCountMain/ordersMain.length*100).toFixed(1)) : 0;

    // ── Repeat customers (all time orders with same email > 1)
    const custMap = {};
    raw.forEach(o => { const e = o.email||o.customer?.email; if(e){if(!custMap[e])custMap[e]=0;custMap[e]++;} });
    const totalCustomers  = Object.keys(custMap).length;
    const repeatCustomers = Object.values(custMap).filter(c=>c>1).length;
    const repeatRate      = totalCustomers ? parseFloat((repeatCustomers/totalCustomers*100).toFixed(1)) : 0;

    // ── Top cities (30d)
    const cityMap = {};
    orders30d.forEach(o => {
      const city = o.shipping_address?.city;
      if (city) { cityMap[city] = (cityMap[city]||0) + 1; }
    });
    const topCities = Object.entries(cityMap).sort((a,b)=>b[1]-a[1]).slice(0,8).map(([city,count])=>({city,count}));

    // ── Stage counts for selected period
    const STAGE_LIST = ["new","confirmed","partial","ready","pickup","transit","delivered","rto","hold","cancelled","penalty"];
    const stageCounts = Object.fromEntries(STAGE_LIST.map(s=>[s,0]));
    ordersMain.forEach(o => {
      const s = (metaMap[String(o.id)] || {}).stage || 'new';
      if (stageCounts[s] !== undefined) stageCounts[s]++;
    });

    // ── All-time totals (always show regardless of period)
    const pendDocs = await mdb.collection('settlements').find({ status: 'pending' }, { projection: { commission: 1, gst_amount: 1, _id: 0 } }).toArray();
    const pendRow = { t: pendDocs.reduce((s, d) => s + (d.commission || 0) + (d.gst_amount || 0), 0) };
    const allTimeTotals = {
      orders:  raw.length,
      revenue: rev(raw),
      pendingCommission: parseFloat((pendRow?.t || 0).toFixed(2)),
    };

    const periodDays = Math.round((periodTo - periodFrom) / DAY) + 1;

    res.json({
      summary: {
        today:        { orders: ordersToday.length, revenue: rev(ordersToday) },
        last7d:       { orders: orders7d.length,    revenue: rev(orders7d),   aov: aov7 },
        period:       { orders: ordersMain.length,  revenue: revMain,         aov: aovMain,
                        from: fromParam || periodFrom.toISOString().slice(0,10),
                        to:   toParam   || periodTo.toISOString().slice(0,10),
                        days: periodDays },
        revenueGrowth, orderGrowth, rtoRate30,
        repeatRate, totalCustomers, repeatCustomers,
      },
      stageCounts,
      allTimeTotals,
      fulfillStats,
      paymentSplit,
      topProducts,
      topBrands,
      topCities,
      trend14d,
    });
  } catch (err) {
    console.error("❌ /admin/analytics:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /admin/orders ─────────────────────────────────────────────────────
app.get("/admin/orders", adminAuth, async (req, res) => {
  try {
    const { stage, vendor, created_at_min, created_at_max } = req.query;
    const raw    = await fetchAllOrders("any", created_at_min || "2000-01-01T00:00:00Z", created_at_max || null);
    const metas  = await mdb.collection('order_meta').find({}, { projection: { _id: 0 } }).toArray();
    const metaMap = Object.fromEntries(metas.map(m => [m.shopify_id, m]));
    const allVS  = await mdb.collection('order_vendor_stage').find({}, { projection: { shopify_id: 1, vendor_name: 1, stage: 1, awb: 1, courier: 1, tracking_url: 1, stage_started_at: 1, penalty_triggered: 1, warning_sent: 1, _id: 0 } }).toArray();
    const vsMap  = {}; // { shopify_id: { vendor_name: stage } }
    const vtMap  = {}; // { shopify_id: { vendor_name: { awb, courier, tracking_url } } }
    const vpMap  = {}; // { shopify_id: { vendor_name: { stageStartedAt, penaltyTriggered, warningSent } } }
    allVS.forEach(r => {
      if (!vsMap[r.shopify_id]) vsMap[r.shopify_id] = {};
      vsMap[r.shopify_id][r.vendor_name] = r.stage;
      if (r.awb || r.courier || r.tracking_url) {
        if (!vtMap[r.shopify_id]) vtMap[r.shopify_id] = {};
        vtMap[r.shopify_id][r.vendor_name] = { awb: r.awb || '', courier: r.courier || '', trackingUrl: r.tracking_url || '' };
      }
      if (r.stage_started_at > 0) {
        if (!vpMap[r.shopify_id]) vpMap[r.shopify_id] = {};
        vpMap[r.shopify_id][r.vendor_name] = { stageStartedAt: r.stage_started_at, penaltyTriggered: r.penalty_triggered || 0, warningSent: r.warning_sent || 0 };
      }
    });

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
        vendorStages:   vendors.length > 1
        ? Object.fromEntries(vendors.map(v => [v, vsMap[String(o.id)]?.[v] || meta.stage || 'new']))
        : (vsMap[String(o.id)] || {}),
        vendorTracking: vtMap[String(o.id)] || {},
        vendorPenalty:  vpMap[String(o.id)] || {},
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

    if (stage && stage !== "all") orders = orders.filter(o =>
      o.stage === stage || Object.values(o.vendorStages).includes(stage)
    );
    if (vendor) orders = orders.filter(o => o.vendors.some(v => v.toLowerCase() === vendor.toLowerCase()));

    res.json({ orders, total: orders.length });
  } catch (err) {
    console.error("❌ /admin/orders:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── PUT /admin/orders/:id/stage ───────────────────────────────────────────
app.put("/admin/orders/:id/stage", adminAuth, async (req, res) => {
  const { id } = req.params;
  const { stage } = req.body || {};
  const VALID = ["new","confirmed","partial","ready","pickup","transit","delivered","rto","hold","cancelled"];
  if (!VALID.includes(stage)) return res.status(400).json({ error: "Invalid stage." });

  const now = new Date().toISOString();
  const nowMs = Date.now();
  await OM.upsert(id, { stage, updated_at: now });

  // Sync order-level stage into per-vendor records for penalty cron.
  // Never downgrade a vendor who already submitted tracking (ready/pickup/transit/delivered).
  const ADVANCED = ['ready','pickup','transit','delivered','rto','cancelled'];
  const fulfilledStages = ['pickup','transit','delivered','rto','cancelled'];
  try {
    const od = await shopifyREST(`/orders/${id}.json?fields=id,line_items`);
    const vendors = [...new Set((od?.order?.line_items || []).map(li => li.vendor).filter(Boolean))];
    for (const vendor of vendors) {
      const existing = await mdb.collection('order_vendor_stage').findOne({ shopify_id: id, vendor_name: vendor }, { projection: { stage: 1, stage_started_at: 1, warning_sent: 1, penalty_triggered: 1, _id: 0 } });
      // If this vendor is already ahead (tracking submitted), only allow explicit forward movement
      if (existing && ADVANCED.includes(existing.stage) && !ADVANCED.includes(stage)) continue;
      const newStartedAt = ['confirmed','partial'].includes(stage) ? (existing?.stage_started_at || nowMs) : (existing?.stage_started_at || 0);
      const newWarning   = fulfilledStages.includes(stage) ? 0 : (existing?.warning_sent || 0);
      const newPenalty   = fulfilledStages.includes(stage) ? 0 : (existing?.penalty_triggered || 0);
      await OVS.upsert(id, vendor, { stage, updated_at: now, stage_started_at: newStartedAt, warning_sent: newWarning, penalty_triggered: newPenalty });
    }
  } catch(e) { console.error('vendor stage sync error:', e.message); }

  auditLog("admin", "stage_change", id, { stage });
  fireStageEmails(id, stage).catch(()=>{});
  res.json({ success: true, stage });
});

// ── PUT /admin/orders/:id/vendor-stage — set stage for one vendor in an order ──
app.put("/admin/orders/:id/vendor-stage", adminAuth, async (req, res) => {
  const { id } = req.params;
  const { vendor_name, stage } = req.body || {};
  const VALID = ["new","confirmed","partial","ready","pickup","transit","delivered","rto","hold","cancelled"];
  if (!vendor_name) return res.status(400).json({ error: "vendor_name required." });
  if (!VALID.includes(stage)) return res.status(400).json({ error: "Invalid stage." });

  const now = new Date().toISOString();
  const nowMs = Date.now();
  const fulfilledStages = ['pickup','transit','delivered','rto','cancelled'];
  const existing = await mdb.collection('order_vendor_stage').findOne({ shopify_id: id, vendor_name }, { projection: { _id: 0 } });

  const newStartedAt = ['confirmed','partial'].includes(stage) ? nowMs : (existing?.stage_started_at || 0);
  const newWarning   = fulfilledStages.includes(stage) ? 0 : (['confirmed','partial'].includes(stage) ? 0 : (existing?.warning_sent || 0));
  const newPenalty   = fulfilledStages.includes(stage) ? 0 : (existing?.penalty_triggered || 0);

  await OVS.upsert(id, vendor_name, { stage, updated_at: now, stage_started_at: newStartedAt, warning_sent: newWarning, penalty_triggered: newPenalty });
  auditLog("admin", "vendor_stage_change", id, { vendor_name, stage });
  res.json({ success: true, vendor_name, stage });
});

// ── GET /admin/orders/:id/vendor-stages ──────────────────────────────────
app.get("/admin/orders/:id/vendor-stages", adminAuth, async (req, res) => {
  const rows = await mdb.collection('order_vendor_stage').find({ shopify_id: req.params.id }, { projection: { vendor_name: 1, stage: 1, updated_at: 1, _id: 0 } }).toArray();
  res.json({ vendorStages: Object.fromEntries(rows.map(r => [r.vendor_name, r.stage])) });
});

// ── POST /admin/orders/:id/fulfill-vendor ────────────────────────────────
// Partially fulfill only a specific vendor's line items on Shopify, save AWB, send customer email
app.post("/admin/orders/:id/fulfill-vendor", adminAuth, async (req, res) => {
  const shopifyId = req.params.id;
  const { vendor_name, awb, courier, tracking_url } = req.body || {};
  if (!vendor_name) return res.status(400).json({ error: "vendor_name required." });
  if (!awb) return res.status(400).json({ error: "AWB / tracking number required." });

  try {
    const token = await getAccessToken();

    // Fetch the full order to identify vendor's line items
    const orderRes = await shopifyREST(`/orders/${shopifyId}.json?fields=id,name,email,line_items,shipping_address,financial_status`);
    const order = orderRes?.order;
    if (!order) return res.status(404).json({ error: "Order not found on Shopify." });

    const vendorLineItems = (order.line_items || []).filter(li => li.vendor === vendor_name);
    if (!vendorLineItems.length) return res.status(400).json({ error: `No line items found for vendor ${vendor_name}.` });
    const vendorLineItemIds = new Set(vendorLineItems.map(li => li.id));

    // Fetch fulfillment orders
    const foRes = await fetch(
      `https://${SHOP}.myshopify.com/admin/api/2025-01/orders/${shopifyId}/fulfillment_orders.json`,
      { headers: { "X-Shopify-Access-Token": token } }
    );
    if (!foRes.ok) throw new Error(`Could not fetch fulfillment orders: ${foRes.status}`);
    const foData = await foRes.json();
    const openFOs = (foData.fulfillment_orders || []).filter(fo => fo.status === "open");
    if (!openFOs.length) return res.status(400).json({ error: "No open fulfillment orders. Order may already be fully fulfilled." });

    // Filter FO line items that belong to this vendor
    const line_items_by_fulfillment_order = [];
    for (const fo of openFOs) {
      const matchingItems = (fo.line_items || []).filter(foli => vendorLineItemIds.has(foli.line_item_id));
      if (matchingItems.length) {
        line_items_by_fulfillment_order.push({
          fulfillment_order_id: fo.id,
          fulfillment_order_line_items: matchingItems.map(foli => ({ id: foli.id, quantity: foli.quantity })),
        });
      }
    }
    if (!line_items_by_fulfillment_order.length) return res.status(400).json({ error: "Vendor items already fulfilled or not found in open fulfillment orders." });

    // Create Shopify partial fulfillment
    const fulfillBody = {
      fulfillment: {
        line_items_by_fulfillment_order,
        tracking_info: { number: awb, url: tracking_url || "", company: courier || "" },
        notify_customer: false,
      },
    };
    const fRes = await fetch(
      `https://${SHOP}.myshopify.com/admin/api/2025-01/fulfillments.json`,
      { method: "POST", headers: { "X-Shopify-Access-Token": token, "Content-Type": "application/json" }, body: JSON.stringify(fulfillBody) }
    );
    if (!fRes.ok) {
      const errBody = await fRes.json().catch(() => ({}));
      throw new Error(JSON.stringify(errBody.errors || errBody));
    }
    const fData = await fRes.json();

    // Save AWB/courier/tracking to order_vendor_stage
    await OVS.upsert(shopifyId, vendor_name, { awb, courier: courier || '', tracking_url: tracking_url || '', stage: 'pickup', updated_at: new Date().toISOString() });
    auditLog("admin", "vendor_fulfill", shopifyId, { vendor_name, awb, courier });

    // Send customer shipped email
    const cfg = await getSmtpConfig();
    if (cfg && order.email) {
      const html = templateVendorShipped({ order, vendorName: vendor_name, items: vendorLineItems, awb, courier, trackingUrl: tracking_url });
      await sendEmail({ to: order.email, subject: `Your Items from ${vendor_name} Have Shipped! 🚚`, html, shopifyId, trigger: 'vendor_shipped' });
    }

    res.json({ success: true, fulfillment: fData.fulfillment });
  } catch (err) {
    console.error("❌ /admin/fulfill-vendor:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── PUT /admin/orders/:id/meta ────────────────────────────────────────────
app.put("/admin/orders/:id/meta", adminAuth, async (req, res) => {
  const { id } = req.params;
  const { payment_type, advance_paid, shipping_charge, notes, awb, courier, tracking_url } = req.body || {};
  const now = new Date().toISOString();
  const advPaid = parseFloat(advance_paid) || 0;

  // Build update fields (only set non-null values, preserve existing)
  const existing = await mdb.collection('order_meta').findOne({ shopify_id: id }, { projection: { _id: 0 } }) || {};
  const fields = {
    payment_type:    payment_type    ?? existing.payment_type    ?? 'cod',
    advance_paid:    advPaid         || existing.advance_paid    || 0,
    shipping_charge: shipping_charge ?? existing.shipping_charge ?? 0,
    notes:           notes           ?? existing.notes           ?? '',
    awb:             awb             ?? existing.awb             ?? '',
    courier:         courier         ?? existing.courier         ?? '',
    tracking_url:    tracking_url    ?? existing.tracking_url    ?? '',
    updated_at:      now,
  };
  await OM.upsert(id, fields);

  // Auto-move to partial stage when advance is filled in
  if (advPaid > 0) {
    const prevStage = existing.stage || 'new';
    const EARLY_STAGES = ["new", "confirmed", "partial"];
    if (EARLY_STAGES.includes(prevStage)) {
      await OM.upsert(id, { stage: 'partial', updated_at: now });
      fireStageEmails(id, "partial").catch(() => {});
    }
  }

  // Auto-advance all vendors who are still in pre-dispatch stages to 'ready'
  // when an AWB is saved at the order level
  if (awb && awb.trim()) {
    const PRE_DISPATCH = ['new','confirmed','partial','hold'];
    try {
      const od = await shopifyREST(`/orders/${id}.json?fields=id,line_items`);
      const vendors = [...new Set((od?.order?.line_items || []).map(li => li.vendor).filter(Boolean))];
      for (const vendor of vendors) {
        const ovs = await mdb.collection('order_vendor_stage').findOne({ shopify_id: id, vendor_name: vendor }, { projection: { stage: 1, _id: 0 } });
        const curStage = ovs?.stage || existing.stage || 'new';
        if (PRE_DISPATCH.includes(curStage)) {
          await OVS.upsert(id, vendor, { stage: 'ready', awb: awb.trim(), courier: courier || '', tracking_url: tracking_url || '', updated_at: now });
        }
      }
    } catch(e) { console.error('meta awb vendor sync error:', e.message); }
  }

  auditLog("admin", "meta_update", id, req.body);
  res.json({ success: true });
});

// ── GET /admin/vendors ────────────────────────────────────────────────────
app.get("/admin/vendors", adminAuth, async (req, res) => {
  try {
    const vendors  = await getVendorList();
    const configs  = await VC.all();
    const cfgMap   = Object.fromEntries(configs.map(c => [c.vendor_name, c]));
    const profiles = await mdb.collection('vendor_profiles').find({}, { projection: { vendor_name: 1, email: 1, _id: 0 } }).toArray();
    const profMap  = Object.fromEntries(profiles.map(p => [p.vendor_name, p]));
    res.json({ vendors: vendors.map(v => ({
      name:           v,
      commission_pct: cfgMap[v]?.commission_pct ?? 20,
      active:         cfgMap[v]?.active ?? 1,
      email:          cfgMap[v]?.email || profMap[v]?.email || '',
    }))});
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── PUT /admin/vendors/:name/config ──────────────────────────────────────
app.put("/admin/vendors/:name/config", adminAuth, async (req, res) => {
  const name = decodeURIComponent(req.params.name);
  const { commission_pct } = req.body || {};
  if (commission_pct === undefined) return res.status(400).json({ error: "commission_pct required." });

  await VC.upsert(name, { commission_pct: parseFloat(commission_pct) });
  auditLog("admin", "vendor_config", name, { commission_pct });
  res.json({ success: true });
});

// ── POST /admin/settlements/generate ─────────────────────────────────────
app.post("/admin/settlements/generate", adminAuth, async (req, res) => {
  const { vendor_name, period_start, period_end } = req.body || {};
  if (!vendor_name || !period_start || !period_end)
    return res.status(400).json({ error: "vendor_name, period_start, period_end required." });

  try {
    const existing = await mdb.collection('settlements').findOne({ vendor_name, period_start, period_end });
    if (existing) return res.status(400).json({ error: "Settlement already exists for this period." });

    const allOrders = await fetchAllOrders("any", period_start + "T00:00:00Z", period_end + "T23:59:59Z");
    const vName  = vendor_name.toLowerCase();
    // Commission priority: vendor_profiles → vendor_config → default 20%
    const vProfile = await mdb.collection('vendor_profiles').findOne({ vendor_name }, { projection: { commission_pct: 1, _id: 0 } });
    const vConfig  = await VC.get(vendor_name);
    const config   = { commission_pct: vProfile?.commission_pct ?? vConfig?.commission_pct ?? 20 };
    const metas  = await mdb.collection('order_meta').find({}, { projection: { _id: 0 } }).toArray();
    const metaMap = Object.fromEntries(metas.map(m => [m.shopify_id, m]));
    // Per-vendor stage overrides
    const vendorStages = await mdb.collection('order_vendor_stage').find({ vendor_name }, { projection: { shopify_id: 1, stage: 1, _id: 0 } }).toArray();
    const vendorStageMap = Object.fromEntries(vendorStages.map(r => [r.shopify_id, r.stage]));

    // Only settle delivered orders — use vendor-specific stage if set, else order stage
    const vendorDelivered = allOrders.filter(o => {
      const sid = String(o.id);
      const effectiveStage = vendorStageMap[sid] || metaMap[sid]?.stage || "new";
      return effectiveStage === "delivered" &&
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
    let netPayable = parseFloat(totalNet.toFixed(2));
    const invoiceNo  = `CC-${vendor_name.toUpperCase().replace(/\s+/g,"").slice(0,6)}-${period_start.slice(0,7).replace("-","")}-${String(Date.now()).slice(-4)}`;

    const settlId = await nextId('settlements');
    await mdb.collection('settlements').insertOne({
      id: settlId, vendor_name, period_start, period_end,
      total_orders: vendorDelivered.length,
      gross_revenue: parseFloat(totalRev.toFixed(2)),
      commission: parseFloat(totalComm.toFixed(2)),
      gst_amount: parseFloat(totalGst.toFixed(2)),
      advance_total: parseFloat(totalAdv.toFixed(2)),
      net_payable: netPayable,
      total_shipping: parseFloat(totalShipping.toFixed(2)),
      status: 'pending', invoice_no: invoiceNo,
      created_at: new Date().toISOString(),
      penalty_deduction: 0, extra_discount: 0, shipping_adjustment: 0, extra_advance: 0, invoice_notes: '',
    });

    if (orderDetails.length > 0) {
      const settlOrderDocs = await Promise.all(orderDetails.map(async od => ({
        id: await nextId('settlement_orders'),
        settlement_id: settlId, ...od,
      })));
      await mdb.collection('settlement_orders').insertMany(settlOrderDocs);
    }

    // Include confirmed penalties for this vendor in the settlement period
    const periodStartTs = new Date(period_start + 'T00:00:00Z').getTime();
    const periodEndTs   = new Date(period_end   + 'T23:59:59Z').getTime();
    const confirmedPenalties = await mdb.collection('order_penalties').find(
      { vendor_name, status: 'confirmed', triggered_at: { $gte: periodStartTs, $lte: periodEndTs } },
      { projection: { _id: 0 } }
    ).toArray();
    const penaltyTotal = confirmedPenalties.reduce((s, p) => s + (p.penalty_amount || 0), 0);
    if (penaltyTotal > 0) {
      const penDocs = await Promise.all(confirmedPenalties.map(async p => ({ id: await nextId('settlement_penalties'), settlement_id: settlId, penalty_id: p.id, amount: p.penalty_amount })));
      await mdb.collection('settlement_penalties').insertMany(penDocs);
      const updatedNet = parseFloat((netPayable + penaltyTotal).toFixed(2));
      await mdb.collection('settlements').updateOne({ id: settlId }, { $set: { penalty_deduction: penaltyTotal, net_payable: updatedNet } });
      netPayable = updatedNet;
    }

    auditLog("admin", "settlement_generated", String(settlId), { vendor_name, period_start, period_end, netPayable });
    res.json({ success: true, settlementId: settlId, invoiceNo, totalOrders: vendorDelivered.length, netPayable, penaltyDeduction: penaltyTotal });
  } catch (err) {
    console.error("❌ /admin/settlements/generate:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /admin/delivered-summary ─────────────────────────────────────────
app.get("/admin/delivered-summary", adminAuth, async (req, res) => {
  try {
    const allOrders = await fetchAllOrders("any", "2020-01-01T00:00:00Z");
    const metas = await mdb.collection('order_meta').find({}, { projection: { _id: 0 } }).toArray();
    const metaMap = Object.fromEntries(metas.map(m => [m.shopify_id, m]));
    const vProfiles = await mdb.collection('vendor_profiles').find({}, { projection: { _id: 0 } }).toArray();
    const vConfigs  = await VC.all();
    const vProfileMap = Object.fromEntries(vProfiles.map(v => [v.vendor_name, v]));
    const vConfigMap  = Object.fromEntries(vConfigs.map(v => [v.vendor_name, v]));

    // Aggregate settled amounts per vendor from paid invoices
    const paidSettlDocs = await mdb.collection('settlements').find({ status: 'paid' }, { projection: { vendor_name: 1, net_payable: 1, _id: 0 } }).toArray();
    const settledMapRaw = {};
    paidSettlDocs.forEach(s => { settledMapRaw[s.vendor_name] = (settledMapRaw[s.vendor_name] || 0) + (s.net_payable || 0); });
    const settledMap = Object.fromEntries(Object.entries(settledMapRaw).map(([k,v]) => [k, parseFloat(v.toFixed(2))]));

    const vendorMap = {};
    // Load all per-vendor stage overrides
    const allVendorStages = await mdb.collection('order_vendor_stage').find({}, { projection: { _id: 0 } }).toArray();
    const allVendorStageMap = {}; // { shopify_id: { vendor_name: stage } }
    allVendorStages.forEach(r => {
      if (!allVendorStageMap[r.shopify_id]) allVendorStageMap[r.shopify_id] = {};
      allVendorStageMap[r.shopify_id][r.vendor_name] = r.stage;
    });

    allOrders.forEach(o => {
      const meta = metaMap[String(o.id)] || {};
      const orderStage = meta.stage || "new";
      const payType = meta.payment_type || "cod";
      const isCod = payType !== "prepaid";
      // Shipping from Shopify order, split equally by unique vendor count
      const orderShipping = (o.shipping_lines || []).reduce((s, l) => s + parseFloat(l.price || 0), 0);
      const ordVendorSet = new Set((o.line_items || []).map(li => li.vendor).filter(Boolean));
      const shippingPerVendor = ordVendorSet.size > 0 ? orderShipping / ordVendorSet.size : 0;

      (o.line_items || []).forEach(li => {
        const vendor = li.vendor;
        if (!vendor) return;
        // Use vendor-specific stage if set, else fall back to order stage
        const effectiveStage = allVendorStageMap[String(o.id)]?.[vendor] || orderStage;
        if (effectiveStage !== "delivered") return;
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
app.get("/admin/settlements", adminAuth, async (req, res) => {
  const { vendor_name, status } = req.query;
  const q = {};
  if (vendor_name) q.vendor_name = vendor_name;
  if (status) q.status = status;
  const settlements = await mdb.collection('settlements').find(q, { projection: { _id: 0 } }).sort({ created_at: -1 }).toArray();
  res.json({ settlements });
});

// ── GET /admin/settlements/gst-export ────────────────────────────────────
// All delivered orders in date range → one row per vendor → CA GST format CSV
app.get("/admin/settlements/gst-export", adminAuth, async (req, res) => {
  const { from, to } = req.query;
  if (!from || !to) return res.status(400).json({ error: "from and to (YYYY-MM-DD) required." });

  try {
    // Fetch ALL delivered orders (same as delivered-summary — no date filter on creation,
    // since orders created before the period may be delivered within it)
    const allOrders = await fetchAllOrders("any", "2020-01-01T00:00:00Z");

    // Load supporting data
    const metas = await mdb.collection('order_meta').find({}, { projection: { _id: 0 } }).toArray();
    const metaMap = Object.fromEntries(metas.map(m => [m.shopify_id, m]));
    const vProfiles = await mdb.collection('vendor_profiles').find({}, { projection: { _id: 0 } }).toArray();
    const vConfigs  = await VC.all();
    const vProfileMap = Object.fromEntries(vProfiles.map(v => [v.vendor_name, v]));
    const vConfigMap  = Object.fromEntries(vConfigs.map(v => [v.vendor_name, v]));
    const allVendorStages = await mdb.collection('order_vendor_stage').find({}, { projection: { _id: 0 } }).toArray();
    const vendorStageMap = {};
    allVendorStages.forEach(r => {
      if (!vendorStageMap[r.shopify_id]) vendorStageMap[r.shopify_id] = {};
      vendorStageMap[r.shopify_id][r.vendor_name] = r.stage;
    });

    // Aggregate per-vendor totals — only delivered orders
    const vendorMap = {};
    allOrders.forEach(o => {
      const sid = String(o.id);
      const meta = metaMap[sid] || {};
      const orderStage = meta.stage || 'new';
      const payType = meta.payment_type || 'cod';
      const isCod = payType !== 'prepaid';
      const orderShipping = (o.shipping_lines || []).reduce((s, l) => s + parseFloat(l.price || 0), 0);
      const ordVendorSet = new Set((o.line_items || []).map(li => li.vendor).filter(Boolean));
      const shippingPerVendor = ordVendorSet.size > 0 ? orderShipping / ordVendorSet.size : 0;

      (o.line_items || []).forEach(li => {
        const vendor = li.vendor;
        if (!vendor) return;
        const effectiveStage = vendorStageMap[sid]?.[vendor] || orderStage;
        if (effectiveStage !== 'delivered') return;
        if (!vendorMap[vendor]) vendorMap[vendor] = { gross: 0, prepaidDiscount: 0, commission: 0, gst: 0, advance: 0, shipping: 0, ordersAdded: new Set() };
        const itemRev = parseFloat(li.price || 0) * (li.quantity || 1);
        const commPct = vProfileMap[vendor]?.commission_pct ?? vConfigMap[vendor]?.commission_pct ?? 20;
        const calc = calcCommission(itemRev, payType, commPct, 0);
        vendorMap[vendor].gross += itemRev;
        if (!isCod) vendorMap[vendor].prepaidDiscount += (itemRev - calc.base);
        vendorMap[vendor].commission += calc.commission;
        vendorMap[vendor].gst += calc.gst;
        if (!vendorMap[vendor].ordersAdded.has(sid)) {
          vendorMap[vendor].ordersAdded.add(sid);
          if ((meta.advance_paid || 0) > 0) vendorMap[vendor].advance += (meta.advance_paid || 0) / ordVendorSet.size;
          if (isCod) vendorMap[vendor].shipping += shippingPerVendor;
        }
      });
    });

    const escCsv = v => {
      const s = v == null ? '' : String(v);
      return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s;
    };

    const periodLabel = `${from.split('-').reverse().join('/')}-${to.split('-').reverse().join('/')}`;

    const headers = [
      'DATE','COMMISSION INVOICE NO','VENDOR','VENDOR GST (IF AVAILABLE)',
      'OFFICE LOCATION (CITY/STATE)','TOTAL SALES','TOTAL VENDOR DISCOUNT',
      'TOTAL COMMISSIONABLE SALES','COMMISSION ON SALES','SHIPPING CHARGES',
      'CROSCROW DISCOUNT','SUBTOTAL','HSN CODE','IGST(18%)','SGST(9%)','CGST(9%)',
      'TOTAL GST','TOTAL COMMISSION WITH GST',
    ];

    const rows = Object.entries(vendorMap).sort((a,b) => b[1].gross - a[1].gross).map(([vendorName, d]) => {
      const prof = vProfileMap[vendorName] || {};
      const gstNo = prof.gst_no || 'NA';
      const location = [prof.city, prof.state].filter(Boolean).join('/') || 'NA';

      const totalSales     = parseFloat(d.gross.toFixed(2));
      const vendorDiscount = parseFloat(d.prepaidDiscount.toFixed(2));
      const commissionable = parseFloat((totalSales - vendorDiscount).toFixed(2));
      const commission     = parseFloat(d.commission.toFixed(2));
      const shipping       = parseFloat(d.shipping.toFixed(2));
      const subtotal       = parseFloat((commission + shipping).toFixed(2));
      const totalGst       = parseFloat(d.gst.toFixed(2));
      const hsnCode        = '998599';

      // IGST if inter-state: CrosCrow = Delhi (07). Same state → SGST+CGST
      const vendorStateCode = gstNo !== 'NA' ? gstNo.slice(0, 2) : null;
      const isIGST = !vendorStateCode || vendorStateCode !== '07';
      const igst = isIGST ? totalGst : 0;
      const sgst = isIGST ? 0 : parseFloat((totalGst / 2).toFixed(2));
      const cgst = isIGST ? 0 : parseFloat((totalGst / 2).toFixed(2));
      const totalWithGst = parseFloat((subtotal + totalGst).toFixed(2));

      return [
        periodLabel, '', vendorName, gstNo, location,
        totalSales.toFixed(2), vendorDiscount.toFixed(2), commissionable.toFixed(2),
        commission.toFixed(2), shipping.toFixed(2), '0.00',
        subtotal.toFixed(2), hsnCode,
        igst.toFixed(2), sgst.toFixed(2), cgst.toFixed(2),
        totalGst.toFixed(2), totalWithGst.toFixed(2),
      ].map(escCsv).join(',');
    });

    // Totals row
    const allV = Object.values(vendorMap);
    const tSales    = parseFloat(allV.reduce((s,d) => s + d.gross, 0).toFixed(2));
    const tDisc     = parseFloat(allV.reduce((s,d) => s + d.prepaidDiscount, 0).toFixed(2));
    const tComm     = parseFloat(allV.reduce((s,d) => s + d.commission, 0).toFixed(2));
    const tShip     = parseFloat(allV.reduce((s,d) => s + d.shipping, 0).toFixed(2));
    const tGst      = parseFloat(allV.reduce((s,d) => s + d.gst, 0).toFixed(2));
    const tCommable = parseFloat((tSales - tDisc).toFixed(2));
    const tSubtotal = parseFloat((tComm + tShip).toFixed(2));
    const tTotal    = parseFloat((tSubtotal + tGst).toFixed(2));
    const totalsRow = [
      'TOTAL','','','','',
      tSales.toFixed(2), tDisc.toFixed(2), tCommable.toFixed(2),
      tComm.toFixed(2), tShip.toFixed(2), '0.00',
      tSubtotal.toFixed(2), '',
      tGst.toFixed(2), '0.00', '0.00',
      tGst.toFixed(2), tTotal.toFixed(2),
    ].map(escCsv).join(',');

    const csv = [headers.join(','), ...rows, totalsRow].join('\r\n');
    const filename = `CrosCrow_GST_${from}_to_${to}.csv`;
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csv);
  } catch (err) {
    console.error("❌ /admin/settlements/gst-export:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /admin/settlements/:id ────────────────────────────────────────────
app.get("/admin/settlements/:id", adminAuth, async (req, res) => {
  const sid = parseInt(req.params.id);
  const settlement = await mdb.collection('settlements').findOne({ id: sid }, { projection: { _id: 0 } });
  if (!settlement) return res.status(404).json({ error: "Not found." });
  const orders = await mdb.collection('settlement_orders').find({ settlement_id: sid }, { projection: { _id: 0 } }).toArray();
  const croscrow = await mdb.collection('croscrow_profile').findOne({ id: 1 }, { projection: { _id: 0 } }) || {};
  const vendorProfile = await mdb.collection('vendor_profiles').findOne({ vendor_name: settlement.vendor_name }, { projection: { _id: 0 } }) || {};
  res.json({ settlement, orders, croscrow, vendorProfile });
});

// ── DELETE /admin/settlements/:id ────────────────────────────────────────
app.delete("/admin/settlements/:id", adminAuth, async (req, res) => {
  const sid = parseInt(req.params.id);
  const s = await mdb.collection('settlements').findOne({ id: sid }, { projection: { _id: 0 } });
  if (!s) return res.status(404).json({ error: "Not found." });
  await mdb.collection('settlement_orders').deleteMany({ settlement_id: sid });
  await mdb.collection('wallet_tx').deleteMany({ ref_id: String(sid) });
  await mdb.collection('settlements').deleteOne({ id: sid });
  auditLog("admin", "settlement_deleted", req.params.id, { vendor: s.vendor_name, invoice: s.invoice_no });
  res.json({ success: true });
});

// ── PUT /admin/settlements/:id/edit ───────────────────────────────────────
app.put("/admin/settlements/:id/edit", adminAuth, async (req, res) => {
  const sid = parseInt(req.params.id);
  const s = await mdb.collection('settlements').findOne({ id: sid }, { projection: { _id: 0 } });
  if (!s) return res.status(404).json({ error: "Not found." });

  const {
    custom_commission_pct,
    extra_discount     = 0,
    shipping_adjustment = 0,
    extra_advance      = 0,
    invoice_notes      = "",
  } = req.body || {};

  let orders = await mdb.collection('settlement_orders').find({ settlement_id: sid }, { projection: { _id: 0 } }).toArray();

  // Recalculate per-order commission if % changed
  let newCommission = s.commission, newGst = s.gst_amount;
  if (custom_commission_pct != null && parseFloat(custom_commission_pct) !== (s.custom_commission_pct || 0)) {
    newCommission = 0; newGst = 0;
    for (const o of orders) {
      const calc = calcCommission(o.my_revenue, o.payment_type, parseFloat(custom_commission_pct), o.advance_paid);
      newCommission += calc.commission;
      newGst        += calc.gst;
      await mdb.collection('settlement_orders').updateOne({ id: o.id }, { $set: { commission_pct: parseFloat(custom_commission_pct), commission: calc.commission, gst: calc.gst, net: calc.net } });
    }
    orders = await mdb.collection('settlement_orders').find({ settlement_id: sid }, { projection: { _id: 0 } }).toArray();
    newCommission = parseFloat(newCommission.toFixed(2));
    newGst        = parseFloat(newGst.toFixed(2));
  }

  const baseNet = orders.reduce((sum, o) => sum + (o.net || 0), 0);
  const adjustedNet = parseFloat((
    baseNet
    - parseFloat(extra_discount || 0)
    - parseFloat(extra_advance  || 0)
    + parseFloat(shipping_adjustment || 0)
  ).toFixed(2));

  await mdb.collection('settlements').updateOne({ id: sid }, { $set: {
    commission: newCommission, gst_amount: newGst,
    extra_discount: parseFloat(extra_discount||0),
    shipping_adjustment: parseFloat(shipping_adjustment||0),
    extra_advance: parseFloat(extra_advance||0),
    invoice_notes: invoice_notes || "",
    custom_commission_pct: custom_commission_pct != null ? parseFloat(custom_commission_pct) : null,
    net_payable: adjustedNet,
  }});

  auditLog("admin", "settlement_edited", req.params.id, req.body);
  res.json({ success: true, netPayable: adjustedNet, commission: newCommission, gst: newGst });
});

// ── PUT /admin/settlements/:id/mark-paid ──────────────────────────────────
app.put("/admin/settlements/:id/mark-paid", adminAuth, async (req, res) => {
  const sid = parseInt(req.params.id);
  const s = await mdb.collection('settlements').findOne({ id: sid }, { projection: { _id: 0 } });
  if (!s) return res.status(404).json({ error: "Not found." });
  const now = new Date().toISOString();
  await mdb.collection('settlements').updateOne({ id: sid }, { $set: { status: 'paid', paid_at: now } });
  await mdb.collection('wallet_tx').insertOne({
    id: await nextId('wallet_tx'),
    vendor_name: s.vendor_name,
    type: s.net_payable > 0 ? "debit" : "credit",
    amount: Math.abs(s.net_payable),
    description: `Settlement ${s.invoice_no}`,
    ref_id: String(sid),
    created_at: now,
  });
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

app.get("/admin/tag-mappings", adminAuth, async (req, res) => {
  const mappings = await mdb.collection('tag_mappings').find({}, { projection: { _id: 0 } }).sort({ priority: 1, id: 1 }).toArray();
  res.json({ mappings });
});

app.put("/admin/tag-mappings/:id/priority", adminAuth, async (req, res) => {
  const { priority } = req.body || {};
  if (priority === undefined) return res.status(400).json({ error: "priority required" });
  await mdb.collection('tag_mappings').updateOne({ id: parseInt(req.params.id) }, { $set: { priority: Number(priority) } });
  res.json({ ok: true });
});

app.post("/admin/tag-mappings", adminAuth, async (req, res) => {
  const { shopify_tag, stage, priority = 99 } = req.body || {};
  if (!shopify_tag || !stage) return res.status(400).json({ error: "shopify_tag and stage required." });
  const VALID_STAGES = ["new","confirmed","partial","ready","pickup","transit","delivered","rto","hold","cancelled"];
  if (!VALID_STAGES.includes(stage)) return res.status(400).json({ error: `Invalid stage '${stage}'. Valid: ${VALID_STAGES.join(", ")}` });
  const existing = await mdb.collection('tag_mappings').findOne({ shopify_tag: { $regex: new RegExp(`^${shopify_tag.trim()}$`, 'i') } });
  if (existing) return res.status(400).json({ error: "A mapping for this tag already exists." });
  const id = await nextId('tag_mappings');
  await mdb.collection('tag_mappings').insertOne({ id, shopify_tag: shopify_tag.trim(), stage, priority: Number(priority), created_at: new Date().toISOString() });
  res.json({ success: true, id });
});

app.delete("/admin/tag-mappings/:id", adminAuth, async (req, res) => {
  await mdb.collection('tag_mappings').deleteOne({ id: parseInt(req.params.id) });
  res.json({ success: true });
});

// Sync: scan ALL orders — set payment_type from financial_status + apply tag mappings
app.post("/admin/tag-mappings/sync", adminAuth, async (req, res) => {
  try {
    const allOrders = await fetchAllOrders("any", "2020-01-01T00:00:00Z");
    let updated = 0;
    const beforeArr = await mdb.collection('order_meta').find({}, { projection: { shopify_id: 1, stage: 1, payment_type: 1, advance_paid: 1, _id: 0 } }).toArray();
    const beforeMap = Object.fromEntries(beforeArr.map(r => [r.shopify_id, r]));

    for (const o of allOrders) {
      const prev = beforeMap[String(o.id)];
      await applyTagMappings(o.id, o.tags, o.financial_status);
      const after = await mdb.collection('order_meta').findOne({ shopify_id: String(o.id) }, { projection: { stage: 1, payment_type: 1, advance_paid: 1, _id: 0 } });
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
app.get("/admin/croscrow-profile", adminAuth, async (req, res) => {
  res.json(await mdb.collection('croscrow_profile').findOne({ id: 1 }, { projection: { _id: 0 } }) || {});
});
app.put("/admin/croscrow-profile", adminAuth, async (req, res) => {
  const f = req.body || {};
  await mdb.collection('croscrow_profile').updateOne({ id: 1 }, { $set: { id: 1, company_name: f.company_name||'CrosCrow Marketplace', email: f.email||'', phone: f.phone||'', address: f.address||'', city: f.city||'', state: f.state||'', pincode: f.pincode||'', gst_no: f.gst_no||'', pan_no: f.pan_no||'', bank_name: f.bank_name||'', account_no: f.account_no||'', ifsc: f.ifsc||'', website: f.website||'' } }, { upsert: true });
  auditLog("admin","profile_update","croscrow",{});
  res.json({ success:true });
});

// ── GET/PUT /admin/vendors/:name/profile ──────────────────────────────────
app.get("/admin/vendors/:name/profile", adminAuth, async (req, res) => {
  const name = decodeURIComponent(req.params.name);
  const p = await mdb.collection('vendor_profiles').findOne({ vendor_name: name }, { projection: { _id: 0 } }) || { vendor_name: name };
  const cfg = await VC.get(name);
  if (!p.commission_pct && cfg) p.commission_pct = cfg.commission_pct;
  res.json(p);
});
app.put("/admin/vendors/:name/profile", adminAuth, async (req, res) => {
  const name = decodeURIComponent(req.params.name);
  const f = req.body || {};
  await mdb.collection('vendor_profiles').updateOne({ vendor_name: name }, { $set: { vendor_name: name, email: f.email||'', phone: f.phone||'', address: f.address||'', city: f.city||'', state: f.state||'', pincode: f.pincode||'', gst_no: f.gst_no||'', pan_no: f.pan_no||'', bank_name: f.bank_name||'', account_no: f.account_no||'', ifsc: f.ifsc||'', commission_pct: f.commission_pct!=null?parseFloat(f.commission_pct):null, updated_at: new Date().toISOString() } }, { upsert: true });
  // Sync email + commission to vendor_config so notifications fire correctly
  const vcUpdate = {};
  if (f.email) vcUpdate.email = f.email;
  if (f.commission_pct != null) vcUpdate.commission_pct = parseFloat(f.commission_pct);
  if (Object.keys(vcUpdate).length) await VC.upsert(name, vcUpdate);
  auditLog("admin","vendor_profile_update",name,{ commission_pct: f.commission_pct, email: f.email });
  res.json({ success:true });
});

// ── GET /admin/audit ──────────────────────────────────────────────────────
app.get("/admin/audit", adminAuth, async (req, res) => {
  const logs = await mdb.collection('audit_log').find({}, { projection: { _id: 0 } }).sort({ created_at: -1 }).limit(500).toArray();
  res.json({ logs });
});

// ── Email Settings ────────────────────────────────────────────────────────
app.get("/admin/email-settings", adminAuth, async (req, res) => {
  const row = await ES.get();
  const smtp = row ? (typeof row.smtp === 'string' ? JSON.parse(row.smtp) : (row.smtp || {})) : {};
  const enabled = row ? (row.enabled !== 0) : true;
  res.json({ smtp: { ...smtp, pass: smtp.pass ? '••••••••' : '' }, enabled });
});

app.post("/admin/email-settings/toggle", adminAuth, async (req, res) => {
  const { enabled } = req.body || {};
  await ES.save({ enabled: enabled ? 1 : 0 });
  res.json({ ok: true, enabled: !!enabled });
});

app.post("/admin/email-settings", adminAuth, async (req, res) => {
  const { smtp } = req.body || {};
  if (!smtp) return res.status(400).json({ error: "smtp config required" });
  const existing = await ES.get();
  let merged = smtp;
  if (existing) {
    const prev = typeof existing.smtp === 'string' ? JSON.parse(existing.smtp) : (existing.smtp || {});
    if (smtp.pass === '••••••••') smtp.pass = prev.pass;
    merged = { ...prev, ...smtp };
  }
  await ES.save({ smtp: JSON.stringify(merged) });
  res.json({ ok: true });
});

app.post("/admin/email-settings/test", adminAuth, async (req, res) => {
  const { to } = req.body || {};
  if (!to) return res.status(400).json({ error: "to email required" });
  const cfg = await getSmtpConfig();
  if (!cfg?.host) return res.status(400).json({ error: "SMTP not configured yet" });
  try {
    const transporter = createTransporter(cfg);
    await transporter.sendMail({
      from: `"${cfg.fromName || 'CrosCrow'}" <${cfg.fromEmail || cfg.user}>`,
      to, subject: 'CrosCrow SMTP Test ✅',
      html: emailBase('SMTP is working!', '#10b981', '<p style="color:#6b7280;font-size:14px">Your email configuration is correct. CrosCrow will now send order notifications automatically.</p>'),
    });
    res.json({ ok: true, message: `Test email sent to ${to}` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/admin/email-settings/test-template", adminAuth, async (req, res) => {
  const { to, template } = req.body || {};
  if (!to || !template) return res.status(400).json({ error: "to and template required" });
  const cfg = await getSmtpConfig();
  if (!cfg?.host) return res.status(400).json({ error: "SMTP not configured yet" });

  const demoOrder = {
    id: 99999, name: '#TEST-001',
    created_at: new Date().toISOString(),
    financial_status: 'pending',
    total_price: '1299.00',
    total_shipping_price_set: { shop_money: { amount: '49.00' } },
    email: to,
    line_items: [{ title: 'Demo Product (Size: M)', variant_title: 'Size: M', quantity: 1, price: '1250.00', vendor: 'Demo Vendor', sku: 'DEMO-001' }],
    shipping_address: { name: 'Test Customer', address1: '123 Test Street', address2: '', city: 'Mumbai', province: 'Maharashtra', zip: '400001', phone: '+91 9876543210' },
    shipping_lines: [{ price: '49.00' }],
  };
  const demoMeta = { advance_paid: 200, payment_type: 'cod' };

  const TEMPLATES = {
    new_order:  { subject: `Your Order ${demoOrder.name} is In`, html: templateNewOrderCustomerSky({ order: demoOrder }) },
    confirmed_customer: { subject: `[TEST] Order Confirmed: ${demoOrder.name} ✅`, html: templateOrderConfirmedCustomer({ order: demoOrder }) },
    new_order_vendor:   { subject: `New Order Received: ${demoOrder.name}`, html: templateNewOrderVendor({ order: demoOrder, vendorName: 'Demo Vendor' }) },
    confirmed_vendor:   { subject: `Order Confirmed: ${demoOrder.name} — Dispatch Now`, html: templateOrderConfirmedVendor({ order: demoOrder, vendorName: 'Demo Vendor', meta: demoMeta }) },
    partial_customer:   { subject: `[TEST] Your Advance is Confirmed — ${demoOrder.name} 🎉`, html: templatePartialAdvanceCustomer({ order: demoOrder, meta: demoMeta }) },
    partial_vendor:     { subject: `[TEST] Advance Collected — Updated COD for ${demoOrder.name}`, html: templatePartialAdvanceVendor({ order: demoOrder, vendorName: 'Demo Vendor', meta: demoMeta }) },
    transit:    { subject: `[TEST] Order Shipped: ${demoOrder.name} 🚚`, html: templateInTransit({ order: demoOrder, awb: '1234567890', courier: 'Delhivery' }) },
    delivered_customer: { subject: `[TEST] Order Delivered: ${demoOrder.name} 🎉`, html: templateDelivered({ order: demoOrder, forRole: 'customer' }) },
    delivered_vendor:   { subject: `[TEST] Order Delivered: ${demoOrder.name}`, html: templateDelivered({ order: demoOrder, forRole: 'vendor' }) },
    delivered_admin:    { subject: `[TEST] Delivered: ${demoOrder.name}`, html: templateDelivered({ order: demoOrder, forRole: 'admin' }) },
  };

  const tpl = TEMPLATES[template];
  if (!tpl) return res.status(400).json({ error: `Unknown template. Valid: ${Object.keys(TEMPLATES).join(', ')}` });

  try {
    const transporter = createTransporter(cfg);
    await transporter.sendMail({ from: `"${cfg.fromName || 'CrosCrow'}" <${cfg.fromEmail || cfg.user}>`, to, subject: tpl.subject, html: tpl.html });
    res.json({ ok: true, message: `Test "${template}" sent to ${to}` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/admin/email-log", adminAuth, async (req, res) => {
  const logs = await mdb.collection('email_log').find({}, { projection: { _id: 0 } }).sort({ sent_at: -1 }).limit(200).toArray();
  res.json({ logs });
});

// Vendor email update — syncs to both vendor_config and vendor_profiles
app.put("/admin/vendors/:name/email", adminAuth, async (req, res) => {
  const name = decodeURIComponent(req.params.name);
  const { email } = req.body || {};
  await VC.upsert(name, { email: email || '' });
  await mdb.collection('vendor_profiles').updateOne({ vendor_name: name }, { $set: { email: email || '', updated_at: new Date().toISOString() } }, { upsert: true });
  res.json({ ok: true });
});

// ── Vendor wallet + settlements ───────────────────────────────────────────
// ── GET/PUT /vendor/profile ───────────────────────────────────────────────
app.get("/vendor/profile", vendorAuth, async (req, res) => {
  const p = await mdb.collection('vendor_profiles').findOne({ vendor_name: req.vendor }, { projection: { _id: 0 } }) || { vendor_name: req.vendor };
  const cfg = await VC.get(req.vendor);
  if (!p.commission_pct && cfg) p.commission_pct = cfg.commission_pct;
  res.json(p);
});
app.put("/vendor/profile", vendorAuth, async (req, res) => {
  const f = req.body || {};
  await mdb.collection('vendor_profiles').updateOne({ vendor_name: req.vendor }, { $set: { vendor_name: req.vendor, email: f.email||'', phone: f.phone||'', address: f.address||'', city: f.city||'', state: f.state||'', pincode: f.pincode||'', gst_no: f.gst_no||'', pan_no: f.pan_no||'', bank_name: f.bank_name||'', account_no: f.account_no||'', ifsc: f.ifsc||'', updated_at: new Date().toISOString() } }, { upsert: true });
  // Sync email to vendor_config so order notification emails fire to the right address
  if (f.email) await VC.upsert(req.vendor, { email: f.email });
  res.json({ success:true });
});

app.get("/vendor/wallet", vendorAuth, async (req, res) => {
  const txs = await mdb.collection('wallet_tx').find({ vendor_name: req.vendor }, { projection: { _id: 0 } }).sort({ created_at: -1 }).toArray();
  const balance = txs.reduce((s, t) => t.type === "credit" ? s + t.amount : s - t.amount, 0);
  res.json({ balance: parseFloat(balance.toFixed(2)), transactions: txs });
});

// ── GET /vendor/delivered-summary ────────────────────────────────────────
app.get("/vendor/delivered-summary", vendorAuth, async (req, res) => {
  try {
    const vName = req.vendor.toLowerCase();
    const allOrders = await fetchAllOrders("any", "2020-01-01T00:00:00Z");
    const metasArr = await mdb.collection('order_meta').find({}, { projection: { _id: 0 } }).toArray();
    const metaMap = Object.fromEntries(metasArr.map(m => [m.shopify_id, m]));
    const vProfile = await mdb.collection('vendor_profiles').findOne({ vendor_name: req.vendor }, { projection: { _id: 0 } });
    const vConfig  = await VC.get(req.vendor);
    const commPct  = vProfile?.commission_pct ?? vConfig?.commission_pct ?? 20;

    const paidSettlDocs = await mdb.collection('settlements').find({ vendor_name: req.vendor, status: 'paid' }, { projection: { net_payable: 1, _id: 0 } }).toArray();
    const totalSettled = paidSettlDocs.reduce((s, d) => s + (d.net_payable || 0), 0);

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

app.get("/vendor/settlements", vendorAuth, async (req, res) => {
  const settlements = await mdb.collection('settlements').find({ vendor_name: req.vendor }, { projection: { _id: 0 } }).sort({ created_at: -1 }).toArray();
  res.json({ settlements });
});

app.get("/vendor/settlements/:id", vendorAuth, async (req, res) => {
  const sid = parseInt(req.params.id);
  const s = await mdb.collection('settlements').findOne({ id: sid, vendor_name: req.vendor }, { projection: { _id: 0 } });
  if (!s) return res.status(404).json({ error: "Not found." });
  const [croscrow, vendorProfile, orders] = await Promise.all([
    mdb.collection('croscrow_profile').findOne({ id: 1 }, { projection: { _id: 0 } }).then(r => r || {}),
    mdb.collection('vendor_profiles').findOne({ vendor_name: req.vendor }, { projection: { _id: 0 } }).then(r => r || {}),
    mdb.collection('settlement_orders').find({ settlement_id: sid }, { projection: { _id: 0 } }).toArray(),
  ]);
  res.json({ settlement: s, orders, croscrow, vendorProfile });
});

// ── Shipping Partners ──────────────────────────────────────────────────────

// GET /vendor/shipping/partners
app.get("/vendor/shipping/partners", vendorAuth, async (req, res) => {
  const rows = await mdb.collection('vendor_shipping_partners').find({ vendor_name: req.vendor }, { projection: { partner: 1, active: 1, connected_at: 1, _id: 0 } }).toArray();
  res.json({ partners: rows });
});

// POST /vendor/shipping/partners — save/update credentials
app.post("/vendor/shipping/partners", vendorAuth, async (req, res) => {
  const { partner, credentials } = req.body || {};
  if (!partner || !credentials) return res.status(400).json({ error: "partner and credentials required" });
  const allowed = ["shiprocket", "delhivery"];
  if (!allowed.includes(partner)) return res.status(400).json({ error: "Unknown partner" });
  await mdb.collection('vendor_shipping_partners').updateOne(
    { vendor_name: req.vendor, partner },
    { $set: { vendor_name: req.vendor, partner, credentials: JSON.stringify(credentials), active: 1, connected_at: new Date().toISOString() } },
    { upsert: true }
  );
  res.json({ success: true });
});

// DELETE /vendor/shipping/partners/:partner — disconnect
app.delete("/vendor/shipping/partners/:partner", vendorAuth, async (req, res) => {
  await mdb.collection('vendor_shipping_partners').deleteOne({ vendor_name: req.vendor, partner: req.params.partner });
  res.json({ success: true });
});

// POST /vendor/orders/:shopifyId/create-shipment — create shipment via connected partner
app.post("/vendor/orders/:shopifyId/create-shipment", vendorAuth, async (req, res) => {
  try {
    const { partner, weight = 0.5, length = 15, breadth = 12, height = 8 } = req.body || {};
    if (!partner) return res.status(400).json({ error: "partner required" });

    const row = await mdb.collection('vendor_shipping_partners').findOne({ vendor_name: req.vendor, partner, active: 1 }, { projection: { credentials: 1, _id: 0 } });
    if (!row) return res.status(404).json({ error: "Partner not connected. Go to Shipping Settings to connect." });

    const creds = JSON.parse(row.credentials);

    // Fetch order from Shopify
    const { order: shopifyOrder } = await shopifyREST(`/orders/${req.params.shopifyId}.json`);

    if (!shopifyOrder) return res.status(404).json({ error: "Order not found on Shopify" });

    const addr      = shopifyOrder.shipping_address || {};
    const items     = (shopifyOrder.line_items || []).filter(li => (li.vendor || "").toLowerCase() === req.vendor.toLowerCase());
    const cod       = shopifyOrder.financial_status !== "paid";

    // Calculate this vendor's correct COD amount
    const vendorSubtotal  = items.reduce((s, li) => s + parseFloat(li.price || 0) * (li.quantity || 1), 0);
    const allVendors      = [...new Set((shopifyOrder.line_items || []).map(li => li.vendor).filter(Boolean))];
    const vendorCount     = allVendors.length || 1;
    const totalShipping   = (shopifyOrder.shipping_lines || []).reduce((s, l) => s + parseFloat(l.price || 0), 0);
    const vendorShipping  = cod ? parseFloat((totalShipping / vendorCount).toFixed(2)) : 0;

    // Fetch advance paid from order_meta and split across vendors
    const meta            = await mdb.collection('order_meta').findOne({ shopify_id: String(shopifyOrder.id) }, { projection: { advance_paid: 1, payment_type: 1 } });
    const advancePaid     = parseFloat(((meta?.advance_paid || 0) / vendorCount).toFixed(2));

    const vendorTotal     = parseFloat((vendorSubtotal + vendorShipping).toFixed(2));
    const codAmt          = cod ? parseFloat(Math.max(0, vendorTotal - advancePaid).toFixed(2)) : 0;

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
        sub_total:      vendorSubtotal,
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
          total_amount:  vendorTotal,
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
      await OM.upsert(String(shopifyOrder.id), { awb: result.awb, courier: partner, updated_at: new Date().toISOString() });
    }

    res.json(result);
  } catch (err) {
    console.error("❌ /create-shipment:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Admin Global Shipping Credentials ────────────────────────────────────────
app.get("/admin/shipping-creds", adminAuth, async (req, res) => {
  const rows = await mdb.collection('global_shipping_creds').find({}, { projection: { id: 1, partner: 1, connected_at: 1, _id: 0 } }).toArray();
  res.json({ partners: rows });
});

app.post("/admin/shipping-creds", adminAuth, async (req, res) => {
  const { partner, credentials } = req.body || {};
  if (!partner || !credentials) return res.status(400).json({ error: "partner and credentials required" });
  await mdb.collection('global_shipping_creds').updateOne(
    { partner },
    { $set: { partner, credentials: JSON.stringify(credentials), connected_at: new Date().toISOString() } },
    { upsert: true }
  );
  res.json({ ok: true });
});

app.delete("/admin/shipping-creds/:partner", adminAuth, async (req, res) => {
  await mdb.collection('global_shipping_creds').deleteOne({ partner: req.params.partner });
  res.json({ ok: true });
});

// Debug endpoint — shows every step of tracking for an AWB
app.get("/admin/debug-tracking", adminAuth, async (req, res) => {
  const { awb, partner = "delhivery" } = req.query;
  if (!awb) return res.json({ error: "Pass ?awb=YOURAWB&partner=delhivery" });

  const log = [];
  try {
    const credRow = await mdb.collection('global_shipping_creds').findOne({ partner }, { projection: { credentials: 1, _id: 0 } });
    if (!credRow) return res.json({ error: `No credentials saved for ${partner}`, log });
    const creds = JSON.parse(credRow.credentials);
    log.push({ step: "creds_loaded", partner, keys: Object.keys(creds) });

    if (partner === "delhivery") {
      const url = `https://track.delhivery.com/api/v1/packages/json/?waybill=${awb}`;
      log.push({ step: "fetching_with_token", url });
      const r = await fetch(url, { headers: { "Authorization": `Token ${creds.api_token}`, "Content-Type": "application/json" } });
      const raw = await r.json();
      log.push({ step: "auth_response", status: r.status, success: raw.Success, body: raw });

      let finalRaw = raw;
      if (!raw.Success || !raw.ShipmentData?.length) {
        log.push({ step: "token_failed_trying_public" });
        const r2 = await fetch(url, { headers: { "Content-Type": "application/json" } });
        finalRaw = await r2.json();
        log.push({ step: "public_response", status: r2.status, success: finalRaw.Success, body: finalRaw });
      }

      const status = finalRaw?.ShipmentData?.[0]?.Shipment?.Status?.Status || finalRaw?.ShipmentData?.[0]?.Shipment?.status || null;
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
    let meta = await mdb.collection('order_meta').findOne({ shopify_id: shopifyId }, { projection: { awb: 1, courier: 1, delivery_status: 1, _id: 0 } }) || {};
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
    const credRow = await mdb.collection('global_shipping_creds').findOne({ partner }, { projection: { credentials: 1, _id: 0 } });
    if (!credRow) return res.json({ status: meta.delivery_status || "", awb, message: `No global credentials saved for ${partner}` });

    const creds = JSON.parse(credRow.credentials);
    const status = await fetchDeliveryStatus(partner, creds, awb);
    if (status) await OM.upsert(shopifyId, { awb, courier, delivery_status: status, delivery_status_updated_at: new Date().toISOString() });
    res.json({ status, awb });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin bulk sync delivery status for all orders with AWB
app.post("/admin/shipping/sync-status", adminAuth, async (req, res) => {
  try {
    const allCreds = await mdb.collection('global_shipping_creds').find({}, { projection: { partner: 1, credentials: 1, _id: 0 } }).toArray();
    if (!allCreds.length) return res.json({ updated: 0, message: "No global shipping credentials configured" });

    const orders = await mdb.collection('order_meta').find({ awb: { $exists: true, $ne: '' } }, { projection: { shopify_id: 1, awb: 1, courier: 1, _id: 0 } }).toArray();
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
          await OM.upsert(o.shopify_id, { delivery_status: status, delivery_status_updated_at: new Date().toISOString() });
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
    // Try authenticated API first, fall back to public tracking endpoint
    let dlRes = await fetch(
      `https://track.delhivery.com/api/v1/packages/json/?waybill=${awb}`,
      { headers: { "Authorization": `Token ${creds.api_token}`, "Content-Type": "application/json" } }
    ).then(r => r.json());

    if (!dlRes.Success || !dlRes.ShipmentData?.length) {
      // Fall back to public API (no auth needed)
      dlRes = await fetch(
        `https://track.delhivery.com/api/v1/packages/json/?waybill=${awb}`,
        { headers: { "Content-Type": "application/json" } }
      ).then(r => r.json());
    }

    const shipment = dlRes?.ShipmentData?.[0]?.Shipment;
    const status = shipment?.Status?.Status || shipment?.status || "";
    return status;
  }
  return "";
}

// GET /vendor/orders/:shopifyId/delivery-status — fetch live status from partner
app.get("/vendor/orders/:shopifyId/delivery-status", vendorAuth, async (req, res) => {
  try {
    const meta = await mdb.collection('order_meta').findOne({ shopify_id: req.params.shopifyId }, { projection: { awb: 1, courier: 1, delivery_status: 1, _id: 0 } });
    if (!meta?.awb) return res.json({ status: "", awb: "" });

    const partner = (meta.courier || "").toLowerCase();
    const partnerRow = await mdb.collection('vendor_shipping_partners').findOne({ vendor_name: req.vendor, partner, active: 1 }, { projection: { credentials: 1, _id: 0 } });

    let status = meta.delivery_status || "";
    if (partnerRow) {
      try {
        const creds = JSON.parse(partnerRow.credentials);
        status = await fetchDeliveryStatus(partner, creds, meta.awb);
        await OM.upsert(req.params.shopifyId, { delivery_status: status, delivery_status_updated_at: new Date().toISOString() });
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
    const partners = await mdb.collection('vendor_shipping_partners').find({ vendor_name: req.vendor, active: 1 }, { projection: { partner: 1, credentials: 1, _id: 0 } }).toArray();
    if (!partners.length) return res.json({ updated: 0 });

    const orders = await mdb.collection('order_meta').find({ awb: { $exists: true, $ne: '' } }, { projection: { shopify_id: 1, awb: 1, courier: 1, _id: 0 } }).toArray();
    let updated = 0;
    for (const o of orders) {
      const partner = (o.courier || "").toLowerCase();
      const partnerRow = partners.find(p => p.partner === partner);
      if (!partnerRow) continue;
      try {
        const creds = JSON.parse(partnerRow.credentials);
        const status = await fetchDeliveryStatus(partner, creds, o.awb);
        if (status) {
          await OM.upsert(o.shopify_id, { delivery_status: status, delivery_status_updated_at: new Date().toISOString() });
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


// Admin: get + post notes
app.get("/admin/orders/:id/notes", adminAuth, async (req, res) => {
  const notes = await ON.allFor(req.params.id);
  const remarks = await DR.allFor(req.params.id);
  res.json({ notes, remarks });
});

app.post("/admin/orders/:id/notes", adminAuth, async (req, res) => {
  const { note } = req.body || {};
  if (!note?.trim()) return res.status(400).json({ error: "note required." });
  await ON.insert(req.params.id, 'admin', 'Admin', note.trim());
  res.json({ success: true });
});

// Vendor: get + post notes
app.get("/vendor/orders/:id/notes", vendorAuth, async (req, res) => {
  const notes = await ON.allFor(req.params.id);
  const remarks = await DR.allFor(req.params.id, req.vendor);
  res.json({ notes, remarks });
});

app.post("/vendor/orders/:id/notes", vendorAuth, async (req, res) => {
  const { note } = req.body || {};
  if (!note?.trim()) return res.status(400).json({ error: "note required." });
  await ON.insert(req.params.id, 'vendor', req.vendor, note.trim());
  res.json({ success: true });
});

// Vendor: submit delay remark (from order modal, no token needed — vendorAuth)
app.post("/vendor/orders/:id/delay-remark", vendorAuth, async (req, res) => {
  const { reason, eta_date } = req.body || {};
  if (!reason || !eta_date) return res.status(400).json({ error: "reason and eta_date required." });
  const sid = req.params.id;
  const vendor = req.vendor;
  await DR.insert(sid, vendor, reason, eta_date);

  try {
    const shopifyOrder = await shopifyREST(`/orders/${sid}.json?fields=id,name,email,shipping_address`);
    const ord = shopifyOrder?.order;
    const customerEmail = ord?.email;
    const adminEmail = (await getSmtpConfig())?.user;
    const etaFormatted = new Date(eta_date + 'T00:00:00').toLocaleDateString('en-IN', { day:'numeric', month:'long', year:'numeric' });
    const delayHtmlCustomer = emailBase(`We're Sorry — Your Order Is Delayed`, '#f59e0b', `
      <div class="subtitle">We sincerely apologise for the delay in fulfilling your order.</div>
      <div class="info-box">
        <div class="info-row"><span class="info-label">Order ID</span><span class="info-val" style="color:#6366f1">${ord?.name || sid}</span></div>
        <div class="info-row"><span class="info-label">Expected Dispatch By</span><span class="info-val" style="color:#10b981;font-weight:700">${etaFormatted}</span></div>
      </div>
      <div style="background:#fef9c3;border:1px solid #fde047;border-radius:8px;padding:14px 18px;margin-bottom:16px;font-size:13px;color:#713f12;line-height:1.7">
        Your order is being prepared and will be dispatched by <strong>${etaFormatted}</strong>. You'll receive a shipping confirmation with tracking details once dispatched.
      </div>`);
    const delayHtmlAdmin = emailBase(`Vendor Delay Remark: ${ord?.name || sid}`, '#f59e0b', `
      <div class="subtitle">Vendor <strong>${vendor}</strong> has submitted a delay remark.</div>
      <div class="info-box">
        <div class="info-row"><span class="info-label">Order</span><span class="info-val">${ord?.name || sid}</span></div>
        <div class="info-row"><span class="info-label">Vendor</span><span class="info-val">${vendor}</span></div>
        <div class="info-row"><span class="info-label">ETA Dispatch</span><span class="info-val" style="color:#f59e0b;font-weight:700">${etaFormatted}</span></div>
        <div class="info-row"><span class="info-label">Reason</span><span class="info-val">${reason}</span></div>
      </div>`);
    if (customerEmail) await sendEmail({ to: customerEmail, subject: `Important Update: Your Order ${ord?.name || sid} is Delayed`, html: delayHtmlCustomer, shopifyId: sid, trigger: 'delay_remark_customer' });
    if (adminEmail) await sendEmail({ to: adminEmail, subject: `Vendor Delay Remark: ${ord?.name || sid} — ${vendor}`, html: delayHtmlAdmin, shopifyId: sid, trigger: 'delay_remark_admin' });
  } catch (e) { console.error("Delay remark email:", e.message); }

  res.json({ success: true });
});

// ══════════════════════════════════════════════════════════════════════════
//  VENDOR SHOPIFY SYNC — OAuth + Product Import/Map
// ══════════════════════════════════════════════════════════════════════════

// Helper: call vendor's own Shopify store REST API
async function vendorShopifyREST(shopDomain, accessToken, path) {
  const url = `https://${shopDomain}/admin/api/2024-01${path}`;
  const res = await fetch(url, { headers: { 'X-Shopify-Access-Token': accessToken, 'Content-Type': 'application/json' } });
  if (!res.ok) throw new Error(`Vendor Shopify API error ${res.status}: ${await res.text()}`);
  return res.json();
}

// Helper: call CrosCrow main store REST with write access
async function croscrowShopifyWrite(path, method, body) {
  const token = await getAccessToken();
  const url = `https://${SHOP}.myshopify.com/admin/api/2024-01${path}`;
  const res = await fetch(url, {
    method,
    headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`CrosCrow Shopify write error ${res.status}: ${await res.text()}`);
  return res.json();
}

// Validate Shopify HMAC on OAuth callback
function validateShopifyHmac(query) {
  const { hmac, ...rest } = query;
  if (!hmac) return false;
  const msg = Object.keys(rest).sort().map(k => `${k}=${rest[k]}`).join('&');
  const computed = crypto.createHmac('sha256', VENDOR_APP_SECRET).update(msg).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(hmac));
}

// ── Step 1: Vendor initiates OAuth (from vendor panel) ───────────────────
// ── Vendor: connect via client_id + secret (client credentials grant) ────
app.post("/vendor/shopify/connect", vendorAuth, async (req, res) => {
  const { shop, client_id, client_secret } = req.body || {};
  if (!shop || !client_id || !client_secret) return res.status(400).json({ error: "shop, client_id and client_secret required." });
  const cleanShop = shop.replace(/https?:\/\//, '').replace(/\/$/, '').trim();

  try {
    // Exchange client credentials for access token
    const tokenRes = await fetch(`https://${cleanShop}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'client_credentials', client_id, client_secret }),
    });
    const rawText = await tokenRes.text();
    let tokenData;
    try { tokenData = JSON.parse(rawText); } catch { throw new Error(`Shopify returned unexpected response. Check your store URL and credentials.`); }
    if (!tokenData.access_token) throw new Error(tokenData.error_description || tokenData.error || JSON.stringify(tokenData));

    // Verify it works
    const test = await vendorShopifyREST(cleanShop, tokenData.access_token, '/shop.json');
    if (!test.shop) throw new Error("Token obtained but shop verification failed.");

    await VSC.upsert(req.vendor, { shop_domain: cleanShop, access_token: tokenData.access_token, scope: tokenData.scope || '', installed_at: Date.now() });

    console.log(`✅ Vendor Shopify connected: ${req.vendor} → ${cleanShop}`);
    res.json({ success: true, shop: cleanShop });
  } catch (e) {
    res.status(400).json({ error: `Connection failed: ${e.message}` });
  }
});

// ── Vendor: check own connection status ───────────────────────────────────
app.get("/vendor/shopify/status", vendorAuth, async (req, res) => {
  const conn = await VSC.get(req.vendor);
  res.json({ connected: !!conn, connection: conn ? { shop_domain: conn.shop_domain, scope: conn.scope, installed_at: conn.installed_at, sync_enabled: conn.sync_enabled } : null });
});

// ── Vendor: disconnect ────────────────────────────────────────────────────
app.delete("/vendor/shopify/disconnect", vendorAuth, async (req, res) => {
  await VSC.delete(req.vendor);
  res.json({ success: true });
});

// ── Vendor: browse own products (so vendor can see what will be synced) ───
app.get("/vendor/shopify/products", vendorAuth, async (req, res) => {
  const conn = await VSC.get(req.vendor);
  if (!conn) return res.status(404).json({ error: "Shopify store not connected." });
  try {
    const data = await vendorShopifyREST(conn.shop_domain, conn.access_token, '/products.json?limit=50&fields=id,title,variants,images,status,product_type,vendor');
    res.json({ products: data.products || [] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Admin: list all connected vendor stores ───────────────────────────────
app.get("/admin/vendor-sync/connections", adminAuth, async (req, res) => {
  const rows = await VSC.all();
  res.json({ connections: rows.map(r => ({ vendor_name: r.vendor_name, shop_domain: r.shop_domain, scope: r.scope, installed_at: r.installed_at, sync_enabled: r.sync_enabled })) });
});

// ── Admin: browse a vendor's products ─────────────────────────────────────
app.get("/admin/vendor-sync/:vendor/products", adminAuth, async (req, res) => {
  const conn = await VSC.get(req.params.vendor);
  if (!conn) return res.status(404).json({ error: "Vendor store not connected." });
  try {
    const data = await vendorShopifyREST(conn.shop_domain, conn.access_token, '/products.json?limit=100&fields=id,title,variants,images,status,product_type,vendor,body_html,tags');
    const mappings = await VPM.allForVendor(req.params.vendor);
    const mappedVariants = new Set(mappings.map(m => m.vendor_variant_id));
    const products = (data.products || []).map(p => ({
      ...p,
      variants: p.variants.map(v => ({ ...v, mapped: mappedVariants.has(String(v.id)) }))
    }));
    res.json({ products, mappings });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Admin: import vendor product as NEW product on CrosCrow store ──────────
app.post("/admin/vendor-sync/import", adminAuth, async (req, res) => {
  const { vendor_name, vendor_product_id, sync_inventory = true } = req.body || {};
  if (!vendor_name || !vendor_product_id) return res.status(400).json({ error: "vendor_name and vendor_product_id required." });

  const conn = await VSC.get(vendor_name);
  if (!conn) return res.status(404).json({ error: "Vendor not connected." });

  try {
    // Fetch full product from vendor store
    const vData = await vendorShopifyREST(conn.shop_domain, conn.access_token, `/products/${vendor_product_id}.json`);
    const vProduct = vData.product;
    if (!vProduct) throw new Error("Product not found in vendor store.");

    // Build product payload for CrosCrow store
    const productPayload = {
      product: {
        title: vProduct.title,
        body_html: vProduct.body_html || '',
        vendor: vendor_name,
        product_type: vProduct.product_type || '',
        tags: vProduct.tags || '',
        status: 'active',
        variants: vProduct.variants.map(v => ({
          title: v.title,
          price: v.price,
          compare_at_price: v.compare_at_price || null,
          sku: v.sku ? `${vendor_name.slice(0,4).toUpperCase()}-${v.sku}` : '',
          barcode: v.barcode || null,
          inventory_management: sync_inventory ? 'shopify' : null,
          inventory_quantity: parseInt(v.inventory_quantity || 0),
          weight: v.weight,
          weight_unit: v.weight_unit || 'kg',
          requires_shipping: v.requires_shipping !== false,
          taxable: v.taxable !== false,
          option1: v.option1, option2: v.option2, option3: v.option3,
        })),
        options: vProduct.options?.map(o => ({ name: o.name, values: o.values })) || [],
        images: (vProduct.images || []).map(img => ({ src: img.src, alt: img.alt || '' })),
      }
    };

    const created = await croscrowShopifyWrite('/products.json', 'POST', productPayload);
    const newProduct = created.product;
    if (!newProduct) throw new Error("Failed to create product on CrosCrow store.");

    // Save mappings for each variant
    for (let i = 0; i < vProduct.variants.length; i++) {
      const vVariant = vProduct.variants[i];
      const ccVariant = newProduct.variants[i];
      if (ccVariant) {
        await VPM.upsert(vendor_name, String(vVariant.id), {
          vendor_product_id: String(vProduct.id),
          croscrow_product_id: String(newProduct.id),
          croscrow_variant_id: String(ccVariant.id),
          sync_inventory: sync_inventory ? 1 : 0,
          last_synced_at: Date.now(),
        });
      }
    }

    auditLog("admin", "vendor_product_imported", String(newProduct.id), { vendor_name, vendor_product_id, croscrow_product_id: newProduct.id });
    res.json({ success: true, croscrow_product_id: newProduct.id, croscrow_product_title: newProduct.title, status: 'active', variants_mapped: vProduct.variants.length });
  } catch (e) {
    console.error("Import error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Admin: map vendor variant to existing CrosCrow variant ────────────────
app.post("/admin/vendor-sync/map", adminAuth, async (req, res) => {
  const { vendor_name, vendor_product_id, vendor_variant_id, croscrow_product_id, croscrow_variant_id, sync_inventory = true } = req.body || {};
  if (!vendor_name || !vendor_variant_id || !croscrow_product_id || !croscrow_variant_id)
    return res.status(400).json({ error: "vendor_name, vendor_variant_id, croscrow_product_id, croscrow_variant_id required." });

  await VPM.upsert(vendor_name, String(vendor_variant_id), {
    vendor_product_id: String(vendor_product_id || ''),
    croscrow_product_id: String(croscrow_product_id),
    croscrow_variant_id: String(croscrow_variant_id),
    sync_inventory: sync_inventory ? 1 : 0,
    last_synced_at: Date.now(),
  });
  auditLog("admin", "vendor_variant_mapped", vendor_variant_id, { vendor_name, croscrow_product_id, croscrow_variant_id });
  res.json({ success: true });
});

// ── Admin: unmap a variant ────────────────────────────────────────────────
app.delete("/admin/vendor-sync/map/:id", adminAuth, async (req, res) => {
  await VPM.delete(req.params.id);
  res.json({ success: true });
});

// ── Admin: list all mappings ──────────────────────────────────────────────
app.get("/admin/vendor-sync/mappings", adminAuth, async (req, res) => {
  const { vendor_name } = req.query;
  res.json({ mappings: await VPM.all(vendor_name) });
});

// ── Admin: sync inventory for all mapped variants ─────────────────────────
app.post("/admin/vendor-sync/sync-inventory", adminAuth, async (req, res) => {
  const { vendor_name } = req.body || {};
  // Fetch mappings + connections from MongoDB
  const allMappings = await VPM.all(vendor_name);
  const mappings = allMappings.filter(m => m.sync_inventory);

  let synced = 0, errors = [];
  const byVendor = {};
  mappings.forEach(m => { (byVendor[m.vendor_name] = byVendor[m.vendor_name] || []).push(m); });

  const ccToken = await getAccessToken();
  for (const [vName, vMappings] of Object.entries(byVendor)) {
    const conn = await VSC.get(vName);
    if (!conn) continue;
    try {
      // Get vendor's primary location
      const locData = await vendorShopifyREST(conn.shop_domain, conn.access_token, '/locations.json');
      const locationId = locData.locations?.[0]?.id;
      if (!locationId) continue;

      // Get CrosCrow primary location
      const ccLocData = await fetch(`https://${SHOP}.myshopify.com/admin/api/2024-01/locations.json`, { headers: { 'X-Shopify-Access-Token': ccToken } }).then(r => r.json());
      const ccLocationId = ccLocData.locations?.[0]?.id;
      if (!ccLocationId) continue;

      for (const m of vMappings) {
        try {
          // Get vendor variant (price + inventory_item_id)
          const varData = await vendorShopifyREST(conn.shop_domain, conn.access_token, `/variants/${m.vendor_variant_id}.json`);
          const vVariant = varData.variant;
          if (!vVariant) continue;

          // Sync price on CrosCrow variant
          await fetch(`https://${SHOP}.myshopify.com/admin/api/2024-01/variants/${m.croscrow_variant_id}.json`, {
            method: 'PUT',
            headers: { 'X-Shopify-Access-Token': ccToken, 'Content-Type': 'application/json' },
            body: JSON.stringify({ variant: { id: m.croscrow_variant_id, price: vVariant.price, compare_at_price: vVariant.compare_at_price || null } }),
          });

          // Sync inventory
          const invItemId = vVariant.inventory_item_id;
          if (invItemId && vVariant.inventory_management) {
            const invLvl = await vendorShopifyREST(conn.shop_domain, conn.access_token, `/inventory_levels.json?inventory_item_ids=${invItemId}&location_ids=${locationId}`);
            const qty = invLvl.inventory_levels?.[0]?.available ?? 0;

            const ccVarData = await fetch(`https://${SHOP}.myshopify.com/admin/api/2024-01/variants/${m.croscrow_variant_id}.json`, { headers: { 'X-Shopify-Access-Token': ccToken } }).then(r => r.json());
            const ccInvItemId = ccVarData.variant?.inventory_item_id;
            if (ccInvItemId) {
              await fetch(`https://${SHOP}.myshopify.com/admin/api/2024-01/inventory_levels/set.json`, {
                method: 'POST',
                headers: { 'X-Shopify-Access-Token': ccToken, 'Content-Type': 'application/json' },
                body: JSON.stringify({ location_id: ccLocationId, inventory_item_id: ccInvItemId, available: qty }),
              });
            }
          }

          await VPM.updateSynced(m.vendor_name, m.vendor_variant_id);
          synced++;
        } catch (e) { errors.push(`${vName}/${m.vendor_variant_id}: ${e.message}`); }
      }
    } catch (e) { errors.push(`${vName}: ${e.message}`); }
  }

  res.json({ success: true, synced, errors });
});

// ── Admin: search CrosCrow products (for mapping UI) ─────────────────────
app.get("/admin/vendor-sync/croscrow-products", adminAuth, async (req, res) => {
  const { q } = req.query;
  try {
    const path = q ? `/products.json?q=${encodeURIComponent(q)}&limit=20&fields=id,title,variants` : '/products.json?limit=20&fields=id,title,variants';
    const data = await shopifyREST(path);
    res.json({ products: data.products || [] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Penalty helpers ───────────────────────────────────────────────────────
const PENALTY_SECRET = process.env.PENALTY_SECRET || "jarvis-penalty-secret-2024";

function penaltyToken(shopifyId, vendorName) {
  return crypto.createHmac('sha256', PENALTY_SECRET)
    .update(`${shopifyId}:${vendorName}`)
    .digest('hex').slice(0, 24);
}

function verifyPenaltyToken(shopifyId, vendorName, token) {
  return penaltyToken(shopifyId, vendorName) === token;
}

async function triggerPenalty(shopifyId, vendorName, orderName, reason) {
  if (await OP.hasPending(shopifyId, vendorName)) return;
  await OP.insert(shopifyId, vendorName, orderName, reason);
  await OVS.upsert(shopifyId, vendorName, { penalty_triggered: 1 });
  console.log(`⚠️  Penalty triggered: ${orderName} / ${vendorName} — ${reason}`);

  // Email vendor
  const vcfg = await VC.get(vendorName);
  if (vcfg?.email) {
    const reasonLabel = reason === '48hr_breach' ? 'Order not fulfilled within 48 hours' : reason === 'eta_breach' ? 'Order not dispatched by committed ETA date' : 'Manual penalty by admin';
    const html = emailBase(`⚠️ Penalty Applied: ${orderName || shopifyId}`, '#ef4444', `
      <div class="subtitle">A fulfilment penalty has been applied to your account for order <strong>${orderName || shopifyId}</strong>.</div>
      <div style="background:#2d0a0a;border:2px solid #ef4444;border-radius:8px;padding:16px 20px;margin-bottom:20px;text-align:center">
        <div style="font-size:13px;font-weight:700;color:#fca5a5;margin-bottom:4px;">🚨 PENALTY TRIGGERED</div>
        <div style="font-size:12px;color:#fca5a5;">Reason: ${reasonLabel}</div>
      </div>
      <div class="info-box">
        <div class="info-row"><span class="info-label">Order</span><span class="info-val" style="color:#6366f1">${orderName || shopifyId}</span></div>
        <div class="info-row"><span class="info-label">Vendor</span><span class="info-val">${vendorName}</span></div>
        <div class="info-row"><span class="info-label">Status</span><span class="info-val" style="color:#ef4444;font-weight:700">Pending admin review</span></div>
      </div>
      <p style="font-size:13px;color:#6b7280;line-height:1.7">
        This penalty is currently under admin review. If confirmed, it will be deducted from your next settlement invoice.
        If you believe this is an error, please contact us immediately on WhatsApp.
      </p>
      <div style="text-align:center">
        <a href="https://wa.me/${process.env.WHATSAPP_NUMBER}?text=${encodeURIComponent(`Hi CrosCrow, I want to dispute the penalty for order ${orderName || shopifyId}`)}"
           style="display:inline-flex;align-items:center;gap:8px;background:#25d366;color:#fff;text-decoration:none;font-weight:700;font-size:13px;padding:10px 22px;border-radius:8px;">
          <img src="https://upload.wikimedia.org/wikipedia/commons/6/6b/WhatsApp.svg" width="18" height="18" style="vertical-align:middle" alt="WhatsApp">
          Dispute on WhatsApp
        </a>
      </div>
    `);
    await sendEmail({ to: vcfg.email, subject: `⚠️ Penalty Applied: ${orderName || shopifyId}`, html, shopifyId, trigger: 'penalty_triggered' });
  }
}

// ── Warning email template ────────────────────────────────────────────────
function templateFulfilmentWarning({ order, vendorName, hoursElapsed, delayLink }) {
  const body = `
    <div class="subtitle">Action required for order <strong>${order.name}</strong> assigned to <strong>${vendorName}</strong>.</div>

    <div style="background:#fffbeb;border:2px solid #f59e0b;border-radius:8px;padding:16px 20px;margin-bottom:20px;text-align:center">
      <div style="font-size:14px;font-weight:700;color:#92400e;margin-bottom:4px;">⏰ ${hoursElapsed} Hours Since Order Confirmed</div>
      <div style="font-size:13px;color:#7c3aed;font-weight:600">You have ${48 - hoursElapsed} hours left before a penalty is applied.</div>
    </div>

    <div class="info-box">
      <div class="info-row"><span class="info-label">Order ID</span><span class="info-val" style="color:#6366f1">${order.name}</span></div>
      <div class="info-row"><span class="info-label">Deadline</span><span class="info-val" style="color:#dc2626;font-weight:700">48 hours from confirmation</span></div>
    </div>

    <div style="background:#fef2f2;border:2px solid #fca5a5;border-radius:8px;padding:14px 18px;margin-bottom:20px;">
      <div style="font-weight:700;color:#991b1b;font-size:13px;margin-bottom:6px;">⚠️ Penalty Warning</div>
      <div style="font-size:12px;color:#7f1d1d;line-height:1.7">
        If this order is not handed over to courier within <strong>48 hours</strong> of confirmation, a penalty will be automatically applied to your settlement account.
        <br><br>
        🌟 <strong>Fulfil before 24 hours</strong> from confirmation to earn a seller reward!
      </div>
    </div>

    <div style="background:#f0f9ff;border:2px solid #bae6fd;border-radius:8px;padding:14px 18px;margin-bottom:20px;">
      <div style="font-weight:700;color:#0369a1;font-size:13px;margin-bottom:8px;">🕐 Unable to Fulfil on Time?</div>
      <div style="font-size:12px;color:#0c4a6e;line-height:1.7;margin-bottom:12px;">
        If you cannot fulfil this order within 48 hours, please submit a delay remark with the reason and your expected dispatch date.
        This will automatically notify the customer and may prevent or reduce the penalty.
      </div>
      <div style="text-align:center">
        <a href="${delayLink}" style="display:inline-block;background:#0369a1;color:#fff;text-decoration:none;font-weight:700;font-size:13px;padding:10px 24px;border-radius:8px;">
          Submit Delay Remark →
        </a>
      </div>
    </div>

    <div style="text-align:center;margin-bottom:12px;">
      <a href="https://wa.me/${process.env.WHATSAPP_NUMBER}?text=${encodeURIComponent(`Hi CrosCrow, I need help with order ${order.name} (${vendorName})`)}"
         style="display:inline-flex;align-items:center;gap:8px;background:#25d366;color:#fff;text-decoration:none;font-weight:700;font-size:13px;padding:10px 22px;border-radius:8px;">
        <img src="https://upload.wikimedia.org/wikipedia/commons/6/6b/WhatsApp.svg" width="18" height="18" style="vertical-align:middle" alt="WhatsApp">
        Contact Support on WhatsApp
      </a>
    </div>
    <div style="text-align:center;margin-bottom:8px;">
      <a href="https://autoaijarvis1.onrender.com/" style="display:inline-block;background:#6366f1;color:#fff;text-decoration:none;font-weight:700;font-size:13px;padding:11px 28px;border-radius:8px;letter-spacing:0.5px;">Login to Vendor Panel →</a>
    </div>
  `;
  return emailBase(`⚠️ 24hr Fulfilment Warning: ${order.name}`, '#f59e0b', body);
}

// ── Vendor delay remark page (public — token auth) ────────────────────────
app.get("/vendor/delay-remark", async (req, res) => {
  const { order, vendor, token } = req.query;
  if (!order || !vendor || !token || !verifyPenaltyToken(order, vendor, token)) {
    return res.status(403).send("<h2>Invalid or expired link.</h2>");
  }
  const existing = await DR.latest(order, vendor);
  res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Delay Remark — CrosCrow</title>
<style>
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0f172a;color:#e2e8f0;margin:0;padding:20px;display:flex;align-items:center;justify-content:center;min-height:100vh}
  .card{background:#1e293b;border-radius:16px;padding:32px;max-width:480px;width:100%;box-shadow:0 4px 32px rgba(0,0,0,.5)}
  h1{font-size:20px;margin:0 0 4px;color:#f8fafc}
  .sub{font-size:13px;color:#94a3b8;margin-bottom:24px}
  label{display:block;font-size:12px;font-weight:600;color:#94a3b8;margin-bottom:6px;text-transform:uppercase;letter-spacing:.5px}
  textarea,input{width:100%;box-sizing:border-box;background:#0f172a;border:1px solid #334155;border-radius:8px;color:#f8fafc;font-size:14px;padding:10px 12px;margin-bottom:16px;outline:none}
  textarea{height:100px;resize:vertical}
  input[type=date]{cursor:pointer}
  button{width:100%;background:#6366f1;color:#fff;border:none;border-radius:8px;font-size:15px;font-weight:700;padding:12px;cursor:pointer}
  button:hover{background:#4f46e5}
  .success{background:#064e3b;border:1px solid #10b981;border-radius:8px;padding:16px;text-align:center;color:#6ee7b7;font-weight:600;display:none}
  .warn{background:#451a03;border:1px solid #f59e0b;border-radius:8px;padding:12px;font-size:13px;color:#fde68a;margin-bottom:16px}
</style></head><body>
<div class="card">
  <h1>⏰ Delay Remark</h1>
  <div class="sub">Order <strong>${order}</strong> · ${vendor}</div>
  ${existing ? `<div class="warn">⚠️ You already submitted a delay remark with ETA <strong>${existing.eta_date}</strong>. Submitting again will update it.</div>` : ''}
  <div class="success" id="ok">✅ Delay remark submitted. Customer and admin have been notified.</div>
  <form id="f">
    <label>Reason for delay</label>
    <textarea name="reason" required placeholder="Explain why fulfilment is delayed...">${existing?.reason || ''}</textarea>
    <label>Expected dispatch date</label>
    <input type="date" name="eta_date" required value="${existing?.eta_date || ''}" min="${new Date().toISOString().split('T')[0]}">
    <button type="submit">Submit Delay Remark</button>
  </form>
</div>
<script>
document.getElementById('f').onsubmit = async e => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const r = await fetch('/vendor/delay-remark', {
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ order:'${order}', vendor:'${vendor}', token:'${token}', reason:fd.get('reason'), eta_date:fd.get('eta_date') })
  });
  const d = await r.json();
  if (d.success) { document.getElementById('ok').style.display='block'; e.target.style.display='none'; }
  else alert(d.error || 'Error submitting remark');
};
</script></body></html>`);
});

app.post("/vendor/delay-remark", async (req, res) => {
  const { order, vendor, token, reason, eta_date } = req.body || {};
  if (!order || !vendor || !token || !verifyPenaltyToken(order, vendor, token)) {
    return res.status(403).json({ error: "Invalid or expired link." });
  }
  if (!reason || !eta_date) return res.status(400).json({ error: "reason and eta_date required." });

  await DR.insert(order, vendor, reason, eta_date);

  // Fetch order details to send emails
  try {
    const shopifyOrder = await shopifyREST(`/orders/${order}.json?fields=id,name,email,shipping_address,line_items`);
    const ord = shopifyOrder?.order;
    const customerEmail = ord?.email;
    const adminEmail = (await getSmtpConfig())?.user;
    const etaFormatted = new Date(eta_date + 'T00:00:00').toLocaleDateString('en-IN', { day:'numeric', month:'long', year:'numeric' });

    const delayHtmlCustomer = emailBase(`We're Sorry — Your Order Is Delayed`, '#f59e0b', `
      <div class="subtitle">We sincerely apologise for the delay in fulfilling your order.</div>
      <div class="info-box">
        <div class="info-row"><span class="info-label">Order ID</span><span class="info-val" style="color:#6366f1">${ord?.name || order}</span></div>
        <div class="info-row"><span class="info-label">Expected Dispatch By</span><span class="info-val" style="color:#10b981;font-weight:700">${etaFormatted}</span></div>
      </div>
      <div style="background:#fef9c3;border:1px solid #fde047;border-radius:8px;padding:14px 18px;margin-bottom:16px;font-size:13px;color:#713f12;line-height:1.7">
        We understand this is inconvenient and apologise for the delay. Your order is being prepared and will be dispatched by <strong>${etaFormatted}</strong>.
        You will receive a shipping confirmation with tracking details as soon as it's dispatched.
      </div>
      <p style="font-size:13px;color:#6b7280">If you have any questions, please reply to this email or contact us on WhatsApp.</p>
    `);

    const delayHtmlAdmin = emailBase(`Vendor Delay Remark: ${ord?.name || order}`, '#f59e0b', `
      <div class="subtitle">Vendor <strong>${vendor}</strong> has submitted a delay remark.</div>
      <div class="info-box">
        <div class="info-row"><span class="info-label">Order</span><span class="info-val">${ord?.name || order}</span></div>
        <div class="info-row"><span class="info-label">Vendor</span><span class="info-val">${vendor}</span></div>
        <div class="info-row"><span class="info-label">ETA Dispatch</span><span class="info-val" style="color:#f59e0b;font-weight:700">${etaFormatted}</span></div>
        <div class="info-row"><span class="info-label">Reason</span><span class="info-val">${reason}</span></div>
      </div>
      <p style="font-size:12px;color:#6b7280">If the order is not dispatched by ${etaFormatted}, it will be automatically moved to the penalty queue.</p>
    `);

    if (customerEmail) await sendEmail({ to: customerEmail, subject: `Important Update: Your Order ${ord?.name || order} is Delayed`, html: delayHtmlCustomer, shopifyId: order, trigger: 'delay_remark_customer' });
    if (adminEmail) await sendEmail({ to: adminEmail, subject: `Vendor Delay Remark: ${ord?.name || order} — ${vendor}`, html: delayHtmlAdmin, shopifyId: order, trigger: 'delay_remark_admin' });
  } catch (e) {
    console.error("Delay remark email error:", e.message);
  }

  res.json({ success: true });
});

// ── Admin penalty endpoints ────────────────────────────────────────────────
// ── Force-run penalty cron now (for testing) ──────────────────────────────
app.post("/admin/penalties/run-cron", adminAuth, async (req, res) => {
  await penaltyCronJob();
  res.json({ success: true, message: "Penalty cron ran." });
});

// ── Send test warning email to vendor ────────────────────────────────────
app.post("/admin/penalties/test-warning", adminAuth, async (req, res) => {
  const { shopify_id, vendor_name, order_name } = req.body || {};
  if (!shopify_id || !vendor_name) return res.status(400).json({ error: "shopify_id and vendor_name required." });
  const vcfg = await VC.get(vendor_name);
  if (!vcfg?.email) return res.status(400).json({ error: `No email found for vendor "${vendor_name}". Set it in Vendors → vendor config.` });
  const token = penaltyToken(shopify_id, vendor_name);
  const delayLink = `${SERVER_BASE}/vendor.html?openOrder=${shopify_id}&action=delay`;
  const html = templateFulfilmentWarning({ order: { name: order_name || shopify_id }, vendorName: vendor_name, hoursElapsed: 24, delayLink });
  await sendEmail({ to: vcfg.email, subject: `[TEST] ⚠️ 24hr Warning: Fulfil ${order_name || shopify_id} Now`, html, shopifyId: shopify_id, trigger: 'test_warning' });
  res.json({ success: true, message: `Warning email sent to ${vcfg.email}` });
});

// ── Manually trigger a test penalty ──────────────────────────────────────
app.post("/admin/penalties/test-trigger", adminAuth, async (req, res) => {
  const { shopify_id, vendor_name, order_name } = req.body || {};
  if (!shopify_id || !vendor_name) return res.status(400).json({ error: "shopify_id and vendor_name required." });
  triggerPenalty(shopify_id, vendor_name, order_name || shopify_id, 'manual_test');
  res.json({ success: true, message: `Penalty triggered for ${vendor_name} on ${order_name || shopify_id}` });
});

app.get("/admin/penalties", adminAuth, async (req, res) => {
  const { status } = req.query;
  res.json({ penalties: await OP.all(status) });
});

app.put("/admin/penalties/:id", adminAuth, async (req, res) => {
  const { action, penalty_amount, admin_note } = req.body || {};
  const p = await OP.get(req.params.id);
  if (!p) return res.status(404).json({ error: "Penalty not found." });
  if (!['confirm','cancel'].includes(action)) return res.status(400).json({ error: "action must be confirm or cancel." });

  const status = action === 'confirm' ? 'confirmed' : 'cancelled';
  const amount = action === 'confirm' ? (parseFloat(penalty_amount) || 0) : 0;
  await OP.resolve(req.params.id, status, amount, admin_note);
  auditLog("admin", `penalty_${status}`, req.params.id, { vendor: p.vendor_name, amount });

  // Email vendor on confirm or cancel
  const vcfg = await VC.get(p.vendor_name);
  if (vcfg?.email) {
    const isConfirm = status === 'confirmed';
    const html = emailBase(
      isConfirm ? `🚨 Penalty Confirmed: ${p.order_name}` : `✅ Penalty Cancelled: ${p.order_name}`,
      isConfirm ? '#ef4444' : '#10b981',
      `<div class="subtitle">${isConfirm
        ? `A penalty of <strong>₹${amount.toFixed(2)}</strong> has been confirmed for order <strong>${p.order_name}</strong> and will be deducted from your next settlement.`
        : `The penalty for order <strong>${p.order_name}</strong> has been cancelled by admin. No deduction will be made.`
      }</div>
      <div class="info-box">
        <div class="info-row"><span class="info-label">Order</span><span class="info-val" style="color:#6366f1">${p.order_name}</span></div>
        <div class="info-row"><span class="info-label">Decision</span><span class="info-val" style="color:${isConfirm?'#ef4444':'#10b981'};font-weight:700">${isConfirm?'CONFIRMED':'CANCELLED'}</span></div>
        ${isConfirm ? `<div class="info-row"><span class="info-label">Deduction</span><span class="info-val" style="color:#ef4444;font-weight:700">₹${amount.toFixed(2)}</span></div>` : ''}
        ${admin_note ? `<div class="info-row"><span class="info-label">Admin Note</span><span class="info-val">${admin_note}</span></div>` : ''}
      </div>
      ${isConfirm ? `<p style="font-size:13px;color:#6b7280;line-height:1.7">This amount will appear in your next settlement invoice. To dispute, contact us on WhatsApp.</p>
      <div style="text-align:center"><a href="https://wa.me/${process.env.WHATSAPP_NUMBER}?text=${encodeURIComponent(`Hi CrosCrow, I want to dispute the penalty for order ${p.order_name}`)}"
         style="display:inline-flex;align-items:center;gap:8px;background:#25d366;color:#fff;text-decoration:none;font-weight:700;font-size:13px;padding:10px 22px;border-radius:8px;">
        <img src="https://upload.wikimedia.org/wikipedia/commons/6/6b/WhatsApp.svg" width="18" height="18" style="vertical-align:middle" alt="WhatsApp"> Dispute on WhatsApp</a></div>`
      : `<p style="font-size:13px;color:#6b7280;line-height:1.7">No action is required from your side. Thank you for your continued partnership with CrosCrow.</p>`}
    `);
    await sendEmail({ to: vcfg.email, subject: isConfirm ? `🚨 Penalty Confirmed: ${p.order_name}` : `✅ Penalty Cancelled: ${p.order_name}`, html, shopifyId: p.shopify_id, trigger: `penalty_${status}` });
  }

  res.json({ success: true, status, amount });
});

// ── Background cron: penalty & warning checker (runs every 15 min) ────────
const PENALTY_CHECK_MS = 15 * 60 * 1000;
const HR24 = 24 * 60 * 60 * 1000;
const HR48 = 48 * 60 * 60 * 1000;
const SERVER_BASE = process.env.SERVER_URL || `http://localhost:${process.env.PORT || 3001}`;

async function penaltyCronJob() {
  try {
    const now = Date.now();
    const watchStages = ['confirmed','partial'];
    const rows = await mdb.collection('order_vendor_stage').find(
      { stage: { $in: ['confirmed','partial'] }, stage_started_at: { $gt: 0 } },
      { projection: { _id: 0 } }
    ).toArray();

    for (const row of rows) {
      const elapsed = now - row.stage_started_at;
      const sid = row.shopify_id;
      const vendor = row.vendor_name;

      // Fetch order name (cheaply from Shopify if needed)
      let orderName = '';
      try {
        const od = await shopifyREST(`/orders/${sid}.json?fields=id,name`);
        orderName = od?.order?.name || '';
      } catch {}

      // 24hr warning
      if (elapsed >= HR24 && !row.warning_sent) {
        const token = penaltyToken(sid, vendor);
        const delayLink = `${SERVER_BASE}/vendor.html?openOrder=${sid}&action=delay`;
        const vcfg = await VC.get(vendor);
        if (vcfg?.email) {
          const ord = { name: orderName || sid };
          const html = templateFulfilmentWarning({ order: ord, vendorName: vendor, hoursElapsed: Math.floor(elapsed / 3600000), delayLink });
          await sendEmail({ to: vcfg.email, subject: `⚠️ 24hr Warning: Fulfil ${orderName || sid} Now`, html, shopifyId: sid, trigger: 'penalty_warning' });
        }
        await OVS.upsert(sid, vendor, { warning_sent: 1 });
        console.log(`📧  24hr warning sent: ${orderName} / ${vendor}`);
      }

      // 48hr penalty trigger
      if (elapsed >= HR48 && !row.penalty_triggered) {
        triggerPenalty(sid, vendor, orderName, '48hr_breach');
      }
    }

    // ETA-date penalty check for delay remarks
    const today = new Date().toISOString().split('T')[0];
    const etaPast = await DR.expiredEta(today);
    for (const dr of etaPast) {
      const ovs = await mdb.collection('order_vendor_stage').findOne({ shopify_id: dr.shopify_id, vendor_name: dr.vendor_name }, { projection: { stage: 1, _id: 0 } });
      const fulfilledStages = ['pickup','transit','delivered','rto','cancelled'];
      if (!ovs || !fulfilledStages.includes(ovs.stage)) {
        let orderName = '';
        try { const od = await shopifyREST(`/orders/${dr.shopify_id}.json?fields=name`); orderName = od?.order?.name || ''; } catch {}
        triggerPenalty(dr.shopify_id, dr.vendor_name, orderName, 'eta_breach');
      }
      await DR.markEtaPenalty(dr.id);
    }
  } catch (e) {
    console.error("⚠️  Penalty cron error:", e.message);
  }
}

setInterval(penaltyCronJob, PENALTY_CHECK_MS);

// ══════════════════════════════════════════════════════════════════════════
//  WEEKLY REPORT SYSTEM
// ══════════════════════════════════════════════════════════════════════════

// ── Report settings (MongoDB) ─────────────────────────────────────────────
const RS = {
  async get() {
    if (mdb) return mdb.collection('report_settings').findOne({}, { projection: { _id: 0 } }) || {};
    return {};
  },
  async save(fields) {
    if (mdb) await mdb.collection('report_settings').updateOne({}, { $set: { ...fields, _updated: new Date() } }, { upsert: true });
  },
};

// ── Core report data generator ────────────────────────────────────────────
async function generateReport(fromDate, toDate) {
  const allOrders = await fetchAllOrders("any", fromDate + "T00:00:00Z", toDate + "T23:59:59Z");
  const metasArr = await mdb.collection('order_meta').find({}, { projection: { _id: 0 } }).toArray();
  const metas = Object.fromEntries(metasArr.map(m => [m.shopify_id, m]));
  const vendorStages = await mdb.collection('order_vendor_stage').find({}, { projection: { _id: 0 } }).toArray();
  const vsMap = {}; // { shopify_id: { vendor_name: stage } }
  vendorStages.forEach(r => {
    if (!vsMap[r.shopify_id]) vsMap[r.shopify_id] = {};
    vsMap[r.shopify_id][r.vendor_name] = r.stage;
  });

  const summary = { total: 0, fulfilled: 0, delivered: 0, in_transit: 0, partial_shopify: 0, unfulfilled: 0, cancelled: 0, rto: 0 };
  const breakdown = { prepaid_pending: 0, partial_pending: 0, confirmed_pending: 0, new_pending: 0, ready_pending: 0, hold_pending: 0 };
  const vendorMap = {};
  const urgentOrders = [];

  allOrders.forEach(o => {
    const sid = String(o.id);
    const meta = metas[sid] || {};
    const stage = meta.stage || 'new';
    const payType = meta.payment_type || (o.financial_status === 'paid' ? 'prepaid' : 'cod');
    const shopifyFulfill = o.fulfillment_status; // 'fulfilled' | 'partial' | null
    const isCancelled = !!o.cancelled_at || o.financial_status === 'voided';
    const vendors = [...new Set((o.line_items || []).map(li => li.vendor).filter(Boolean))];
    const ageHours = Math.floor((Date.now() - new Date(o.created_at).getTime()) / 3600000);

    summary.total++;

    // Determine order fulfillment: prefer our stage if set meaningfully, else fall back to Shopify
    const isOurDelivered  = stage === 'delivered';
    const isOurTransit    = stage === 'transit';
    const isOurRTO        = stage === 'rto';
    const isOurCancelled  = stage === 'cancelled' || isCancelled;
    const isShopifyFulfilled = shopifyFulfill === 'fulfilled';
    const isShopifyPartial   = shopifyFulfill === 'partial';

    if (isOurCancelled) {
      summary.cancelled++;
    } else if (isOurRTO) {
      summary.rto++;
    } else if (isOurDelivered || (isShopifyFulfilled && stage === 'new')) {
      // delivered: our stage says delivered, OR Shopify says fulfilled but we haven't updated stage
      summary.fulfilled++;
      summary.delivered++;
    } else if (isOurTransit || isShopifyFulfilled) {
      summary.fulfilled++;
      summary.in_transit++;
    } else if (isShopifyPartial) {
      // Some line items shipped, some not — partially fulfilled
      summary.partial_shopify++;
      summary.unfulfilled++;
      if (payType === 'prepaid')       breakdown.prepaid_pending++;
      else if (meta.advance_paid > 0)  breakdown.partial_pending++;
      else if (stage === 'confirmed')  breakdown.confirmed_pending++;
      else if (stage === 'ready' || stage === 'pickup') breakdown.ready_pending++;
      else if (stage === 'hold')       breakdown.hold_pending++;
      else                             breakdown.new_pending++;
      urgentOrders.push({ order_name: o.name, shopify_id: sid, stage: 'partial-shipped', payment_type: payType, advance_paid: meta.advance_paid || 0, age_hours: ageHours, age_label: ageHours < 24 ? `${ageHours}h` : `${Math.floor(ageHours/24)}d ${ageHours%24}h`, vendors: vendors.join(', ') || '—', customer: o.shipping_address?.name || o.email || '—' });
    } else {
      summary.unfulfilled++;
      if (payType === 'prepaid')       breakdown.prepaid_pending++;
      else if (meta.advance_paid > 0)  breakdown.partial_pending++;
      else if (stage === 'confirmed')  breakdown.confirmed_pending++;
      else if (stage === 'ready' || stage === 'pickup') breakdown.ready_pending++;
      else if (stage === 'hold')       breakdown.hold_pending++;
      else                             breakdown.new_pending++;
      urgentOrders.push({ order_name: o.name, shopify_id: sid, stage, payment_type: payType, advance_paid: meta.advance_paid || 0, age_hours: ageHours, age_label: ageHours < 24 ? `${ageHours}h` : `${Math.floor(ageHours/24)}d ${ageHours%24}h`, vendors: vendors.join(', ') || '—', customer: o.shipping_address?.name || o.email || '—' });
    }

    // Per-vendor breakdown — use per-line-item fulfillment_status from Shopify
    vendors.forEach(vn => {
      if (!vendorMap[vn]) vendorMap[vn] = { name: vn, total: 0, fulfilled: 0, unfulfilled: 0, partial: 0, prepaid_pending: 0, partial_pending: 0, confirmed_pending: 0, new_pending: 0 };
      const myItems = (o.line_items || []).filter(li => li.vendor === vn);
      const totalItems = myItems.length;
      const fulfilledItems = myItems.filter(li => li.fulfillment_status === 'fulfilled').length;
      const vStage = vsMap[sid]?.[vn] || stage;
      const vCancelled = isOurCancelled || vStage === 'cancelled';
      const vRTO = isOurRTO || vStage === 'rto';

      if (vCancelled || vRTO) return; // skip cancelled/rto in vendor counts

      vendorMap[vn].total++;

      if (fulfilledItems === totalItems && totalItems > 0) {
        // All this vendor's items are Shopify-fulfilled
        vendorMap[vn].fulfilled++;
      } else if (fulfilledItems > 0) {
        // Some items fulfilled — partially done
        vendorMap[vn].partial++;
        vendorMap[vn].unfulfilled++;
        if (payType === 'prepaid')      vendorMap[vn].prepaid_pending++;
        else if (meta.advance_paid > 0) vendorMap[vn].partial_pending++;
        else if (vStage === 'confirmed' || vStage === 'partial') vendorMap[vn].confirmed_pending++;
        else                            vendorMap[vn].new_pending++;
      } else {
        vendorMap[vn].unfulfilled++;
        if (payType === 'prepaid')      vendorMap[vn].prepaid_pending++;
        else if (meta.advance_paid > 0) vendorMap[vn].partial_pending++;
        else if (vStage === 'confirmed' || vStage === 'partial') vendorMap[vn].confirmed_pending++;
        else                            vendorMap[vn].new_pending++;
      }
    });
  });

  // Sort urgent: prepaid first, then partial advance, then by age desc — cap at 30
  urgentOrders.sort((a, b) => {
    const pri = o => o.payment_type === 'prepaid' ? 0 : o.advance_paid > 0 ? 1 : 2;
    const pd = pri(a) - pri(b);
    if (pd !== 0) return pd;
    return b.age_hours - a.age_hours;
  });
  urgentOrders.splice(30);

  const vendors = Object.values(vendorMap).sort((a, b) => b.unfulfilled - a.unfulfilled);
  return { period: { from: fromDate, to: toDate }, summary, breakdown, vendors, urgentOrders };
}

// ── Admin report email template ───────────────────────────────────────────
function templateAdminReport({ data, period }) {
  const { summary, breakdown, vendors, urgentOrders } = data;
  const fulfillRate = summary.total > 0 ? Math.round((summary.fulfilled / summary.total) * 100) : 0;
  const rateColor = fulfillRate >= 80 ? '#10b981' : fulfillRate >= 50 ? '#f59e0b' : '#ef4444';

  const breakdownRows = [
    summary.in_transit      > 0 ? `<tr><td style="padding:7px 0;color:#6b7280;border-bottom:1px solid #1e293b">🚚 In Transit</td><td style="text-align:right;font-weight:700;color:#6366f1;padding:7px 0;border-bottom:1px solid #1e293b">${summary.in_transit}</td></tr>` : '',
    summary.delivered       > 0 ? `<tr><td style="padding:7px 0;color:#6b7280;border-bottom:1px solid #1e293b">✅ Delivered</td><td style="text-align:right;font-weight:700;color:#10b981;padding:7px 0;border-bottom:1px solid #1e293b">${summary.delivered}</td></tr>` : '',
    summary.partial_shopify > 0 ? `<tr><td style="padding:7px 0;color:#f59e0b;border-bottom:1px solid #1e293b">⚡ Partially Shipped (some items pending)</td><td style="text-align:right;font-weight:700;color:#f59e0b;padding:7px 0;border-bottom:1px solid #1e293b">${summary.partial_shopify}</td></tr>` : '',
    breakdown.prepaid_pending  > 0 ? `<tr><td style="padding:7px 0;color:#ef4444;border-bottom:1px solid #1e293b">🔴 Prepaid — Not Shipped</td><td style="text-align:right;font-weight:700;color:#ef4444;padding:7px 0;border-bottom:1px solid #1e293b">${breakdown.prepaid_pending}</td></tr>` : '',
    breakdown.partial_pending  > 0 ? `<tr><td style="padding:7px 0;color:#f59e0b;border-bottom:1px solid #1e293b">🟡 Advance Collected — Not Shipped</td><td style="text-align:right;font-weight:700;color:#f59e0b;padding:7px 0;border-bottom:1px solid #1e293b">${breakdown.partial_pending}</td></tr>` : '',
    breakdown.confirmed_pending > 0 ? `<tr><td style="padding:7px 0;color:#6b7280;border-bottom:1px solid #1e293b">📦 Confirmed — Awaiting Dispatch</td><td style="text-align:right;font-weight:700;color:#e2e8f0;padding:7px 0;border-bottom:1px solid #1e293b">${breakdown.confirmed_pending}</td></tr>` : '',
    breakdown.ready_pending    > 0 ? `<tr><td style="padding:7px 0;color:#6b7280;border-bottom:1px solid #1e293b">🏷️ Ready / Pickup Pending</td><td style="text-align:right;font-weight:700;color:#e2e8f0;padding:7px 0;border-bottom:1px solid #1e293b">${breakdown.ready_pending}</td></tr>` : '',
    breakdown.new_pending      > 0 ? `<tr><td style="padding:7px 0;color:#6b7280;border-bottom:1px solid #1e293b">🆕 New — Not Actioned</td><td style="text-align:right;font-weight:700;color:#e2e8f0;padding:7px 0;border-bottom:1px solid #1e293b">${breakdown.new_pending}</td></tr>` : '',
    breakdown.hold_pending     > 0 ? `<tr><td style="padding:7px 0;color:#6b7280;border-bottom:1px solid #1e293b">⏸️ On Hold</td><td style="text-align:right;font-weight:700;color:#e2e8f0;padding:7px 0;border-bottom:1px solid #1e293b">${breakdown.hold_pending}</td></tr>` : '',
    summary.cancelled    > 0 ? `<tr><td style="padding:7px 0;color:#6b7280;border-bottom:1px solid #1e293b">❌ Cancelled</td><td style="text-align:right;font-weight:700;color:#6b7280;padding:7px 0;border-bottom:1px solid #1e293b">${summary.cancelled}</td></tr>` : '',
    summary.rto          > 0 ? `<tr><td style="padding:7px 0;color:#6b7280">↩️ RTO</td><td style="text-align:right;font-weight:700;color:#6b7280;padding:7px 0">${summary.rto}</td></tr>` : '',
  ].filter(Boolean).join('');

  const vendorRows = vendors.slice(0, 10).map(v => `
    <tr>
      <td style="padding:8px 10px;font-size:12px;color:#e2e8f0;border-bottom:1px solid #1e293b">${v.name}</td>
      <td style="padding:8px 10px;text-align:center;font-size:12px;font-weight:700;color:#a5b4fc;border-bottom:1px solid #1e293b">${v.total}</td>
      <td style="padding:8px 10px;text-align:center;font-size:12px;font-weight:700;color:#10b981;border-bottom:1px solid #1e293b">${v.fulfilled}</td>
      <td style="padding:8px 10px;text-align:center;font-size:12px;font-weight:700;color:${v.unfulfilled>0?'#ef4444':'#6b7280'};border-bottom:1px solid #1e293b">${v.unfulfilled||'—'}</td>
      <td style="padding:8px 10px;text-align:center;font-size:12px;color:${v.confirmed_pending>0?'#6366f1':'#6b7280'};font-weight:${v.confirmed_pending>0?'700':'400'};border-bottom:1px solid #1e293b">${v.confirmed_pending||'—'}</td>
      <td style="padding:8px 10px;text-align:center;font-size:12px;color:${v.partial_pending>0?'#f59e0b':'#6b7280'};font-weight:${v.partial_pending>0?'700':'400'};border-bottom:1px solid #1e293b">${v.partial_pending||'—'}</td>
      <td style="padding:8px 10px;text-align:center;font-size:12px;color:${v.prepaid_pending>0?'#ef4444':'#6b7280'};font-weight:${v.prepaid_pending>0?'700':'400'};border-bottom:1px solid #1e293b">${v.prepaid_pending||'—'}</td>
    </tr>`).join('');

  const urgentRows = urgentOrders.slice(0, 15).map(o => `
    <tr>
      <td style="padding:7px 10px;font-size:12px;color:#a5b4fc;font-weight:700;border-bottom:1px solid #1e293b">${o.order_name}</td>
      <td style="padding:7px 10px;font-size:11px;color:${o.payment_type==='prepaid'?'#ef4444':o.advance_paid>0?'#f59e0b':'#6b7280'};font-weight:700;border-bottom:1px solid #1e293b">${o.payment_type==='prepaid'?'🔴 Prepaid':o.advance_paid>0?`🟡 +₹${o.advance_paid}`:'COD'}</td>
      <td style="padding:7px 10px;font-size:11px;color:#94a3b8;border-bottom:1px solid #1e293b;text-transform:capitalize">${o.stage}</td>
      <td style="padding:7px 10px;font-size:11px;color:${o.age_hours>48?'#ef4444':o.age_hours>24?'#f59e0b':'#94a3b8'};font-weight:${o.age_hours>24?'700':'400'};border-bottom:1px solid #1e293b">${o.age_label}</td>
      <td style="padding:7px 10px;font-size:11px;color:#94a3b8;border-bottom:1px solid #1e293b">${o.vendors}</td>
    </tr>`).join('');

  const body = `
    <div style="text-align:center;margin-bottom:24px">
      <div style="font-size:13px;color:#64748b;font-weight:600;text-transform:uppercase;letter-spacing:1px">CrosCrow Order Report</div>
      <div style="font-size:20px;font-weight:800;color:#f8fafc;margin-top:4px">${period.from} → ${period.to}</div>
    </div>

    <!-- KPI cards -->
    <table style="width:100%;border-collapse:separate;border-spacing:6px;margin-bottom:20px">
      <tr>
        <td style="background:#1e293b;border-radius:10px;padding:14px;text-align:center;width:25%">
          <div style="font-size:28px;font-weight:800;color:#a5b4fc">${summary.total}</div>
          <div style="font-size:11px;color:#64748b;margin-top:2px;font-weight:600">TOTAL ORDERS</div>
        </td>
        <td style="background:#1e293b;border-radius:10px;padding:14px;text-align:center;width:25%">
          <div style="font-size:28px;font-weight:800;color:#10b981">${summary.fulfilled}</div>
          <div style="font-size:11px;color:#64748b;margin-top:2px;font-weight:600">FULFILLED</div>
        </td>
        <td style="background:#1e293b;border-radius:10px;padding:14px;text-align:center;width:25%">
          <div style="font-size:28px;font-weight:800;color:#ef4444">${summary.unfulfilled}</div>
          <div style="font-size:11px;color:#64748b;margin-top:2px;font-weight:600">PENDING</div>
        </td>
        <td style="background:#1e293b;border-radius:10px;padding:14px;text-align:center;width:25%">
          <div style="font-size:28px;font-weight:800;color:${rateColor}">${fulfillRate}%</div>
          <div style="font-size:11px;color:#64748b;margin-top:2px;font-weight:600">FULFIL RATE</div>
        </td>
      </tr>
    </table>

    <!-- Status breakdown -->
    <div style="font-size:13px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:1px;margin-bottom:10px">📊 Order Breakdown</div>
    <table style="width:100%;border-collapse:collapse;margin-bottom:24px;font-size:13px">${breakdownRows}</table>

    ${urgentOrders.length > 0 ? `
    <!-- Urgent task list -->
    <div style="font-size:13px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:1px;margin-bottom:10px">🚨 Action Required — Unfulfilled Orders</div>
    <div style="background:#1e293b;border-radius:10px;overflow:hidden;margin-bottom:24px">
      <table style="width:100%;border-collapse:collapse">
        <tr style="background:#0f172a">
          <th style="padding:9px 10px;text-align:left;font-size:11px;color:#64748b;font-weight:600">ORDER</th>
          <th style="padding:9px 10px;text-align:left;font-size:11px;color:#64748b;font-weight:600">PAYMENT</th>
          <th style="padding:9px 10px;text-align:left;font-size:11px;color:#64748b;font-weight:600">STAGE</th>
          <th style="padding:9px 10px;text-align:left;font-size:11px;color:#64748b;font-weight:600">AGE</th>
          <th style="padding:9px 10px;text-align:left;font-size:11px;color:#64748b;font-weight:600">VENDOR</th>
        </tr>
        ${urgentRows}
      </table>
    </div>` : ''}

    ${vendors.length > 0 ? `
    <!-- Vendor summary -->
    <div style="font-size:13px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:1px;margin-bottom:10px">🏪 Vendor Performance</div>
    <div style="background:#1e293b;border-radius:10px;overflow:hidden;margin-bottom:20px">
      <table style="width:100%;border-collapse:collapse">
        <tr style="background:#0f172a">
          <th style="padding:9px 10px;text-align:left;font-size:11px;color:#64748b;font-weight:600">VENDOR</th>
          <th style="padding:9px 10px;text-align:center;font-size:11px;color:#64748b;font-weight:600">TOTAL</th>
          <th style="padding:9px 10px;text-align:center;font-size:11px;color:#64748b;font-weight:600">DONE</th>
          <th style="padding:9px 10px;text-align:center;font-size:11px;color:#64748b;font-weight:600">PENDING</th>
          <th style="padding:9px 10px;text-align:center;font-size:11px;color:#6366f1;font-weight:600">CONFIRMED</th>
          <th style="padding:9px 10px;text-align:center;font-size:11px;color:#f59e0b;font-weight:600">ADVANCE</th>
          <th style="padding:9px 10px;text-align:center;font-size:11px;color:#ef4444;font-weight:600">PREPAID</th>
        </tr>
        ${vendorRows}
      </table>
    </div>` : ''}

    <p style="font-size:12px;color:#475569;text-align:center;line-height:1.7">Generated by CrosCrow JARVIS • ${new Date().toLocaleString('en-IN',{timeZone:'Asia/Kolkata'})}</p>
  `;
  return emailBase(`📊 Order Report: ${period.from} → ${period.to}`, '#6366f1', body);
}

// ── Vendor report template ────────────────────────────────────────────────
function templateVendorReport({ vendorName, data, period }) {
  const v = data.vendors.find(vv => vv.name === vendorName) || { total: 0, fulfilled: 0, unfulfilled: 0, prepaid_pending: 0, partial_pending: 0, confirmed_pending: 0, new_pending: 0 };
  const myUrgent = data.urgentOrders.filter(o => o.vendors.includes(vendorName));
  const fulfillRate = v.total > 0 ? Math.round((v.fulfilled / v.total) * 100) : 0;
  const rateColor = fulfillRate >= 80 ? '#10b981' : fulfillRate >= 50 ? '#f59e0b' : '#ef4444';

  const urgentRows = myUrgent.slice(0, 10).map(o => `
    <tr>
      <td style="padding:7px 10px;font-size:12px;color:#a5b4fc;font-weight:700;border-bottom:1px solid #1e293b">${o.order_name}</td>
      <td style="padding:7px 10px;font-size:11px;color:${o.payment_type==='prepaid'?'#ef4444':o.advance_paid>0?'#f59e0b':'#6b7280'};font-weight:700;border-bottom:1px solid #1e293b">${o.payment_type==='prepaid'?'🔴 Prepaid':o.advance_paid>0?`🟡 +₹${o.advance_paid}`:'COD'}</td>
      <td style="padding:7px 10px;font-size:11px;color:#94a3b8;border-bottom:1px solid #1e293b;text-transform:capitalize">${o.stage}</td>
      <td style="padding:7px 10px;font-size:11px;color:${o.age_hours>48?'#ef4444':o.age_hours>24?'#f59e0b':'#94a3b8'};font-weight:${o.age_hours>24?'700':'400'};border-bottom:1px solid #1e293b">${o.age_label}</td>
    </tr>`).join('');

  const body = `
    <div style="text-align:center;margin-bottom:24px">
      <div style="font-size:13px;color:#64748b;font-weight:600;text-transform:uppercase;letter-spacing:1px">Your CrosCrow Performance Report</div>
      <div style="font-size:20px;font-weight:800;color:#f8fafc;margin-top:4px">${period.from} → ${period.to}</div>
    </div>

    <table style="width:100%;border-collapse:separate;border-spacing:6px;margin-bottom:20px">
      <tr>
        <td style="background:#1e293b;border-radius:10px;padding:14px;text-align:center">
          <div style="font-size:28px;font-weight:800;color:#a5b4fc">${v.total}</div>
          <div style="font-size:11px;color:#64748b;margin-top:2px;font-weight:600">YOUR ORDERS</div>
        </td>
        <td style="background:#1e293b;border-radius:10px;padding:14px;text-align:center">
          <div style="font-size:28px;font-weight:800;color:#10b981">${v.fulfilled}</div>
          <div style="font-size:11px;color:#64748b;margin-top:2px;font-weight:600">FULFILLED</div>
        </td>
        <td style="background:#1e293b;border-radius:10px;padding:14px;text-align:center">
          <div style="font-size:28px;font-weight:800;color:#ef4444">${v.unfulfilled}</div>
          <div style="font-size:11px;color:#64748b;margin-top:2px;font-weight:600">PENDING</div>
        </td>
        <td style="background:#1e293b;border-radius:10px;padding:14px;text-align:center">
          <div style="font-size:28px;font-weight:800;color:${rateColor}">${fulfillRate}%</div>
          <div style="font-size:11px;color:#64748b;margin-top:2px;font-weight:600">YOUR RATE</div>
        </td>
      </tr>
    </table>

    ${v.prepaid_pending > 0 ? `<div style="background:#2d0a0a;border:2px solid #ef4444;border-radius:8px;padding:14px 18px;margin-bottom:16px;font-size:13px;color:#fca5a5;font-weight:700;text-align:center;">🔴 You have ${v.prepaid_pending} prepaid order${v.prepaid_pending>1?'s':''} waiting — please ship immediately!</div>` : ''}
    ${v.partial_pending > 0 ? `<div style="background:#2d1a00;border:2px solid #f59e0b;border-radius:8px;padding:14px 18px;margin-bottom:16px;font-size:13px;color:#fde68a;font-weight:700;text-align:center;">🟡 ${v.partial_pending} order${v.partial_pending>1?'s':''} with advance collected — dispatch soon to avoid penalties.</div>` : ''}

    ${myUrgent.length > 0 ? `
    <div style="font-size:13px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:1px;margin-bottom:10px">📋 Your Pending Orders</div>
    <div style="background:#1e293b;border-radius:10px;overflow:hidden;margin-bottom:20px">
      <table style="width:100%;border-collapse:collapse">
        <tr style="background:#0f172a">
          <th style="padding:9px 10px;text-align:left;font-size:11px;color:#64748b;font-weight:600">ORDER</th>
          <th style="padding:9px 10px;text-align:left;font-size:11px;color:#64748b;font-weight:600">PAYMENT</th>
          <th style="padding:9px 10px;text-align:left;font-size:11px;color:#64748b;font-weight:600">STAGE</th>
          <th style="padding:9px 10px;text-align:left;font-size:11px;color:#64748b;font-weight:600">AGE</th>
        </tr>
        ${urgentRows}
      </table>
    </div>` : `<div style="text-align:center;padding:20px;color:#10b981;font-weight:700;font-size:14px">🎉 All your orders are fulfilled — great work, ${vendorName}!</div>`}

    <p style="font-size:12px;color:#475569;text-align:center;line-height:1.7">Keep up the great work! Fast fulfilment earns seller rewards on CrosCrow.</p>

    <div style="text-align:center;margin-top:4px;margin-bottom:8px;">
      <a href="https://autoaijarvis1.onrender.com/" style="display:inline-block;background:#6366f1;color:#fff;text-decoration:none;font-weight:700;font-size:13px;padding:11px 28px;border-radius:8px;letter-spacing:0.5px;">Login to Vendor Panel →</a>
    </div>
  `;
  return emailBase(`📊 Your Report: ${period.from} → ${period.to}`, '#6366f1', body);
}

// ── Send report helper ────────────────────────────────────────────────────
async function sendReport(fromDate, toDate) {
  const cfg = await getSmtpConfig();
  if (!cfg?.host) { console.log('⚠️  Report: SMTP not configured'); return { sent: 0, errors: [] }; }
  const settings = await RS.get();
  const data = await generateReport(fromDate, toDate);
  let sent = 0; const errors = [];

  // Admin + staff emails
  const adminEmails = [cfg.adminEmail, ...(settings.staff_emails || '').split(',').map(e => e.trim())].filter(Boolean);
  const adminHtml = templateAdminReport({ data, period: { from: fromDate, to: toDate } });
  for (const email of adminEmails) {
    try {
      await sendEmail({ to: email, subject: `📊 CrosCrow Order Report: ${fromDate} → ${toDate}`, html: adminHtml, shopifyId: 'report', trigger: 'weekly_report_admin' });
      sent++;
    } catch (e) { errors.push(`${email}: ${e.message}`); }
  }

  // Vendor emails (if enabled)
  if (settings.send_to_vendors) {
    const vcfgs = await VC.all();
    for (const vc of vcfgs) {
      if (!vc.email) continue;
      const vHtml = templateVendorReport({ vendorName: vc.vendor_name, data, period: { from: fromDate, to: toDate } });
      try {
        await sendEmail({ to: vc.email, subject: `📊 Your CrosCrow Report: ${fromDate} → ${toDate}`, html: vHtml, shopifyId: 'report', trigger: 'weekly_report_vendor' });
        sent++;
      } catch (e) { errors.push(`${vc.vendor_name}: ${e.message}`); }
    }
  }

  await RS.save({ last_sent_at: new Date().toISOString() });
  console.log(`📊 Report sent to ${sent} recipients`);
  return { sent, errors, summary: data.summary };
}

// ── Report cron: every Sunday 8am IST ────────────────────────────────────
async function reportCronJob() {
  try {
    const settings = await RS.get();
    if (!settings.auto_send) return;
    const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    if (now.getDay() !== 0) return; // 0 = Sunday
    const hour = now.getHours();
    if (hour !== 8) return; // 8am IST
    const lastSent = settings.last_sent_at ? new Date(settings.last_sent_at) : null;
    if (lastSent && (Date.now() - lastSent.getTime()) < 6 * 3600 * 1000) return; // debounce 6h
    const to   = new Date().toISOString().split('T')[0];
    const from = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString().split('T')[0];
    console.log(`📊 Running weekly report cron (${from} → ${to})`);
    await sendReport(from, to);
  } catch (e) { console.error('Report cron error:', e.message); }
}
setInterval(reportCronJob, 60 * 60 * 1000); // check every hour

// ── Report API endpoints ──────────────────────────────────────────────────
app.get("/admin/reports/settings", adminAuth, async (req, res) => {
  res.json(await RS.get());
});

app.put("/admin/reports/settings", adminAuth, async (req, res) => {
  const { auto_send, staff_emails, send_to_vendors } = req.body || {};
  await RS.save({ auto_send: !!auto_send, staff_emails: staff_emails || '', send_to_vendors: !!send_to_vendors });
  res.json({ success: true });
});

app.get("/admin/reports/preview", adminAuth, async (req, res) => {
  const to   = req.query.to   || new Date().toISOString().split('T')[0];
  const from = req.query.from || new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString().split('T')[0];
  try {
    const data = await generateReport(from, to);
    res.json({ from, to, ...data });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/admin/reports/send", adminAuth, async (req, res) => {
  const to   = req.body.to   || new Date().toISOString().split('T')[0];
  const from = req.body.from || new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString().split('T')[0];
  try {
    const result = await sendReport(from, to);
    res.json({ success: true, ...result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Include confirmed penalties in settlement generation ──────────────────
// Patch: wrap the settlement generate route to add penalty deductions
// (The logic is injected into the existing route via post-insert query)

