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
const { google }     = require("googleapis");
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
      mdb.collection("product_commission_rules").createIndex({ vendor_name: 1, product_id: 1 }, { unique: true, sparse: true }),
      mdb.collection("product_commission_rules").createIndex({ id: 1 }, { unique: true }),
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


// ── Stage priority (higher index = more advanced) ────────────────────────
const STAGE_ORDER = ['new','confirmed','partial','hold','ready','pickup','transit','ofd','delivered','rto','cancelled'];
const TERMINAL_STAGES = ['rto','cancelled']; // permanent overrides — always win, never reversible via tags
function higherStage(a, b) {
  const aTerm = TERMINAL_STAGES.includes(a);
  const bTerm = TERMINAL_STAGES.includes(b);
  // Terminal stages always beat non-terminal
  if (aTerm && !bTerm) return a;
  if (bTerm && !aTerm) return b;
  // Both terminal or both pipeline/hold: use STAGE_ORDER index
  const ia = STAGE_ORDER.indexOf(a ?? 'new');
  const ib = STAGE_ORDER.indexOf(b ?? 'new');
  return ia >= ib ? a : b;
}

// Map Shopify fulfillment object → our internal stage for a vendor
// Returns null if no useful status can be derived
function stageFromShopifyFulfillment(fulfillment) {
  if (!fulfillment) return null;
  const ss = fulfillment.shipment_status;
  if (ss === 'delivered')                                             return 'delivered';
  if (ss === 'in_transit' || ss === 'out_for_delivery' || ss === 'attempted_delivery') return 'transit';
  if (ss === 'failure')                                               return 'rto';
  if (ss === 'ready_for_pickup' || ss === 'picked_up')               return 'pickup';
  if (fulfillment.status === 'success')                               return 'ready';
  return null;
}

// Build a map { vendor_name: stage } from Shopify fulfillments on one order
function vendorStagesFromFulfillments(fulfillments = [], lineItems = []) {
  // Map line_item_id → vendor
  const liVendor = Object.fromEntries(lineItems.map(li => [li.id, li.vendor]).filter(([,v]) => v));
  const result = {};
  for (const f of fulfillments) {
    const derived = stageFromShopifyFulfillment(f);
    if (!derived) continue;
    for (const fli of (f.line_items || [])) {
      const vendor = liVendor[fli.id];
      if (!vendor) continue;
      result[vendor] = higherStage(result[vendor], derived);
    }
  }
  return result;
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


// ── Product-level flat/margin commission calculator ───────────────────────
// rule: { mode, flat_amount, flat_gst_inclusive, vendor_cost, margin_pct, margin_gst_inclusive }
// sellingPrice: the Shopify line item price (per unit)
// qty: quantity
// Returns same shape as calcCommission: { base, commission, gst, invoice, net, type }
function calcProductCommission(rule, sellingPrice, qty) {
  const price = parseFloat(sellingPrice) * (qty || 1);
  let commission = 0, gst = 0;

  if (rule.mode === 'flat' || rule.mode === 'mixed') {
    const flatTotal = (rule.flat_amount || 0) * (qty || 1);
    if (rule.flat_gst_inclusive) {
      // GST extracted from flat amount (flat includes GST)
      gst        += parseFloat((flatTotal * 18 / 118).toFixed(2));
      commission += parseFloat((flatTotal * 100 / 118).toFixed(2));
    } else {
      // GST added on top of flat amount
      commission += flatTotal;
      gst        += parseFloat((flatTotal * GST_RATE).toFixed(2));
    }
  }

  if (rule.mode === 'margin' || rule.mode === 'mixed') {
    const base = (rule.vendor_cost || 0) * (qty || 1);
    const pct  = (rule.margin_pct || 0) / 100;
    const commOnBase = parseFloat((base * pct).toFixed(2));
    if (rule.margin_gst_inclusive) {
      gst        += parseFloat((commOnBase * 18 / 118).toFixed(2));
      commission += parseFloat((commOnBase * 100 / 118).toFixed(2));
    } else {
      commission += commOnBase;
      gst        += parseFloat((commOnBase * GST_RATE).toFixed(2));
    }
  }

  commission = parseFloat(commission.toFixed(2));
  gst        = parseFloat(gst.toFixed(2));
  const invoice  = parseFloat((commission + gst).toFixed(2));
  // Vendor's effective base: for margin mode use vendor_cost, otherwise selling price
  const base = rule.mode === 'margin'
    ? (rule.vendor_cost || 0) * (qty || 1)
    : rule.mode === 'mixed'
    ? (rule.vendor_cost || 0) * (qty || 1) // margin base for mixed
    : price;
  const net = parseFloat((invoice).toFixed(2)); // COD: vendor owes invoice to CrosCrow
  return { base, commission, gst, invoice, net, type: 'receivable', isProductRule: true };
}

// Look up a product commission rule by product_id, then SKU, for a given vendor
async function findProductRule(vendor_name, product_id, sku) {
  const col = mdb.collection('product_commission_rules');
  if (product_id) {
    const r = await col.findOne({ vendor_name, product_id: String(product_id) }, { projection: { _id: 0 } });
    if (r) return r;
  }
  if (sku) {
    const r = await col.findOne({ vendor_name, sku }, { projection: { _id: 0 } });
    if (r) return r;
  }
  return null;
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
    const prev = await mdb.collection('order_meta').findOne({ shopify_id: sid }, { projection: { stage: 1, super_hold: 1 } });
    const isSuperHold = !!prev?.super_hold;

    // If order is super-held, block tag mapping from overriding with pipeline stages
    // Super hold can only be released by admin manually (POST /admin/orders/:id/super-hold)
    if (isSuperHold && !['hold','rto','cancelled'].includes(winner.stage)) {
      console.log(`🔒 Super Hold active on ${sid} — tag mapping to '${winner.stage}' blocked`);
      return;
    }

    // If winner tag has super_hold_power, set super_hold flag + stage=hold
    const isSuperHoldTag = !!winner.super_hold_power;
    const newStage = isSuperHoldTag ? 'hold' : winner.stage;
    const metaUpdate = { stage: newStage, updated_at: now };
    if (isSuperHoldTag) metaUpdate.super_hold = true;

    await OM.upsert(sid, metaUpdate);
    if (!prev || prev.stage !== newStage) {
      fireStageEmails(sid, newStage).catch(()=>{});
      // Sync stage into order_vendor_stage so vendor panel always matches admin view.
      // hold/rto/cancelled force-update all vendors unconditionally.
      // Pipeline stages (confirmed/partial) respect ADVANCED guard — don't pull back dispatched vendors.
      const ADVANCED = ['ready','pickup','transit','delivered'];
      const isOverride = ['hold','rto','cancelled'].includes(newStage);
      if (['confirmed','partial','hold','rto','cancelled'].includes(newStage)) {
        try {
          const od = await shopifyREST(`/orders/${sid}.json?fields=id,line_items`);
          const vendors = [...new Set((od?.order?.line_items || []).map(li => li.vendor).filter(Boolean))];
          const nowMs = Date.now();
          for (const vendor of vendors) {
            const existing = await mdb.collection('order_vendor_stage').findOne({ shopify_id: sid, vendor_name: vendor }, { projection: { stage: 1, stage_started_at: 1, _id: 0 } });
            if (!isOverride && existing && ADVANCED.includes(existing.stage)) continue;
            await OVS.upsert(sid, vendor, { stage: newStage, updated_at: now, stage_started_at: existing?.stage_started_at || nowMs, warning_sent: 0, penalty_triggered: 0 });
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

        const isPrepaid = payload.financial_status === 'paid';
        const now = new Date().toISOString();
        const nowMs = Date.now();

        // Auto-confirm prepaid orders + set payment type
        if (isPrepaid) {
          await OM.upsert(sid, { stage: 'confirmed', payment_type: 'prepaid', updated_at: now });
          // Set vendor stages with penalty timer started
          const vendors_ = [...new Set((payload.line_items || []).map(li => li.vendor).filter(Boolean))];
          for (const vendor of vendors_) {
            await OVS.upsert(sid, vendor, { stage: 'confirmed', updated_at: now, stage_started_at: nowMs, warning_sent: 0, penalty_triggered: 0 });
          }
          auditLog('webhook', 'prepaid_auto_confirm', sid, { order: payload.name });
          console.log(`✅ Prepaid auto-confirmed: ${payload.name}`);
        } else {
          await OM.upsert(sid, { payment_type: 'cod', updated_at: now });
        }

        if (payload.email) {
          // Delay 3 minutes so the WhatsApp confirmation message reaches customer first
          setTimeout(async () => {
            try {
              const enriched = await enrichOrderImages(payload);
              await sendEmail({
                to: payload.email,
                subject: `Your Order ${payload.name} — Please Confirm on WhatsApp`,
                html: templateNewOrderCustomerSky({ order: enriched }),
                shopifyId: sid, trigger: 'new_order_customer',
              });
            } catch (e) { console.error('Delayed new_order_customer email error:', e.message); }
          }, 3 * 60 * 1000);
        }

        // Notify each vendor
        const vendors = [...new Set((payload.line_items || []).map(li => li.vendor).filter(Boolean))];
        const vcfgs = await VC.all();
        for (const vendorName of vendors) {
          const vc = vcfgs.find(v => v.vendor_name === vendorName);
          if (vc?.email) {
            if (isPrepaid) {
              // Prepaid: send confirmed dispatch email directly (skip heads-up)
              await sendEmail({
                to: vc.email,
                subject: `Order Confirmed: ${payload.name} — Dispatch Now`,
                html: templateOrderConfirmedVendor({ order: payload, vendorName }),
                shopifyId: sid, trigger: 'confirmed_vendor',
              });
            } else {
              // COD: send heads-up, wait for customer confirmation
              await sendEmail({
                to: vc.email,
                subject: `New Order Received: ${payload.name}`,
                html: templateNewOrderVendor({ order: payload, vendorName }),
                shopifyId: sid, trigger: 'new_order_vendor',
              });
            }
          }
        }
        console.log(`📦 orders/create processed: ${payload.name} (${isPrepaid ? 'prepaid → confirmed' : 'COD'})`);

        // Auto-sync customer to Google Contacts
        try {
          const phone = payload.shipping_address?.phone || payload.billing_address?.phone || payload.phone || "";
          const name  = payload.shipping_address
            ? `${payload.shipping_address.first_name || ""} ${payload.shipping_address.last_name || ""}`.trim()
            : (payload.customer?.first_name || "Customer");
          if (phone) await upsertGoogleContact({ name, phone, orderName: payload.name });
        } catch (gErr) {
          console.error("⚠️  Google Contacts sync failed:", gErr.message);
        }
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

          const existing = await mdb.collection('order_vendor_stage').findOne(
            { shopify_id: shopifyId, vendor_name: vendorName },
            { projection: { awb: 1, stage: 1, _id: 0 } }
          );
          // Always advance stage to at least 'ready'; keep existing AWB if already set
          const existingAWB = existing?.awb || '';
          const newStage = higherStage(existing?.stage || 'new', 'ready');
          await OVS.upsert(shopifyId, vendorName, {
            stage: newStage,
            awb: existingAWB || awb,
            courier: existingAWB ? (existing?.courier || courier) : courier,
            tracking_url: existingAWB ? (existing?.tracking_url || trackUrl) : trackUrl,
            updated_at: new Date().toISOString(),
          });
          auditLog("webhook", "fulfillment_auto_ready", shopifyId, { vendorName, awb });

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

// ── Return/Exchange Request Email Templates ──────────────────────────────

function rrItemsHtml(items) {
  const rows = (items || []).map(it => `
    <tr>
      <td style="padding:11px 14px;border-bottom:1px solid #f1f5f9;">
        <div style="font-weight:600;color:#1a2a3a;">${it.title || ''}${it.variant_title ? ` <span style="color:#6b7280;font-weight:400">(${it.variant_title})</span>` : ''}</div>
        ${it.exchange_size_label ? `<div style="font-size:12px;color:#002eff;margin-top:3px;">↔ Exchange for: <strong>${it.exchange_size_label}</strong></div>` : ''}
      </td>
      <td style="padding:11px 14px;border-bottom:1px solid #f1f5f9;text-align:center;font-weight:600;color:#374151;">${it.qty || 1}</td>
    </tr>`).join('');
  return `<table class="items-table" style="width:100%;border-collapse:collapse;margin-bottom:20px;">
    <thead><tr>
      <th style="background:#f1f5f9;color:#6b7280;font-size:11px;text-transform:uppercase;letter-spacing:1px;padding:10px 14px;text-align:left;">Item</th>
      <th style="background:#f1f5f9;color:#6b7280;font-size:11px;text-transform:uppercase;letter-spacing:1px;padding:10px 14px;text-align:center;">Qty</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function rrInfoBox(rr) {
  const typeLabel = rr.type === 'exchange' ? 'Exchange' : 'Return';
  return `<div class="info-box">
    <div class="info-row"><span class="info-label">Request ID</span><span class="info-val">${rr.request_id}</span></div>
    <div class="info-row"><span class="info-label">Order</span><span class="info-val">${rr.order_name || rr.shopify_order_id}</span></div>
    <div class="info-row"><span class="info-label">Type</span><span class="info-val">${typeLabel}</span></div>
    <div class="info-row"><span class="info-label">Customer</span><span class="info-val">${rr.customer_name || '—'}</span></div>
    ${rr.customer_phone ? `<div class="info-row"><span class="info-label">Phone</span><span class="info-val">${rr.customer_phone}</span></div>` : ''}
    <div class="info-row"><span class="info-label">Reason</span><span class="info-val">${rr.reason}</span></div>
    ${rr.vendor_name ? `<div class="info-row"><span class="info-label">Vendor</span><span class="info-val">${rr.vendor_name}</span></div>` : ''}
  </div>`;
}

function templateRRSubmittedCustomer({ req: rr }) {
  const typeLabel = rr.type === 'exchange' ? 'Exchange' : 'Return';
  const body = `
    <div class="subtitle">We've received your ${typeLabel.toLowerCase()} request and will review it shortly.</div>
    ${rrInfoBox(rr)}
    <p style="font-size:13px;color:#6b7280;margin-bottom:8px;font-weight:600;">Items in your request:</p>
    ${rrItemsHtml(rr.items)}
    <p style="font-size:13px;color:#6b7280;line-height:1.7">Our team will review your request and get back to you within 1–2 business days. You'll receive an email once a decision has been made.</p>
  `;
  return emailBase(`${typeLabel} Request Received — ${rr.request_id}`, '#002eff', body);
}

function templateRRSubmittedAdmin({ req: rr }) {
  const typeLabel = rr.type === 'exchange' ? 'Exchange' : 'Return';
  const body = `
    <div class="subtitle">A new ${typeLabel.toLowerCase()} request has been submitted and requires your review.</div>
    ${rrInfoBox(rr)}
    <p style="font-size:13px;color:#6b7280;margin-bottom:8px;font-weight:600;">Requested items:</p>
    ${rrItemsHtml(rr.items)}
    <p style="font-size:13px;color:#6b7280;line-height:1.7">Log in to the Admin Portal → Returns to approve or reject this request.</p>
  `;
  return emailBase(`New ${typeLabel} Request — ${rr.order_name}`, '#002eff', body);
}

function templateRRSubmittedVendor({ req: rr }) {
  const typeLabel = rr.type === 'exchange' ? 'Exchange' : 'Return';
  const body = `
    <div class="subtitle">A ${typeLabel.toLowerCase()} request has been submitted for one of your orders.</div>
    ${rrInfoBox(rr)}
    <p style="font-size:13px;color:#6b7280;margin-bottom:8px;font-weight:600;">Requested items:</p>
    ${rrItemsHtml(rr.items)}
    <p style="font-size:13px;color:#6b7280;line-height:1.7">The admin team is reviewing this request. You'll be notified if any action is required from you.</p>
  `;
  return emailBase(`New ${typeLabel} Request for Order ${rr.order_name}`, '#002eff', body);
}

function templateRRApprovedCustomer({ req: rr }) {
  const typeLabel = rr.type === 'exchange' ? 'Exchange' : 'Return';
  const body = `
    <div class="subtitle" style="color:#10b981;font-weight:600;">Great news — your ${typeLabel.toLowerCase()} request has been approved!</div>
    ${rrInfoBox(rr)}
    <p style="font-size:13px;color:#6b7280;margin-bottom:8px;font-weight:600;">Items:</p>
    ${rrItemsHtml(rr.items)}
    ${rr.admin_note ? `<div style="background:#f0fdf4;border:2px solid #10b981;border-radius:8px;padding:12px 18px;margin-bottom:20px;font-size:13px;color:#065f46;"><strong>Note from our team:</strong> ${rr.admin_note}</div>` : ''}
    <p style="font-size:13px;color:#6b7280;line-height:1.7">We'll arrange pickup of your item(s) and keep you updated. Please ensure the items are packed and ready.</p>
  `;
  return emailBase(`${typeLabel} Request Approved ✓`, '#10b981', body);
}

function templateRRApprovedVendor({ req: rr }) {
  const typeLabel = rr.type === 'exchange' ? 'Exchange' : 'Return';
  const body = `
    <div class="subtitle">The admin has approved this ${typeLabel.toLowerCase()} request. Please arrange pickup from the customer.</div>
    ${rrInfoBox(rr)}
    <p style="font-size:13px;color:#6b7280;margin-bottom:8px;font-weight:600;">Items to collect:</p>
    ${rrItemsHtml(rr.items)}
    ${rr.admin_note ? `<div style="background:#f0fdf4;border:2px solid #10b981;border-radius:8px;padding:12px 18px;margin-bottom:20px;font-size:13px;color:#065f46;"><strong>Admin note:</strong> ${rr.admin_note}</div>` : ''}
    <p style="font-size:13px;color:#6b7280;line-height:1.7">Please update the status in your Vendor Portal once pickup has been arranged.</p>
  `;
  return emailBase(`Action Required: Arrange ${typeLabel} Pickup — ${rr.order_name}`, '#10b981', body);
}

function templateRRApprovedAdmin({ req: rr }) {
  const typeLabel = rr.type === 'exchange' ? 'Exchange' : 'Return';
  const body = `
    <div class="subtitle">The vendor has approved this ${typeLabel.toLowerCase()} request and is arranging pickup.</div>
    ${rrInfoBox(rr)}
    <p style="font-size:13px;color:#6b7280;margin-bottom:8px;font-weight:600;">Items:</p>
    ${rrItemsHtml(rr.items)}
    ${rr.vendor_note ? `<div style="background:#f0fdf4;border:2px solid #10b981;border-radius:8px;padding:12px 18px;margin-bottom:20px;font-size:13px;color:#065f46;"><strong>Vendor note:</strong> ${rr.vendor_note}</div>` : ''}
    <p style="font-size:13px;color:#6b7280;line-height:1.7">Monitor the request in Admin Portal → Returns for further status updates.</p>
  `;
  return emailBase(`Vendor Approved ${typeLabel} — ${rr.request_id}`, '#10b981', body);
}

function templateRRRejectedCustomer({ req: rr }) {
  const typeLabel = rr.type === 'exchange' ? 'Exchange' : 'Return';
  const body = `
    <div class="subtitle">Unfortunately, your ${typeLabel.toLowerCase()} request could not be approved at this time.</div>
    ${rrInfoBox(rr)}
    ${rr.admin_note ? `<div style="background:#fef2f2;border:2px solid #dc2626;border-radius:8px;padding:12px 18px;margin-bottom:20px;font-size:13px;color:#991b1b;"><strong>Reason:</strong> ${rr.admin_note}</div>` : ''}
    <p style="font-size:13px;color:#6b7280;line-height:1.7">If you believe this is an error or have further questions, please contact our support team with your Request ID: <strong>${rr.request_id}</strong>.</p>
  `;
  return emailBase(`Update on Your ${typeLabel} Request`, '#dc2626', body);
}

function templateRRPickupCustomer({ req: rr }) {
  const typeLabel = rr.type === 'exchange' ? 'Exchange' : 'Return';
  const body = `
    <div class="subtitle">Pickup has been scheduled for your ${typeLabel.toLowerCase()} request.</div>
    ${rrInfoBox(rr)}
    <p style="font-size:13px;color:#6b7280;margin-bottom:8px;font-weight:600;">Items to be collected:</p>
    ${rrItemsHtml(rr.items)}
    ${rr.admin_note ? `<div style="background:#eef2ff;border:2px solid #6366f1;border-radius:8px;padding:12px 18px;margin-bottom:20px;font-size:13px;color:#3730a3;"><strong>Pickup details:</strong> ${rr.admin_note}</div>` : ''}
    <p style="font-size:13px;color:#6b7280;line-height:1.7">Please ensure the items are packed securely and ready for collection. You'll receive another update once your items are in transit.</p>
  `;
  return emailBase(`Pickup Scheduled — ${rr.request_id}`, '#6366f1', body);
}

function templateRRInTransitCustomer({ req: rr }) {
  const typeLabel = rr.type === 'exchange' ? 'Exchange' : 'Return';
  const body = `
    <div class="subtitle">Your ${typeLabel.toLowerCase()} items have been picked up and are on their way.</div>
    ${rrInfoBox(rr)}
    <p style="font-size:13px;color:#6b7280;margin-bottom:8px;font-weight:600;">Items in transit:</p>
    ${rrItemsHtml(rr.items)}
    ${rr.admin_note ? `<div style="background:#eef2ff;border:2px solid #6366f1;border-radius:8px;padding:12px 18px;margin-bottom:20px;font-size:13px;color:#3730a3;"><strong>Tracking info:</strong> ${rr.admin_note}</div>` : ''}
    <p style="font-size:13px;color:#6b7280;line-height:1.7">We'll notify you once your ${rr.type === 'exchange' ? 'exchange item has been delivered' : 'return has been received and processed'}.</p>
  `;
  return emailBase(`Your ${typeLabel} is In Transit — ${rr.request_id}`, '#6366f1', body);
}

function templateRRDeliveredCustomer({ req: rr }) {
  const typeLabel = rr.type === 'exchange' ? 'Exchange' : 'Return';
  const completedMsg = rr.type === 'exchange'
    ? 'Your exchange item has been delivered. We hope you love it!'
    : 'Your return has been received and processed. Refund (if applicable) will be initiated shortly.';
  const body = `
    <div class="subtitle" style="color:#10b981;font-weight:600;">${completedMsg}</div>
    ${rrInfoBox(rr)}
    ${rr.admin_note ? `<div style="background:#f0fdf4;border:2px solid #10b981;border-radius:8px;padding:12px 18px;margin-bottom:20px;font-size:13px;color:#065f46;"><strong>Note:</strong> ${rr.admin_note}</div>` : ''}
    <p style="font-size:13px;color:#6b7280;line-height:1.7">Thank you for shopping with CrosCrow. If you have any questions, please contact us with your Request ID: <strong>${rr.request_id}</strong>.</p>
  `;
  return emailBase(`${typeLabel} Request Complete ✓`, '#10b981', body);
}

function templateRRReminder24Admin({ req: rr }) {
  const typeLabel = rr.type === 'exchange' ? 'Exchange' : 'Return';
  const createdAt = rr.created_at ? new Date(rr.created_at).toLocaleString('en-IN') : '—';
  const body = `
    <div class="subtitle" style="color:#f59e0b;font-weight:600;">This ${typeLabel.toLowerCase()} request has been pending for over 24 hours and requires attention.</div>
    ${rrInfoBox(rr)}
    <div style="background:#fffbeb;border:2px solid #f59e0b;border-radius:8px;padding:12px 18px;margin-bottom:20px;font-size:13px;color:#92400e;">
      <strong>⏰ Submitted:</strong> ${createdAt}<br>
      <strong>Current Status:</strong> Pending — no action taken yet
    </div>
    <p style="font-size:13px;color:#6b7280;line-height:1.7">Please log in to the Admin Portal → Returns to review and approve or reject this request promptly.</p>
  `;
  return emailBase(`24hr Reminder: ${typeLabel} Request Still Pending`, '#f59e0b', body);
}

function templateRRReminder24Vendor({ req: rr }) {
  const typeLabel = rr.type === 'exchange' ? 'Exchange' : 'Return';
  const updatedAt = rr.updated_at ? new Date(rr.updated_at).toLocaleString('en-IN') : '—';
  const body = `
    <div class="subtitle" style="color:#f59e0b;font-weight:600;">This ${typeLabel.toLowerCase()} was approved over 24 hours ago and pickup has not yet been arranged.</div>
    ${rrInfoBox(rr)}
    <div style="background:#fffbeb;border:2px solid #f59e0b;border-radius:8px;padding:12px 18px;margin-bottom:20px;font-size:13px;color:#92400e;">
      <strong>⏰ Approved on:</strong> ${updatedAt}<br>
      <strong>Current Status:</strong> Approved — awaiting vendor action
    </div>
    <p style="font-size:13px;color:#6b7280;margin-bottom:8px;font-weight:600;">Items to collect from customer:</p>
    ${rrItemsHtml(rr.items)}
    <p style="font-size:13px;color:#6b7280;line-height:1.7">Please arrange pickup as soon as possible and update the status in your Vendor Portal.</p>
  `;
  return emailBase(`⏰ Action Needed: Approved ${typeLabel} Not Yet Fulfilled — ${rr.request_id}`, '#f59e0b', body);
}

// ── Return/Exchange Email Helper ──────────────────────────────────────────

async function sendRREmail(type, rr) {
  try {
    const cfg = await mdb.collection('email_settings').findOne({}) || {};
    const from = `"${cfg.fromName || 'CrosCrow'}" <${cfg.fromEmail || cfg.user}>`;
    const adminEmail = 'harshitvj24@gmail.com';

    const vendorCfg = await mdb.collection('vendor_config').findOne({ vendor_name: rr.vendor_name }) || {};
    const vendorEmail = vendorCfg.email || null;

    const send = async (to, subject, html) => {
      if (!to) return;
      await transporter.sendMail({ from, to, subject, html });
    };

    switch (type) {
      case 'submitted':
        await send(rr.customer_email, `Your ${rr.type} request ${rr.request_id} received`, templateRRSubmittedCustomer({ req: rr }));
        await send(adminEmail, `New ${rr.type} request ${rr.request_id} — ${rr.order_name}`, templateRRSubmittedAdmin({ req: rr }));
        if (vendorEmail) await send(vendorEmail, `New ${rr.type} request for order ${rr.order_name}`, templateRRSubmittedVendor({ req: rr }));
        break;
      case 'approved':
        await send(rr.customer_email, `Your ${rr.type} request ${rr.request_id} is approved ✓`, templateRRApprovedCustomer({ req: rr }));
        if (rr._approvedBy === 'admin' && vendorEmail) await send(vendorEmail, `Action needed: ${rr.type} approved for ${rr.order_name}`, templateRRApprovedVendor({ req: rr }));
        if (rr._approvedBy === 'vendor') await send(adminEmail, `Vendor approved ${rr.type} request ${rr.request_id}`, templateRRApprovedAdmin({ req: rr }));
        break;
      case 'rejected':
        await send(rr.customer_email, `Update on your ${rr.type} request ${rr.request_id}`, templateRRRejectedCustomer({ req: rr }));
        break;
      case 'pickup':
        await send(rr.customer_email, `Pickup scheduled for your ${rr.type} request ${rr.request_id}`, templateRRPickupCustomer({ req: rr }));
        break;
      case 'in_transit':
        await send(rr.customer_email, `Your ${rr.type} is on its way — ${rr.request_id}`, templateRRInTransitCustomer({ req: rr }));
        break;
      case 'completed':
        await send(rr.customer_email, `Your ${rr.type} request ${rr.request_id} is complete ✓`, templateRRDeliveredCustomer({ req: rr }));
        break;
      case 'reminder_admin':
        await send(adminEmail, `⏰ 24hr reminder: ${rr.type} request ${rr.request_id} still pending`, templateRRReminder24Admin({ req: rr }));
        break;
      case 'reminder_vendor':
        if (vendorEmail) await send(vendorEmail, `⏰ Action needed: approved ${rr.type} not yet arranged — ${rr.request_id}`, templateRRReminder24Vendor({ req: rr }));
        break;
    }
  } catch (e) { console.error('RR email error:', e.message); }
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
      const img = li.image_url || li.image?.src || (li.properties?.find(p => p.name === '_image')?.value) || '';
      return `
    <table width="100%" cellpadding="0" cellspacing="0" style="border-bottom:1px solid #1e1e1e;margin-bottom:0;">
      <tr>
        ${img ? `<td style="padding:14px 14px 14px 0;width:64px;vertical-align:top;">
          <img src="${img}" width="60" height="60" alt="" style="border-radius:6px;object-fit:cover;display:block;background:#222;">
        </td>` : `<td style="padding:14px 14px 14px 0;width:64px;vertical-align:top;">
          <div style="width:60px;height:60px;background:#1e1e1e;border-radius:6px;"></div>
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

function templateVendorWelcome({ vendorName, username, password }) {
  const loginUrl = 'https://autoaijarvis1.onrender.com/vendor.html';
  return emailBase(`Welcome to the All-New CrosCrow Vendor Panel 🚀`, '#6366f1', `
    <!-- Hero greeting -->
    <div style="text-align:center;padding:8px 0 28px">
      <div style="display:inline-block;background:linear-gradient(135deg,#4338ca,#7c3aed);border-radius:12px;padding:14px 28px;margin-bottom:16px">
        <div style="font-size:11px;letter-spacing:4px;text-transform:uppercase;color:#c4b5fd;margin-bottom:4px">CrosCrow Vendor Portal</div>
        <div style="font-size:22px;font-weight:900;color:#ffffff;letter-spacing:-0.5px">Welcome aboard, ${vendorName}!</div>
      </div>
      <div style="font-size:14px;color:#94a3b8;max-width:440px;margin:0 auto;line-height:1.7">
        We heard your requests and delivered. The all-new vendor panel is live and built around <strong style="color:#a5b4fc">your daily workflow.</strong>
      </div>
    </div>

    <!-- Credentials box -->
    <div style="background:#0d1520;border:2px solid #3730a3;border-radius:10px;padding:20px 24px;margin-bottom:24px">
      <div style="font-size:10px;letter-spacing:3px;text-transform:uppercase;color:#6366f1;font-weight:700;margin-bottom:14px">Your Login Credentials</div>
      <div style="display:flex;gap:32px;flex-wrap:wrap">
        <div>
          <div style="font-size:9px;color:#64748b;letter-spacing:1px;text-transform:uppercase;margin-bottom:4px">Username</div>
          <div style="font-size:18px;font-weight:800;color:#a5b4fc;font-family:monospace;letter-spacing:1px">${username}</div>
        </div>
        <div>
          <div style="font-size:9px;color:#64748b;letter-spacing:1px;text-transform:uppercase;margin-bottom:4px">Password</div>
          <div style="font-size:18px;font-weight:800;color:#fbbf24;font-family:monospace;letter-spacing:1px">${password}</div>
        </div>
      </div>
      <div style="font-size:10px;color:#475569;margin-top:10px">Change your password from <strong>My Profile → Change Password</strong> after first login.</div>
    </div>

    <!-- Login button -->
    <div style="text-align:center;margin-bottom:28px">
      <a href="${loginUrl}" style="display:inline-block;background:linear-gradient(135deg,#4338ca,#7c3aed);color:#fff;text-decoration:none;font-weight:800;font-size:14px;letter-spacing:1px;padding:14px 40px;border-radius:10px;">
        Login to Vendor Panel →
      </a>
    </div>

    <!-- Features grid -->
    <div style="font-size:10px;font-weight:700;letter-spacing:3px;text-transform:uppercase;color:#475569;margin-bottom:14px;text-align:center">What's New For You</div>
    <div style="display:grid;gap:10px;margin-bottom:24px">
      <div style="background:#0a1520;border:1px solid #1e3a5f;border-radius:8px;padding:14px 16px;display:flex;gap:14px;align-items:flex-start">
        <div style="font-size:22px;flex-shrink:0">🚚</div>
        <div>
          <div style="font-size:13px;font-weight:700;color:#7eb8f7;margin-bottom:3px">Direct Shipping Integration</div>
          <div style="font-size:12px;color:#64748b;line-height:1.7">Connect your <strong style="color:#94a3b8">Delhivery</strong> or <strong style="color:#94a3b8">Shiprocket</strong> account directly inside the panel. Ship in one click — no more manual waybill generation, no more copy-pasting order details.</div>
        </div>
      </div>
      <div style="background:#0a1520;border:1px solid #1e3a5f;border-radius:8px;padding:14px 16px;display:flex;gap:14px;align-items:flex-start">
        <div style="font-size:22px;flex-shrink:0">📦</div>
        <div>
          <div style="font-size:13px;font-weight:700;color:#7eb8f7;margin-bottom:3px">Live Order Tracking</div>
          <div style="font-size:12px;color:#64748b;line-height:1.7">See all your orders, their current stage, COD amounts, advance collected and tracking — all in one place, updated in real time.</div>
        </div>
      </div>
      <div style="background:#0a1520;border:1px solid #1e3a5f;border-radius:8px;padding:14px 16px;display:flex;gap:14px;align-items:flex-start">
        <div style="font-size:22px;flex-shrink:0">💰</div>
        <div>
          <div style="font-size:13px;font-weight:700;color:#7eb8f7;margin-bottom:3px">Settlement & Wallet</div>
          <div style="font-size:12px;color:#64748b;line-height:1.7">View your settlements, commission breakdown, invoices and wallet balance — full financial transparency at your fingertips.</div>
        </div>
      </div>
    </div>

    <!-- Penalty warning -->
    <div style="background:#1c0a0a;border:2px solid #dc2626;border-radius:8px;padding:16px 18px;margin-bottom:20px">
      <div style="font-size:12px;font-weight:800;color:#ef4444;margin-bottom:8px;letter-spacing:0.5px">⚠ 48-Hour Fulfillment Policy</div>
      <div style="font-size:12px;color:#fca5a5;line-height:1.8">
        All orders in <strong>Confirmed</strong> or <strong>Partial</strong> stage must be dispatched within <strong>48 hours</strong> to avoid a penalty.<br><br>
        The <strong>circle indicator</strong> on each order shows the time remaining before penalty kicks in. <span style="color:#fbbf24">Green → Yellow → Red.</span><br><br>
        <strong>Unable to fulfil in time?</strong> Open the order and press <strong>"Report Delay"</strong> — submit your reason and expected dispatch date. This notifies the customer and may help reduce the penalty. If no delay is reported and 48hrs pass, <strong>penalty will be unavoidable.</strong>
      </div>
    </div>

    <!-- Closing tagline -->
    <div style="text-align:center;margin:28px 0 8px;padding:24px;background:linear-gradient(135deg,#0d1520,#1a1a3a);border-radius:12px;border:1px solid #2d2d5e">
      <div style="font-size:20px;font-weight:900;color:#ffffff;line-height:1.5;letter-spacing:-0.3px">
        "If You help us grow,<br>we'll help your brand steal the show."
      </div>
      <div style="font-size:11px;color:#64748b;margin-top:10px;letter-spacing:2px;text-transform:uppercase">— CrosCrow Team</div>
    </div>

    <div style="text-align:center;margin-top:20px">
      <a href="${loginUrl}" style="display:inline-block;background:#6366f1;color:#fff;text-decoration:none;font-weight:700;font-size:13px;padding:11px 32px;border-radius:8px;">Login to Vendor Panel →</a>
    </div>
  `);
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
          limit: { type: "string", description: "Max results to return as a number string e.g. '20'" },
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
          limit: { type: "string", description: "Max results as a number string e.g. '10'" },
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
          limit:    { type: "string", description: "Max orders to return as a number string e.g. '15'" },
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
          limit:  { type: "string", description: "Top N cities as a number string e.g. '10'" },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_dispatch_rate",
      description: "Get dispatch rate — how many confirmed/above orders have been dispatched (have AWB or stage ready/pickup/transit/delivered). Use for: dispatch rate overall, per vendor dispatch rate, fulfillment efficiency.",
      parameters: {
        type: "object",
        properties: {
          period: { type: "string", enum: ["today","week","month","all"], description: "Time period (default all)" },
          vendor: { type: "string", description: "Filter by specific vendor name, or omit for all" },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_stuck_orders",
      description: "Find orders stuck in a stage for too long. Use for: orders confirmed 48hr+ with no AWB, orders in transit 7+ days, orders on hold, vendors not fulfilling.",
      parameters: {
        type: "object",
        properties: {
          stage:    { type: "string", enum: ["confirmed","partial","hold","transit","ready","all"], description: "Which stage to check for stuck orders" },
          min_hours: { type: "string", description: "Minimum hours in stage to be considered stuck e.g. '48'" },
          vendor:   { type: "string", description: "Filter by specific vendor" },
        },
        required: ["stage"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_multi_vendor_stuck",
      description: "Find multi-vendor orders where some vendors have dispatched but at least one vendor hasn't — causing the order to appear incomplete. Shows which vendor is holding up the order.",
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
      name: "get_vendor_fulfillment",
      description: "Get detailed fulfillment performance per vendor: confirmed/dispatched/delivered/rto counts, dispatch rate, avg dispatch time, pending penalties. Best for vendor comparison and accountability.",
      parameters: {
        type: "object",
        properties: {
          period: { type: "string", enum: ["today","week","month","all"], description: "Time period (default all)" },
          vendor: { type: "string", description: "Specific vendor or omit for all vendors" },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_cod_outstanding",
      description: "Get outstanding COD amount — orders dispatched/in-transit/delivered but cash not yet settled. Also shows advance collected but unshipped orders.",
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
      name: "get_rto_analysis",
      description: "Get RTO (Return to Origin) analysis: RTO rate overall and per vendor, which cities have highest RTO, RTO trend.",
      parameters: {
        type: "object",
        properties: {
          period: { type: "string", enum: ["today","week","month","all"], description: "Time period (default all)" },
        },
        required: [],
      },
    },
  },
];

// ── JARVIS tool executor — runs whichever tool the AI asked for ───────────────
// Per-request cache so parallel tool calls don't each fetch all orders
let _jarvisOrdersCache = null;
let _jarvisMetasCache  = null;

async function runJarvisTool(name, args, reqCache) {
  // Coerce numeric args that Groq sometimes returns as strings
  if (args.limit   !== undefined) args.limit   = parseInt(args.limit)   || 15;
  if (args.top     !== undefined) args.top      = parseInt(args.top)     || 10;
  if (args.days    !== undefined) args.days     = parseInt(args.days)    || 30;

  // Use per-request cache to avoid hitting Shopify rate limits on parallel tool calls
  if (!reqCache.orders) reqCache.orders = await fetchAllOrders("any", "2020-01-01T00:00:00Z");
  if (!reqCache.metas)  reqCache.metas  = Object.fromEntries((await mdb.collection('order_meta').find({}, { projection: { _id: 0 } }).toArray()).map(m=>[m.shopify_id,m]));

  const allOrders = reqCache.orders;
  const metas     = reqCache.metas;

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
    const vendorStages = await mdb.collection('order_vendor_stage').find({shopify_id:{$in:os.map(o=>String(o.id))}},{projection:{shopify_id:1,vendor_name:1,stage:1,awb:1,courier:1,_id:0}}).toArray();
    const vsMap = {};
    vendorStages.forEach(r=>{ if(!vsMap[r.shopify_id])vsMap[r.shopify_id]={}; vsMap[r.shopify_id][r.vendor_name]={stage:r.stage,awb:r.awb,courier:r.courier}; });
    return os.slice(0,parseInt(args.limit)||15).map(o=>({
      id: o.id,
      name: o.name,
      customer: o.billing_address?.name || o.email,
      city: o.shipping_address?.city,
      total: parseFloat(o.total_price||0),
      payment: isCOD(o)?"COD":"Prepaid",
      status: o.fulfillment_status||"unfulfilled",
      stage: metas[String(o.id)]?.stage||null,
      advance_paid: metas[String(o.id)]?.advance_paid||0,
      awb: metas[String(o.id)]?.awb||null,
      date: o.created_at?.slice(0,10),
      vendors: [...new Set((o.line_items||[]).map(li=>li.vendor).filter(Boolean))],
      vendor_stages: vsMap[String(o.id)]||{},
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

  // ── get_dispatch_rate ─────────────────────────────────────────────────────
  if (name === "get_dispatch_rate") {
    const DISPATCHED_STAGES = ['ready','pickup','transit','ofd','delivered','rto','cancelled'];
    const os = filterByPeriod(allOrders, args.period||"all");
    const allVS = await mdb.collection('order_vendor_stage').find({},{projection:{shopify_id:1,vendor_name:1,stage:1,awb:1,_id:0}}).toArray();
    const vsMap = {};
    allVS.forEach(r=>{ if(!vsMap[r.shopify_id])vsMap[r.shopify_id]={}; vsMap[r.shopify_id][r.vendor_name]={stage:r.stage,awb:r.awb}; });

    const vendorMap = {};
    os.forEach(o=>{
      const sid=String(o.id);
      const vendors=[...new Set((o.line_items||[]).map(li=>li.vendor).filter(Boolean))];
      vendors.forEach(v=>{
        if(args.vendor && v.toLowerCase()!==args.vendor.toLowerCase()) return;
        const vs=vsMap[sid]?.[v];
        const stage=vs?.stage||metas[sid]?.stage||'new';
        const hasAWB=!!(vs?.awb||metas[sid]?.awb);
        const isDispatched=DISPATCHED_STAGES.includes(stage)||hasAWB;
        const isActive=['confirmed','partial','hold','ready','pickup','transit','delivered'].includes(stage);
        if(!isActive) return;
        if(!vendorMap[v]) vendorMap[v]={total:0,dispatched:0,pending:0};
        vendorMap[v].total++;
        if(isDispatched) vendorMap[v].dispatched++;
        else vendorMap[v].pending++;
      });
    });

    const vendors=Object.entries(vendorMap).map(([v,d])=>({
      vendor:v, total:d.total, dispatched:d.dispatched, pending:d.pending,
      dispatchRate:`${d.total>0?Math.round(d.dispatched/d.total*100):0}%`
    })).sort((a,b)=>b.total-a.total);

    const totals=vendors.reduce((a,v)=>({total:a.total+v.total,dispatched:a.dispatched+v.dispatched,pending:a.pending+v.pending}),{total:0,dispatched:0,pending:0});
    return { period:args.period||"all", overall_dispatch_rate:`${totals.total>0?Math.round(totals.dispatched/totals.total*100):0}%`, ...totals, by_vendor:vendors };
  }

  // ── get_stuck_orders ──────────────────────────────────────────────────────
  if (name === "get_stuck_orders") {
    const minHours = parseInt(args.min_hours)||48;
    const minMs = minHours * 60 * 60 * 1000;
    const now = Date.now();
    const allVS = await mdb.collection('order_vendor_stage').find({},{projection:{shopify_id:1,vendor_name:1,stage:1,awb:1,stage_started_at:1,_id:0}}).toArray();
    const vsMap = {};
    allVS.forEach(r=>{ if(!vsMap[r.shopify_id])vsMap[r.shopify_id]={}; vsMap[r.shopify_id][r.vendor_name]=r; });

    const stuck = [];
    allOrders.forEach(o=>{
      const sid=String(o.id);
      const vendors=[...new Set((o.line_items||[]).map(li=>li.vendor).filter(Boolean))];
      vendors.forEach(v=>{
        if(args.vendor && v.toLowerCase()!==args.vendor.toLowerCase()) return;
        const vs=vsMap[sid]?.[v];
        const stage=vs?.stage||metas[sid]?.stage||'new';
        const targetStages = args.stage==='all'?['confirmed','partial','hold','transit','ready']:
          args.stage==='transit'?['transit']:args.stage==='hold'?['hold']:
          args.stage==='ready'?['ready']:[args.stage];
        if(!targetStages.includes(stage)) return;
        const startedAt = vs?.stage_started_at||0;
        const hoursStuck = startedAt>0?Math.round((now-startedAt)/1000/3600):null;
        if(startedAt>0 && (now-startedAt)<minMs) return;
        stuck.push({ order:o.name, shopify_id:sid, vendor:v, stage, hours_in_stage:hoursStuck, awb:vs?.awb||null, customer:o.billing_address?.name, total:parseFloat(o.total_price||0) });
      });
    });
    stuck.sort((a,b)=>(b.hours_in_stage||0)-(a.hours_in_stage||0));
    return { stuck_count:stuck.length, min_hours:minHours, stage:args.stage, orders:stuck.slice(0,30) };
  }

  // ── get_multi_vendor_stuck ────────────────────────────────────────────────
  if (name === "get_multi_vendor_stuck") {
    const DISPATCHED=['ready','pickup','transit','delivered'];
    const os = filterByPeriod(allOrders, args.period||"all");
    const allVS = await mdb.collection('order_vendor_stage').find({},{projection:{shopify_id:1,vendor_name:1,stage:1,awb:1,_id:0}}).toArray();
    const vsMap = {};
    allVS.forEach(r=>{ if(!vsMap[r.shopify_id])vsMap[r.shopify_id]={}; vsMap[r.shopify_id][r.vendor_name]={stage:r.stage,awb:r.awb}; });

    const stuck = [];
    os.forEach(o=>{
      const sid=String(o.id);
      const vendors=[...new Set((o.line_items||[]).map(li=>li.vendor).filter(Boolean))];
      if(vendors.length<2) return;
      const vendorStatuses=vendors.map(v=>({ vendor:v, stage:vsMap[sid]?.[v]?.stage||metas[sid]?.stage||'new', awb:vsMap[sid]?.[v]?.awb||null }));
      const dispatched=vendorStatuses.filter(v=>DISPATCHED.includes(v.stage)||v.awb);
      const pending=vendorStatuses.filter(v=>!DISPATCHED.includes(v.stage)&&!v.awb&&['confirmed','partial','new'].includes(v.stage));
      if(dispatched.length>0 && pending.length>0) {
        stuck.push({ order:o.name, shopify_id:sid, customer:o.billing_address?.name, total:parseFloat(o.total_price||0), date:o.created_at?.slice(0,10), dispatched_vendors:dispatched.map(v=>v.vendor), holding_vendors:pending.map(v=>v.vendor) });
      }
    });
    return { count:stuck.length, orders:stuck.slice(0,25) };
  }

  // ── get_vendor_fulfillment ────────────────────────────────────────────────
  if (name === "get_vendor_fulfillment") {
    const DISPATCHED=['ready','pickup','transit','delivered'];
    const os = filterByPeriod(allOrders, args.period||"all");
    const allVS = await mdb.collection('order_vendor_stage').find({},{projection:{shopify_id:1,vendor_name:1,stage:1,awb:1,stage_started_at:1,_id:0}}).toArray();
    const vsMap = {};
    allVS.forEach(r=>{ if(!vsMap[r.shopify_id])vsMap[r.shopify_id]={}; vsMap[r.shopify_id][r.vendor_name]={stage:r.stage,awb:r.awb,stage_started_at:r.stage_started_at}; });
    const penalties = await mdb.collection('order_penalties').find({status:'pending'},{projection:{vendor_name:1,_id:0}}).toArray();
    const penaltyCount = {};
    penalties.forEach(p=>{ penaltyCount[p.vendor_name]=(penaltyCount[p.vendor_name]||0)+1; });

    const vMap = {};
    os.forEach(o=>{
      const sid=String(o.id);
      const vendors=[...new Set((o.line_items||[]).map(li=>li.vendor).filter(Boolean))];
      vendors.forEach(v=>{
        if(args.vendor && v.toLowerCase()!==args.vendor.toLowerCase()) return;
        const vs=vsMap[sid]?.[v];
        const stage=vs?.stage||metas[sid]?.stage||'new';
        if(!vMap[v]) vMap[v]={confirmed:0,dispatched:0,delivered:0,rto:0,hold:0,total:0,dispatchTimes:[]};
        vMap[v].total++;
        if(['confirmed','partial'].includes(stage)) vMap[v].confirmed++;
        if(DISPATCHED.includes(stage)||vs?.awb) vMap[v].dispatched++;
        if(stage==='delivered') vMap[v].delivered++;
        if(stage==='rto') vMap[v].rto++;
        if(stage==='hold') vMap[v].hold++;
        if(vs?.stage_started_at && ['confirmed','partial'].includes(stage)) {
          const hrs=Math.round((Date.now()-vs.stage_started_at)/3600000);
          vMap[v].dispatchTimes.push(hrs);
        }
      });
    });

    return Object.entries(vMap).map(([v,d])=>({
      vendor:v, total_orders:d.total, confirmed_pending:d.confirmed, dispatched:d.dispatched,
      delivered:d.delivered, rto:d.rto, on_hold:d.hold,
      dispatch_rate:`${d.total>0?Math.round(d.dispatched/d.total*100):0}%`,
      rto_rate:`${d.dispatched>0?Math.round(d.rto/d.dispatched*100):0}%`,
      avg_hours_in_confirmed: d.dispatchTimes.length>0?Math.round(d.dispatchTimes.reduce((a,b)=>a+b,0)/d.dispatchTimes.length):null,
      pending_penalties: penaltyCount[v]||0,
    })).sort((a,b)=>b.total_orders-a.total_orders);
  }

  // ── get_cod_outstanding ───────────────────────────────────────────────────
  if (name === "get_cod_outstanding") {
    const os = filterByPeriod(allOrders, isCOD).filter(isCOD);
    const allVS = await mdb.collection('order_vendor_stage').find({},{projection:{shopify_id:1,stage:1,awb:1,_id:0}}).toArray();
    const vsMap = Object.fromEntries(allVS.map(r=>[r.shopify_id,r]));
    let inTransit=0,inTransitAmt=0,delivered=0,deliveredAmt=0,advanceUnshipped=0,advanceUnshippedAmt=0;
    filterByPeriod(allOrders,args.period||"all").filter(isCOD).forEach(o=>{
      const sid=String(o.id);
      const stage=metas[sid]?.stage||vsMap[sid]?.stage||'new';
      const amt=parseFloat(o.total_price||0);
      const adv=metas[sid]?.advance_paid||0;
      if(['transit','pickup','ready'].includes(stage)){inTransit++;inTransitAmt+=amt;}
      if(stage==='delivered'){delivered++;deliveredAmt+=amt;}
      if(adv>0&&!['ready','pickup','transit','delivered','rto','cancelled'].includes(stage)){advanceUnshipped++;advanceUnshippedAmt+=adv;}
    });
    return { period:args.period||"all", in_transit:{orders:inTransit,amount:Math.round(inTransitAmt)}, delivered_not_settled:{orders:delivered,amount:Math.round(deliveredAmt)}, advance_collected_unshipped:{orders:advanceUnshipped,amount:Math.round(advanceUnshippedAmt)} };
  }

  // ── get_rto_analysis ──────────────────────────────────────────────────────
  if (name === "get_rto_analysis") {
    const os = filterByPeriod(allOrders, args.period||"all");
    const allVS = await mdb.collection('order_vendor_stage').find({stage:'rto'},{projection:{shopify_id:1,vendor_name:1,_id:0}}).toArray();
    const rtoOrderIds = new Set(allVS.map(r=>r.shopify_id));
    const rtoByVendor = {};
    allVS.forEach(r=>{ rtoByVendor[r.vendor_name]=(rtoByVendor[r.vendor_name]||0)+1; });

    const rtoOrders=os.filter(o=>metas[String(o.id)]?.stage==='rto'||rtoOrderIds.has(String(o.id)));
    const cityRTO={};
    rtoOrders.forEach(o=>{ const city=o.shipping_address?.city||'Unknown'; cityRTO[city]=(cityRTO[city]||0)+1; });

    const dispatched=os.filter(o=>{ const s=metas[String(o.id)]?.stage; return ['ready','pickup','transit','delivered','rto'].includes(s); });
    return {
      period:args.period||"all",
      total_rto:rtoOrders.length,
      total_dispatched:dispatched.length,
      rto_rate:`${dispatched.length>0?Math.round(rtoOrders.length/dispatched.length*100):0}%`,
      by_vendor:Object.entries(rtoByVendor).map(([v,c])=>({vendor:v,rto_orders:c})).sort((a,b)=>b.rto_orders-a.rto_orders),
      top_rto_cities:Object.entries(cityRTO).sort((a,b)=>b[1]-a[1]).slice(0,10).map(([city,count])=>({city,rto_orders:count})),
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

  const systemPrompt = `You are JARVIS, a razor-sharp e-commerce operations assistant for CrosCrow — a multi-vendor Shopify marketplace.
You have tools to fetch any live store data. Always call the right tool(s) to get real data before answering.

Key concepts:
- Stage = internal fulfillment stage tracked in our DB: new → confirmed → partial → ready → pickup → transit → delivered / rto / cancelled / hold
- Dispatched = orders with AWB saved OR stage is ready/pickup/transit/delivered
- Dispatch rate = dispatched orders / total active (confirmed+above) orders
- Multi-vendor orders = single customer order with products from multiple vendors — each vendor fulfills independently
- COD = cash on delivery, Prepaid = online payment
- Advance/Partial = customer paid partial amount upfront, rest COD

Tools available:
- get_dispatch_rate: overall and per-vendor dispatch rates
- get_stuck_orders: orders stuck in a stage too long (confirmed 48hr+, transit 7d+, etc.)
- get_multi_vendor_stuck: multi-vendor orders where one vendor hasn't shipped while others have
- get_vendor_fulfillment: full vendor performance — confirmed pending, dispatched, delivered, RTO, penalties
- get_cod_outstanding: COD money in transit, advance collected but unshipped
- get_rto_analysis: RTO rates overall, per vendor, per city
- get_orders_list: actual order list with stage, AWB, vendor stages
- get_order_stats, get_vendor_stats, get_delivery_stats, get_products, get_customers, get_city_stats, get_settlements

Rules:
- ALWAYS use tools. Never guess or make up numbers.
- Be concise — bullet points preferred. Flag risks and anomalies proactively.
- Currency is INR (₹). Format large numbers with commas.
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
      const reqCache = {}; // shared cache for this request — fetches orders once, reuses across parallel tools
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
          // Pre-fetch orders once before parallel tool calls to avoid 429
          if (!reqCache.orders) reqCache.orders = await fetchAllOrders("any", "2020-01-01T00:00:00Z");
          if (!reqCache.metas)  reqCache.metas  = Object.fromEntries((await mdb.collection('order_meta').find({}, { projection: { _id: 0 } }).toArray()).map(m=>[m.shopify_id,m]));
          messages.push(msg);
          const toolResults = await Promise.all(msg.tool_calls.map(async tc => {
            let args = {};
            try { args = JSON.parse(tc.function.arguments || "{}"); } catch(_){}
            console.log(`🔧 JARVIS tool: ${tc.function.name}`, args);
            const result = await runJarvisTool(tc.function.name, args, reqCache);
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

const VENDOR_PASSWORD      = process.env.VENDOR_PASSWORD || "Croscrow@00";
const DEFAULT_VENDOR_PASS  = "Croscrow@00";
const vendorSessions       = new Map(); // token → { vendorName, expiresAt }

function hashPassword(plain) {
  return crypto.createHash('sha256').update(plain + 'jarvis-vendor-salt-2024').digest('hex');
}

function generateUsername(vendorName) {
  const base = vendorName.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 14);
  const num  = String(Math.floor(Math.random() * 90) + 10); // 10–99
  return base + num;
}

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
  try {
    // Check username-based credentials in vendor_profiles
    const credDoc = await mdb.collection('vendor_profiles').findOne(
      { username: { $regex: new RegExp(`^${username.trim()}$`, 'i') } },
      { projection: { vendor_name: 1, password_hash: 1, must_change_password: 1, _id: 0 } }
    );
    if (credDoc) {
      if (credDoc.password_hash !== hashPassword(password))
        return res.status(401).json({ error: "Invalid password." });
      const token = crypto.randomBytes(32).toString("hex");
      vendorSessions.set(token, { vendorName: credDoc.vendor_name, expiresAt: Date.now() + 24 * 60 * 60 * 1000 });
      console.log(`🔓  Vendor login (creds): ${credDoc.vendor_name}`);
      return res.json({ token, vendorName: credDoc.vendor_name, mustChangePassword: !!credDoc.must_change_password });
    }

    // Legacy fallback: brand name login with global password
    if (password !== VENDOR_PASSWORD) return res.status(401).json({ error: "Invalid username or password." });
    const vendors = await getVendorList();
    const matched = vendors.find(v => v.toLowerCase() === username.toLowerCase().trim());
    if (!matched) return res.status(401).json({ error: "Invalid username or password." });
    const token = crypto.randomBytes(32).toString("hex");
    vendorSessions.set(token, { vendorName: matched, expiresAt: Date.now() + 24 * 60 * 60 * 1000 });
    console.log(`🔓  Vendor login (legacy): ${matched}`);
    res.json({ token, vendorName: matched, mustChangePassword: false });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── POST /vendor/change-password ─────────────────────────────────────────
app.post("/vendor/change-password", vendorAuth, async (req, res) => {
  const { current_password, new_password } = req.body || {};
  if (!current_password || !new_password) return res.status(400).json({ error: "current_password and new_password required." });
  if (new_password.length < 6) return res.status(400).json({ error: "New password must be at least 6 characters." });
  try {
    const doc = await mdb.collection('vendor_profiles').findOne({ vendor_name: req.vendor }, { projection: { password_hash: 1, _id: 0 } });
    const expectedHash = doc?.password_hash || hashPassword(DEFAULT_VENDOR_PASS);
    if (hashPassword(current_password) !== expectedHash)
      return res.status(401).json({ error: "Current password is incorrect." });
    await mdb.collection('vendor_profiles').updateOne(
      { vendor_name: req.vendor },
      { $set: { password_hash: hashPassword(new_password), must_change_password: false, updated_at: new Date().toISOString() } },
      { upsert: true }
    );
    auditLog("vendor", "password_changed", req.vendor, {});
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── POST /admin/vendors/generate-credentials ──────────────────────────────
app.post("/admin/vendors/generate-credentials", adminAuth, async (req, res) => {
  try {
    const vendors = await getVendorList();
    const existing = await mdb.collection('vendor_profiles').find(
      { username: { $exists: true, $ne: '' } },
      { projection: { vendor_name: 1, username: 1, _id: 0 } }
    ).toArray();
    const hasCredentials = new Set(existing.map(e => e.vendor_name));

    const generated = [];
    for (const vendor of vendors) {
      if (hasCredentials.has(vendor)) continue; // already has credentials
      // Generate a unique username
      let username, tries = 0;
      do {
        username = generateUsername(vendor);
        const clash = await mdb.collection('vendor_profiles').findOne({ username }, { projection: { _id: 1 } });
        if (!clash) break;
        tries++;
      } while (tries < 10);

      await mdb.collection('vendor_profiles').updateOne(
        { vendor_name: vendor },
        { $set: { vendor_name: vendor, username, password_hash: hashPassword(DEFAULT_VENDOR_PASS), must_change_password: true, updated_at: new Date().toISOString() } },
        { upsert: true }
      );
      generated.push({ vendor_name: vendor, username, password: DEFAULT_VENDOR_PASS });
    }
    auditLog("admin", "generate_vendor_credentials", "all", { count: generated.length });
    res.json({ success: true, generated, total: generated.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GET /admin/vendors/credentials ───────────────────────────────────────
app.get("/admin/vendors/credentials", adminAuth, async (req, res) => {
  try {
    const docs = await mdb.collection('vendor_profiles').find(
      { username: { $exists: true, $ne: '' } },
      { projection: { vendor_name: 1, username: 1, must_change_password: 1, _id: 0 } }
    ).toArray();
    res.json({ credentials: docs });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── POST /admin/vendors/:name/reset-password ──────────────────────────────
app.post("/admin/vendors/:name/reset-password", adminAuth, async (req, res) => {
  const { name } = req.params;
  try {
    await mdb.collection('vendor_profiles').updateOne(
      { vendor_name: name },
      { $set: { password_hash: hashPassword(DEFAULT_VENDOR_PASS), must_change_password: true, updated_at: new Date().toISOString() } },
      { upsert: true }
    );
    auditLog("admin", "reset_vendor_password", name, {});
    res.json({ success: true, message: `Password reset to ${DEFAULT_VENDOR_PASS}` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── POST /vendor/logout ───────────────────────────────────────────────────
app.post("/vendor/logout", vendorAuth, (req, res) => {
  const token = req.headers.authorization.replace("Bearer ", "").trim();
  vendorSessions.delete(token);
  res.json({ success: true });
});

// Admin: generate a one-time vendor session token to impersonate a vendor
app.post("/admin/vendors/:name/impersonate", adminAuth, async (req, res) => {
  const vendorName = decodeURIComponent(req.params.name);
  const vc = await VC.get(vendorName);
  if (!vc) return res.status(404).json({ error: "Vendor not found." });
  const token = require('crypto').randomBytes(32).toString('hex');
  vendorSessions.set(token, { vendorName, expiresAt: Date.now() + 2 * 60 * 60 * 1000 }); // 2hr
  auditLog("admin", "vendor_impersonate", vendorName, {});
  res.json({ token });
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
    const vStages = await mdb.collection('order_vendor_stage').find({ vendor_name: req.vendor }, { projection: { shopify_id: 1, stage: 1, awb: 1, courier: 1, tracking_url: 1, stage_started_at: 1, penalty_triggered: 1, warning_sent: 1, _id: 0 } }).toArray();
    const vStageMap = Object.fromEntries(vStages.map(r => [r.shopify_id, r]));
    // Confirmed penalties for this vendor
    const vConfirmedPenalties = await mdb.collection('order_penalties').find({ vendor_name: req.vendor, status: 'confirmed' }, { projection: { shopify_id: 1, penalty_amount: 1, _id: 0 } }).toArray();
    const vConfirmedPenaltyMap = {}; // { shopify_id: totalAmount }
    vConfirmedPenalties.forEach(p => { vConfirmedPenaltyMap[p.shopify_id] = (vConfirmedPenaltyMap[p.shopify_id] || 0) + (p.penalty_amount || 0); });

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

        // Find this vendor's Shopify fulfillment by matching line item IDs
        const myLineItemIds = new Set(myItems.map(li => li.id));
        const myFulfillment = (o.fulfillments || []).find(f =>
          (f.line_items || []).some(fli => myLineItemIds.has(fli.id))
        );

        return {
          id:           o.name,
          shopifyId:    String(o.id),
          customer:     o.customer ? `${o.customer.first_name ?? ""} ${o.customer.last_name ?? ""}`.trim() : "Guest",
          email:        o.email        ?? "",
          phone:        o.shipping_address?.phone ?? o.customer?.phone ?? "",
          date:         (o.created_at ?? "").split("T")[0],
          status:       mapStatus(o.fulfillment_status),
          stage:        higherStage(
            higherStage(vStageMap[String(o.id)]?.stage || 'new', meta.stage || 'new'),
            vendorStagesFromFulfillments(o.fulfillments, o.line_items)[req.vendor] || null
          ),
          financial:    o.financial_status ?? "—",
          tags:         o.tags ?? "",
          currency:     o.currency ?? "INR",
          myRevenue:    parseFloat(myRevenue.toFixed(2)),
          shippingCharge,
          paymentType:  payType,
          advancePaid,
          totalCollectable: parseFloat((myRevenue + shippingCharge).toFixed(2)),
          remainingCOD:     parseFloat(Math.max(0, myRevenue + shippingCharge - advancePaid).toFixed(2)),
          awb:          vStageMap[String(o.id)]?.awb || "",
          courier:      vStageMap[String(o.id)]?.courier || "",
          trackingUrl:  vStageMap[String(o.id)]?.tracking_url || "",
          deliveryStatus: (()=>{
            // Shopify tracks shipment_status for some couriers; for panel-created orders fall back to our stage
            if (myFulfillment?.shipment_status) return myFulfillment.shipment_status;
            const vs = vStageMap[String(o.id)]?.stage;
            if (vs === 'delivered') return 'delivered';
            if (vs === 'transit')   return 'in_transit';
            if (vs === 'pickup')    return 'ready_for_pickup';
            if (vs === 'rto')       return 'failure';
            return "";
          })(),
          stageStartedAt:   vStageMap[String(o.id)]?.stage_started_at || 0,
          penaltyTriggered: vStageMap[String(o.id)]?.penalty_triggered || 0,
          warningSent:      vStageMap[String(o.id)]?.warning_sent || 0,
          shopifyFulfilled:    !meta.awb && (o.fulfillments||[]).length > 0,
          superHold:           !!meta.super_hold,
          confirmedPenalty:    vConfirmedPenaltyMap[String(o.id)] || 0,
          myItems: myItems.map(li => ({
            id:        li.id,
            title:     li.title,
            variant:   li.variant_title || "",
            sku:       li.sku || "",
            quantity:  li.quantity,
            price:     parseFloat(li.price || 0),
            fulfilled: li.fulfillment_status === "fulfilled",
            product_id: li.product_id || null,
          })),
          fulfillments: (o.fulfillments || [])
            .filter(f => (f.line_items || []).some(fli => {
              const vendor = (o.line_items || []).find(li => li.id === fli.id)?.vendor || "";
              return vendor.toLowerCase() === vName;
            }))
            .map(f => ({
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
    const fromDate = req.query.from ? `${req.query.from}T00:00:00Z` : "2000-01-01T00:00:00Z";
    const toDate   = req.query.to   ? `${req.query.to}T23:59:59Z`   : null;
    const allOrders = await fetchAllOrders("any", fromDate, toDate);
    const vName = req.vendor.toLowerCase();
    const mine  = allOrders.filter(o => (o.line_items || []).some(li => (li.vendor || "").toLowerCase() === vName));

    const vStages = await mdb.collection('order_vendor_stage').find({ vendor_name: req.vendor }, { projection: { shopify_id: 1, stage: 1, awb: 1, _id: 0 } }).toArray();
    const vsMap = Object.fromEntries(vStages.map(r => [r.shopify_id, r]));
    const DISPATCHED_S = ['ready','pickup','transit','delivered','rto'];

    let revenue = 0, dispatchedRev = 0, pendingRev = 0;
    let totalActive = 0, dispatched = 0, pendingCount = 0;
    const fulfilled = mine.filter(o => o.fulfillment_status === "fulfilled").length;
    const cancelled = mine.filter(o => o.financial_status === "voided" || o.cancelled_at).length;

    mine.forEach(o => {
      const items = (o.line_items || []).filter(li => (li.vendor || "").toLowerCase() === vName);
      const rev = items.reduce((s, li) => s + parseFloat(li.price || 0) * (li.quantity || 1), 0);
      revenue += rev;
      const vs = vsMap[String(o.id)];
      const stage = vs?.stage || 'new';
      if (!['confirmed','partial','ready','pickup','transit','delivered','rto'].includes(stage)) return;
      totalActive++;
      if (DISPATCHED_S.includes(stage) || vs?.awb) { dispatched++; dispatchedRev += rev; }
      else if (['confirmed','partial'].includes(stage)) { pendingCount++; pendingRev += rev; }
    });

    const dispatchRate = totalActive > 0 ? Math.round(dispatched / totalActive * 100) : 0;

    res.json({
      total: mine.length,
      revenue: parseFloat(revenue.toFixed(2)),
      avg: mine.length ? parseFloat((revenue / mine.length).toFixed(2)) : 0,
      fulfilled, pending: mine.filter(o => !o.fulfillment_status || o.fulfillment_status === "unfulfilled").length, cancelled,
      dispatch: {
        rate: dispatchRate,
        totalActive,
        dispatched,
        pendingCount,
        dispatchedRev: parseFloat(dispatchedRev.toFixed(2)),
        pendingRev: parseFloat(pendingRev.toFixed(2)),
      },
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
    const openFOs = (foData.fulfillment_orders || []).filter(fo => ['open', 'in_progress'].includes(fo.status));
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

    // Step 4: save AWB to this vendor's stage record — ready = tracking submitted, awaiting pickup
    await OVS.upsert(shopifyId, vendorName, {
      stage: 'ready', awb, courier: courier || '', tracking_url: trackingUrl || '',
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

    // ── Vendor fulfillment leaderboard ────────────────────────────────────
    const DISPATCHED_S = new Set(['ready','pickup','transit','delivered','rto']);
    const PENDING_S    = new Set(['confirmed','partial']);
    const allVS = await mdb.collection('order_vendor_stage').find({}, { projection: { shopify_id: 1, vendor_name: 1, stage: 1, awb: 1, stage_started_at: 1, _id: 0 } }).toArray();
    const vsMap = {};
    allVS.forEach(r => { if (!vsMap[r.shopify_id]) vsMap[r.shopify_id] = {}; vsMap[r.shopify_id][r.vendor_name] = r; });

    const vendorFulfill = {};
    const now = Date.now();
    raw.forEach(o => {
      const sid = String(o.id);
      const vendors = [...new Set((o.line_items || []).map(li => li.vendor).filter(Boolean))];
      vendors.forEach(v => {
        const vs = vsMap[sid]?.[v];
        const stage = vs?.stage || metaMap[sid]?.stage || 'new';
        if (!['confirmed','partial','ready','pickup','transit','delivered','rto'].includes(stage)) return;
        if (!vendorFulfill[v]) vendorFulfill[v] = { confirmed: 0, dispatched: 0, pending: 0, pendingOld: 0, dispatchedRev: 0, pendingRev: 0 };
        const vItems = (o.line_items || []).filter(li => (li.vendor || '') === v);
        const rev = vItems.reduce((s, li) => s + parseFloat(li.price || 0) * (li.quantity || 1), 0);
        vendorFulfill[v].confirmed++;
        if (DISPATCHED_S.has(stage) || vs?.awb) { vendorFulfill[v].dispatched++; vendorFulfill[v].dispatchedRev += rev; }
        else if (PENDING_S.has(stage)) {
          vendorFulfill[v].pending++;
          vendorFulfill[v].pendingRev += rev;
          const hoursInStage = vs?.stage_started_at ? (now - vs.stage_started_at) / 3600000 : 0;
          if (hoursInStage > 48) vendorFulfill[v].pendingOld++;
        }
      });
    });

    const vendorLeaderboard = Object.entries(vendorFulfill)
      .filter(([, d]) => d.confirmed >= 3) // only vendors with meaningful order count
      .map(([vendor, d]) => ({
        vendor,
        confirmed: d.confirmed,
        dispatched: d.dispatched,
        pending: d.pending,
        pendingOld: d.pendingOld, // pending >48hr
        dispatchRate: d.confirmed > 0 ? Math.round(d.dispatched / d.confirmed * 100) : 0,
        dispatchedRev: parseFloat(d.dispatchedRev.toFixed(2)),
        pendingRev: parseFloat(d.pendingRev.toFixed(2)),
      }))
      .sort((a, b) => b.pending - a.pending || a.dispatchRate - b.dispatchRate) // most pending first, then lowest rate
      .slice(0, 15);

    res.json({
      totalOrders: raw.length,
      stageCounts,
      totalRevenue: parseFloat(totalRevenue.toFixed(2)),
      pendingCommission: parseFloat((pendRow?.t || 0).toFixed(2)),
      vendorLeaderboard,
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
    const allVS   = await mdb.collection('order_vendor_stage').find({}, { projection: { shopify_id:1, vendor_name:1, stage:1, awb:1, _id:0 } }).toArray();

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

    // ── Fulfillment stats — single stageMap, one entry per unique order
    const fulfillStats = (() => {
      const DISPATCHED_STAGES = ['ready','pickup','transit','delivered','rto'];
      const PENDING_STAGES    = ['confirmed','partial'];
      const DISPATCHED_SET    = new Set(DISPATCHED_STAGES);
      const PENDING_SET       = new Set(PENDING_STAGES);

      // Build vsMap for period orders: shopify_id → array of vendor stages
      const periodIds  = new Set(ordersMain.map(o => String(o.id)));
      const vsInPeriod = allVS.filter(r => periodIds.has(r.shopify_id));
      const vsMapPeriod = {};
      vsInPeriod.forEach(r => {
        if (!vsMapPeriod[r.shopify_id]) vsMapPeriod[r.shopify_id] = [];
        if (r.stage) vsMapPeriod[r.shopify_id].push(r.stage);
      });

      // Single stageMap — one entry per unique order, stage = higherStage of meta + all vendor stages
      const stageMap = {};
      let revDispatched=0, revPending=0, revDelivered=0, revInTransit=0, revRto=0, revNotDispatched=0, revNotConfirmed=0;
      const IN_TRANSIT_SET = new Set(['ready','pickup','transit']);

      ordersMain.forEach(o => {
        const sid    = String(o.id);
        const base   = o.cancelled_at ? 'cancelled' : (metaMap[sid]?.stage || 'new');
        const vStages = vsMapPeriod[sid] || [];
        const stage  = vStages.reduce((best, s) => higherStage(best, s), base);
        stageMap[stage] = (stageMap[stage] || 0) + 1;

        const price = parseFloat(o.total_price || 0);
        if (DISPATCHED_SET.has(stage)) {
          revDispatched += price;
          if (stage === 'delivered') revDelivered += price;
          else if (stage === 'rto') revRto += price;
          else if (IN_TRANSIT_SET.has(stage)) revInTransit += price;
        } else if (PENDING_SET.has(stage)) {
          revPending += price;
          revNotDispatched += price;  // confirmed + partial
        } else if (stage === 'new' || stage === 'hold') {
          revNotDispatched += price;  // new + hold — not yet confirmed but still orders
          revNotConfirmed  += price;
        }
        // cancelled excluded from revNotDispatched intentionally
      });

      // Derived counts — all from stageMap (unique orders)
      const total      = ordersMain.length;
      const dispatched = DISPATCHED_STAGES.reduce((s,k) => s+(stageMap[k]||0), 0);
      const pending    = PENDING_STAGES.reduce((s,k) => s+(stageMap[k]||0), 0);
      const active     = dispatched + pending;
      const delivered  = stageMap.delivered || 0;
      const rto        = stageMap.rto || 0;
      const cancelled  = stageMap.cancelled || 0;
      const notConfirmed = (stageMap.new||0) + (stageMap.hold||0) + cancelled;

      const dispatch_rate  = active     > 0 ? Math.round(dispatched / active     * 100) : 0;
      const delivery_rate  = dispatched > 0 ? Math.round(delivered  / dispatched * 100) : 0;
      const overall_rate   = total      > 0 ? Math.round(dispatched / total      * 100) : 0;

      return {
        total, active, dispatched, pending, delivered, rto, cancelled, notConfirmed,
        dispatch_rate, delivery_rate, overall_rate,
        stageMap,      // { new, confirmed, partial, ready, pickup, transit, delivered, rto, hold, cancelled }
        stageBreakdown: stageMap,  // alias — some frontend code uses this name
        revDispatched:    parseFloat(revDispatched.toFixed(2)),
        revPending:       parseFloat(revPending.toFixed(2)),
        revDelivered:     parseFloat(revDelivered.toFixed(2)),
        revInTransit:     parseFloat(revInTransit.toFixed(2)),
        revRto:           parseFloat(revRto.toFixed(2)),
        revNotDispatched:  parseFloat(revNotDispatched.toFixed(2)),  // all non-dispatched excl. cancelled
        revNotConfirmed:   parseFloat(revNotConfirmed.toFixed(2)),  // new + hold revenue
        rto_rate: dispatched > 0 ? Math.round(rto / dispatched * 100) : 0,
        // legacy aliases so existing frontend doesn't break
        confirmed:     active,
        pending_count: pending,
        dispatched_meta: dispatched,
        revConfirmed:  parseFloat(revPending.toFixed(2)),
      };
    })();

    // ── Payment split (30d)
    const paymentSplit = {
      prepaid: orders30d.filter(o => isPrepaid(o)).length,
      partial: orders30d.filter(o => !isPrepaid(o) && ((metaMap[String(o.id)]?.advance_paid || 0) > 0 || isPartial(o))).length,
      cod:     orders30d.filter(o => !isPrepaid(o) && !isPartial(o) && !((metaMap[String(o.id)]?.advance_paid || 0) > 0)).length,
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
      trendMap[key] = { date: key, orders: 0, revenue: 0, confirmed: 0 };
    }
    ordersMain.forEach(o => {
      const key = o.created_at.slice(0,10);
      if (trendMap[key]) {
        trendMap[key].orders++;
        trendMap[key].revenue = parseFloat((trendMap[key].revenue + parseFloat(o.total_price||0)).toFixed(2));
        const stage = (metaMap[String(o.id)] || {}).stage || 'new';
        if (!['new','hold','cancelled'].includes(stage)) trendMap[key].confirmed++;
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

    // ── Vendor fulfillment leaderboard (all time, sorted by most pending)
    const allVSForLb = await mdb.collection('order_vendor_stage').find({}, { projection: { shopify_id: 1, vendor_name: 1, stage: 1, awb: 1, stage_started_at: 1, _id: 0 } }).toArray();
    const vsMapLb = {};
    allVSForLb.forEach(r => { if (!vsMapLb[r.shopify_id]) vsMapLb[r.shopify_id] = {}; vsMapLb[r.shopify_id][r.vendor_name] = r; });
    const vfMap = {};
    const nowMs = Date.now();
    raw.forEach(o => {
      const sid = String(o.id);
      const vendors = [...new Set((o.line_items||[]).map(li=>li.vendor).filter(Boolean))];
      vendors.forEach(v => {
        const vs = vsMapLb[sid]?.[v];
        const stage = vs?.stage || metaMap[sid]?.stage || 'new';
        if (!['confirmed','partial','ready','pickup','transit','delivered','rto'].includes(stage)) return;
        if (!vfMap[v]) vfMap[v] = { confirmed: 0, dispatched: 0, pending: 0, pendingOld48: 0 };
        vfMap[v].confirmed++;
        if (['ready','pickup','transit','delivered','rto'].includes(stage) || vs?.awb) vfMap[v].dispatched++;
        else if (['confirmed','partial'].includes(stage)) {
          vfMap[v].pending++;
          const hrs = vs?.stage_started_at ? (nowMs - vs.stage_started_at) / 3600000 : 0;
          if (hrs > 48) vfMap[v].pendingOld48++;
        }
      });
    });
    const vendorLeaderboard = Object.entries(vfMap)
      .filter(([, d]) => d.confirmed >= 3)
      .map(([vendor, d]) => ({
        vendor,
        confirmed: d.confirmed,
        dispatched: d.dispatched,
        pending: d.pending,
        pendingOld48: d.pendingOld48,
        dispatchRate: d.confirmed > 0 ? Math.round(d.dispatched / d.confirmed * 100) : 0,
      }))
      .sort((a, b) => b.pending - a.pending || a.dispatchRate - b.dispatchRate)
      .slice(0, 15);

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
      vendorLeaderboard,
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
    // Confirmed penalties per order: { shopify_id: { vendor_name: totalAmount } }
    const confirmedPenaltyDocs = await mdb.collection('order_penalties').find({ status: 'confirmed' }, { projection: { shopify_id: 1, vendor_name: 1, penalty_amount: 1, _id: 0 } }).toArray();
    const confirmedPenaltyMap = {}; // { shopify_id: { vendor_name: amount } }
    confirmedPenaltyDocs.forEach(p => {
      if (!confirmedPenaltyMap[p.shopify_id]) confirmedPenaltyMap[p.shopify_id] = {};
      confirmedPenaltyMap[p.shopify_id][p.vendor_name] = (confirmedPenaltyMap[p.shopify_id][p.vendor_name] || 0) + (p.penalty_amount || 0);
    });
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
      const sid = String(o.id);

      // Populate vtMap from Shopify fulfillments for vendors without an OVS tracking entry
      // Match each fulfillment to vendor(s) via fulfilled line item IDs
      if ((o.fulfillments || []).length > 0) {
        const lineItemVendorMap = Object.fromEntries((o.line_items || []).map(li => [li.id, li.vendor]).filter(([,v]) => v));
        for (const f of o.fulfillments) {
          if (!f.tracking_number) continue;
          const fulfilledVendors = [...new Set((f.line_items || []).map(fli => lineItemVendorMap[fli.id]).filter(Boolean))];
          for (const v of fulfilledVendors) {
            if (!vtMap[sid]) vtMap[sid] = {};
            if (!vtMap[sid][v]) { // only fill if OVS didn't already set it
              vtMap[sid][v] = { awb: f.tracking_number || '', courier: f.tracking_company || '', trackingUrl: f.tracking_url || '' };
            }
          }
        }
      }

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
        vendorStages:   (() => {
            const shopifyMap = vendorStagesFromFulfillments(o.fulfillments, o.line_items);
            if (vendors.length > 1) {
              return Object.fromEntries(vendors.map(v => {
                const stored = vsMap[String(o.id)]?.[v] || meta.stage || 'new';
                return [v, shopifyMap[v] ? higherStage(stored, shopifyMap[v]) : stored];
              }));
            } else {
              const m = { ...(vsMap[String(o.id)] || {}) };
              for (const [v, s] of Object.entries(shopifyMap)) m[v] = higherStage(m[v], s);
              return m;
            }
          })(),
        stage:          (() => {
            const base = meta.stage || 'new';
            const allVS = vsMap[String(o.id)] || {};
            const shopifyMap = vendorStagesFromFulfillments(o.fulfillments, o.line_items);
            const allStages = [
              ...Object.values(allVS),
              ...Object.values(shopifyMap),
            ];
            return allStages.reduce((best, s) => higherStage(best, s), base);
          })(),
        vendorTracking:        vtMap[String(o.id)] || {},
        vendorPenalty:         vpMap[String(o.id)] || {},
        confirmedPenalties:    confirmedPenaltyMap[String(o.id)] || {},
        paymentType:    meta.payment_type || "cod",
        advancePaid:    meta.advance_paid || 0,
        notes:          meta.notes || "",
        awb:            meta.awb || (vendors.length === 1 ? (o.fulfillments||[]).find(f=>f.tracking_number)?.tracking_number || "" : ""),
        courier:        meta.courier || (vendors.length === 1 ? (o.fulfillments||[]).find(f=>f.tracking_company)?.tracking_company || "" : ""),
        trackingUrl:    meta.tracking_url || (vendors.length === 1 ? (o.fulfillments||[]).find(f=>f.tracking_url)?.tracking_url || "" : ""),
        deliveryStatus: meta.delivery_status || (o.fulfillments||[]).find(f=>f.shipment_status)?.shipment_status || "",
        shopifyFulfilled: (o.fulfillments||[]).length > 0,
        superHold:      !!meta.super_hold,
        tags:           o.tags || "",
        lineItems:      (o.line_items || []).map(li => ({
          title: li.title, vendor: li.vendor, qty: li.quantity,
          price: parseFloat(li.price || 0), sku: li.sku || "",
          variant: li.variant_title || '', product_id: li.product_id || null,
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

  // Admin manual override — no guards, unconditional sync to all vendors
  const fulfilledStages = ['ready','pickup','transit','delivered','rto','cancelled'];
  try {
    const od = await shopifyREST(`/orders/${id}.json?fields=id,line_items`);
    const vendors = [...new Set((od?.order?.line_items || []).map(li => li.vendor).filter(Boolean))];
    for (const vendor of vendors) {
      const existing = await mdb.collection('order_vendor_stage').findOne({ shopify_id: id, vendor_name: vendor }, { projection: { stage: 1, stage_started_at: 1, warning_sent: 1, penalty_triggered: 1, _id: 0 } });
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

// ── POST /admin/orders/:id/super-hold ────────────────────────────────────
// Mark or release super hold on an order. Admin-only, bypasses all guards.
app.post("/admin/orders/:id/super-hold", adminAuth, async (req, res) => {
  const { id } = req.params;
  const { enable } = req.body || {}; // true = mark super hold, false = release
  const now = new Date().toISOString();
  const nowMs = Date.now();
  if (enable) {
    // Mark super hold: set flag + stage=hold on meta + all vendors
    await OM.upsert(id, { super_hold: true, stage: 'hold', updated_at: now });
    try {
      const od = await shopifyREST(`/orders/${id}.json?fields=id,line_items`);
      const vendors = [...new Set((od?.order?.line_items || []).map(li => li.vendor).filter(Boolean))];
      for (const vendor of vendors) {
        const existing = await mdb.collection('order_vendor_stage').findOne({ shopify_id: id, vendor_name: vendor }, { projection: { stage_started_at: 1, _id: 0 } });
        await OVS.upsert(id, vendor, { stage: 'hold', updated_at: now, stage_started_at: existing?.stage_started_at || nowMs, warning_sent: 0, penalty_triggered: 0 });
      }
    } catch(e) { console.error('super-hold vendor sync error:', e.message); }
    auditLog("admin", "super_hold_set", id, {});
    res.json({ success: true, super_hold: true });
  } else {
    // Release super hold: clear flag. Stage stays as-is — admin should set stage separately or re-sync tags.
    await OM.upsert(id, { super_hold: false, updated_at: now });
    auditLog("admin", "super_hold_released", id, {});
    res.json({ success: true, super_hold: false });
  }
});

// ── POST /admin/orders/bulk-update ────────────────────────────────────────
// Bulk set stage + add/remove Shopify tags for multiple orders
app.post("/admin/orders/bulk-update", adminAuth, async (req, res) => {
  const { order_ids, stage, add_tags = [], remove_tags = [] } = req.body || {};
  if (!Array.isArray(order_ids) || order_ids.length === 0)
    return res.status(400).json({ error: "order_ids array required." });
  if (!stage && add_tags.length === 0 && remove_tags.length === 0)
    return res.status(400).json({ error: "Specify stage or tags to add/remove." });

  const VALID_STAGES = ["new","confirmed","partial","ready","pickup","transit","delivered","rto","hold","cancelled"];
  if (stage && !VALID_STAGES.includes(stage))
    return res.status(400).json({ error: "Invalid stage." });

  const now = new Date().toISOString();
  const results = { updated: [], failed: [] };

  // Find which Shopify tag maps to the new stage (if any)
  let stageTag = null;
  if (stage) {
    const mapping = await mdb.collection('tag_mappings').findOne({ stage }, { projection: { shopify_tag: 1, _id: 0 } });
    stageTag = mapping?.shopify_tag || null;
  }

  const shopifyToken = await getAccessToken();

  for (const id of order_ids) {
    try {
      // 1. Update our stage
      if (stage) {
        await OM.upsert(id, { stage, updated_at: now });
        fireStageEmails(id, stage).catch(() => {});
        // Admin bulk override — no guards, unconditional sync to all vendors
        const fulfilledStages = ['ready','pickup','transit','delivered','rto','cancelled'];
        const nowMs = Date.now();
        try {
          const od = await shopifyREST(`/orders/${id}.json?fields=id,line_items`);
          const vendors = [...new Set((od?.order?.line_items || []).map(li => li.vendor).filter(Boolean))];
          for (const vendor of vendors) {
            const existing = await mdb.collection('order_vendor_stage').findOne({ shopify_id: id, vendor_name: vendor }, { projection: { stage: 1, stage_started_at: 1, warning_sent: 1, penalty_triggered: 1, _id: 0 } });
            const newStartedAt = ['confirmed','partial'].includes(stage) ? (existing?.stage_started_at || nowMs) : (existing?.stage_started_at || 0);
            await OVS.upsert(id, vendor, { stage, updated_at: now, stage_started_at: newStartedAt, warning_sent: fulfilledStages.includes(stage)?0:(existing?.warning_sent||0), penalty_triggered: fulfilledStages.includes(stage)?0:(existing?.penalty_triggered||0) });
          }
        } catch(e) { /* non-fatal */ }
      }

      // 2. Update Shopify tags
      let currentTagsArr = [];
      try {
        const od = await shopifyREST(`/orders/${id}.json?fields=id,tags`);
        currentTagsArr = (od?.order?.tags || '').split(',').map(t => t.trim()).filter(Boolean);
      } catch(e) { /* use empty if fetch fails */ }

      let changed = false;
      // Add stage tag (from tag mapping)
      if (stageTag && !currentTagsArr.some(t => t.toLowerCase() === stageTag.toLowerCase())) {
        currentTagsArr.push(stageTag);
        changed = true;
      }
      // Add extra tags
      for (const t of add_tags) {
        if (t && !currentTagsArr.some(x => x.toLowerCase() === t.toLowerCase())) {
          currentTagsArr.push(t);
          changed = true;
        }
      }
      // Remove tags
      if (remove_tags.length > 0) {
        const removeLower = remove_tags.map(t => t.toLowerCase());
        const before = currentTagsArr.length;
        currentTagsArr = currentTagsArr.filter(t => !removeLower.includes(t.toLowerCase()));
        if (currentTagsArr.length !== before) changed = true;
      }

      if (changed) {
        await fetch(`https://${SHOP}.myshopify.com/admin/api/2025-01/orders/${id}.json`, {
          method: 'PUT',
          headers: { 'X-Shopify-Access-Token': shopifyToken, 'Content-Type': 'application/json' },
          body: JSON.stringify({ order: { id, tags: currentTagsArr.join(', ') } }),
        });
      }

      results.updated.push(id);
    } catch (e) {
      results.failed.push({ id, error: e.message });
    }
  }

  auditLog("admin", "bulk_update", "multiple", { count: results.updated.length, stage, add_tags, remove_tags });
  res.json({ success: true, ...results, stageTag });
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
  const fulfilledStages = ['ready','pickup','transit','delivered','rto','cancelled'];
  const existing = await mdb.collection('order_vendor_stage').findOne({ shopify_id: id, vendor_name }, { projection: { _id: 0 } });

  const newStartedAt = ['confirmed','partial'].includes(stage) ? nowMs : (existing?.stage_started_at || 0);
  const newWarning   = fulfilledStages.includes(stage) ? 0 : (['confirmed','partial'].includes(stage) ? 0 : (existing?.warning_sent || 0));
  const newPenalty   = fulfilledStages.includes(stage) ? 0 : (existing?.penalty_triggered || 0);

  await OVS.upsert(id, vendor_name, { stage, updated_at: now, stage_started_at: newStartedAt, warning_sent: newWarning, penalty_triggered: newPenalty });
  auditLog("admin", "vendor_stage_change", id, { vendor_name, stage });
  res.json({ success: true, vendor_name, stage });
});

// ── POST /admin/migrate/stringify-ids — one-time fix: convert numeric shopify_id to string ──
app.post("/admin/migrate/stringify-ids", adminAuth, async (req, res) => {
  try {
    const collections = ['order_vendor_stage', 'order_meta', 'order_penalties', 'delay_remarks'];
    let total = 0;
    for (const col of collections) {
      const docs = await mdb.collection(col).find({ shopify_id: { $type: 'number' } }, { projection: { _id: 1, shopify_id: 1 } }).toArray();
      for (const doc of docs) {
        await mdb.collection(col).updateOne({ _id: doc._id }, { $set: { shopify_id: String(doc.shopify_id) } });
        total++;
      }
    }
    res.json({ ok: true, converted: total });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
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
    const openFOs = (foData.fulfillment_orders || []).filter(fo => ['open', 'in_progress'].includes(fo.status));
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

    // Save AWB/courier/tracking to order_vendor_stage — ready = tracking submitted, awaiting pickup
    await OVS.upsert(shopifyId, vendor_name, { awb, courier: courier || '', tracking_url: tracking_url || '', stage: 'ready', updated_at: new Date().toISOString() });
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
    // No duplicate-period block — same period can have multiple invoices for different batches of orders

    // Build set of order IDs already invoiced for this vendor (any invoice, paid or pending)
    const existingSettlements = await mdb.collection('settlements').find({ vendor_name }, { projection: { id: 1, _id: 0 } }).toArray();
    const existingSettlIds = existingSettlements.map(s => s.id);
    const alreadyInvoicedOrders = new Set();
    if (existingSettlIds.length > 0) {
      const existingSettlOrders = await mdb.collection('settlement_orders').find({ settlement_id: { $in: existingSettlIds } }, { projection: { shopify_order_id: 1, _id: 0 } }).toArray();
      existingSettlOrders.forEach(so => alreadyInvoicedOrders.add(String(so.shopify_order_id)));
    }

    // Fetch orders created in the period — invoice is per creation date, not delivery date
    const allOrders = await fetchAllOrders("any", period_start + "T00:00:00Z", period_end + "T23:59:59Z");
    const vName  = vendor_name.toLowerCase();
    const vProfile = await mdb.collection('vendor_profiles').findOne({ vendor_name }, { projection: { commission_pct: 1, _id: 0 } });
    const vConfig  = await VC.get(vendor_name);
    const config   = { commission_pct: vProfile?.commission_pct ?? vConfig?.commission_pct ?? 20 };
    const metas  = await mdb.collection('order_meta').find({}, { projection: { _id: 0 } }).toArray();
    const metaMap = Object.fromEntries(metas.map(m => [m.shopify_id, m]));
    const vendorStages = await mdb.collection('order_vendor_stage').find({ vendor_name }, { projection: { shopify_id: 1, stage: 1, _id: 0 } }).toArray();
    const vendorStageMap = Object.fromEntries(vendorStages.map(r => [r.shopify_id, r.stage]));

    // Only include delivered orders that have NOT been invoiced before
    const vendorDelivered = allOrders.filter(o => {
      const sid = String(o.id);
      if (alreadyInvoicedOrders.has(sid)) return false; // skip already-invoiced
      const dbStage = higherStage(vendorStageMap[sid] || 'new', metaMap[sid]?.stage || 'new');
      const shopifyStages = vendorStagesFromFulfillments(o.fulfillments || [], o.line_items || []);
      const effectiveStage = higherStage(dbStage, shopifyStages[vendor_name] || null);
      return effectiveStage === "delivered" &&
        (o.line_items || []).some(li => (li.vendor || "").toLowerCase() === vName);
    });

    if (vendorDelivered.length === 0)
      return res.status(400).json({ error: "No new uninvoiced delivered orders found for this period. All orders have already been included in previous invoices." });

    let totalRev = 0, totalComm = 0, totalGst = 0, totalAdv = 0, totalNet = 0, totalShipping = 0;
    const orderDetails = [];

    for (const o of vendorDelivered) {
      const meta    = metaMap[String(o.id)] || {};
      const payType = meta.payment_type || "cod";
      const isCod   = payType !== "prepaid";
      const myItems = (o.line_items || []).filter(li => (li.vendor || "").toLowerCase() === vName);
      const myRev   = myItems.reduce((s, li) => s + parseFloat(li.price || 0) * (li.quantity || 1), 0);

      // Check product-level rules per line item
      let totalItemComm = 0, totalItemGst = 0, totalItemNet = 0;
      for (const li of myItems) {
        const itemRev = parseFloat(li.price || 0) * (li.quantity || 1);
        const productRule = await findProductRule(vendor_name, li.product_id, li.sku);
        const liCalc = productRule
          ? calcProductCommission(productRule, li.price, li.quantity || 1)
          : calcCommission(itemRev, payType, config.commission_pct, 0);
        totalItemComm += liCalc.commission;
        totalItemGst  += liCalc.gst;
        totalItemNet  += liCalc.net;
      }
      const advancePaid = meta.advance_paid || 0;
      // Fold advance into net (reduces what vendor owes)
      const calcNet = parseFloat((totalItemNet - advancePaid).toFixed(2));
      const calc = {
        commission: parseFloat(totalItemComm.toFixed(2)),
        gst:        parseFloat(totalItemGst.toFixed(2)),
        net:        calcNet,
      };

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
    }

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
    const { from, to } = req.query;
    // Filter by order creation date — period represents when orders were placed
    const allOrders = await fetchAllOrders("any", from ? from + "T00:00:00Z" : "2020-01-01T00:00:00Z", to ? to + "T23:59:59Z" : null);
    const metas = await mdb.collection('order_meta').find({}, { projection: { _id: 0 } }).toArray();
    const metaMap = Object.fromEntries(metas.map(m => [m.shopify_id, m]));
    const vProfiles = await mdb.collection('vendor_profiles').find({}, { projection: { _id: 0 } }).toArray();
    const vConfigs  = await VC.all();
    const vProfileMap = Object.fromEntries(vProfiles.map(v => [v.vendor_name, v]));
    const vConfigMap  = Object.fromEntries(vConfigs.map(v => [v.vendor_name, v]));

    // Aggregate settled amounts per vendor from paid invoices
    const allSettlDocs = await mdb.collection('settlements').find({}, { projection: { id: 1, vendor_name: 1, net_payable: 1, status: 1, invoice_no: 1, _id: 0 } }).toArray();
    const settledMapRaw = {};
    const settlByIdMap = {}; // { settlId: { vendor_name, invoice_no, status } }
    allSettlDocs.forEach(s => {
      if (s.status === 'paid') settledMapRaw[s.vendor_name] = (settledMapRaw[s.vendor_name] || 0) + (s.net_payable || 0);
      settlByIdMap[s.id] = { vendor_name: s.vendor_name, invoice_no: s.invoice_no, status: s.status };
    });
    // Build per-vendor, per-order invoice lookup from settlement_orders
    const allSettlOrders = await mdb.collection('settlement_orders').find({}, { projection: { settlement_id: 1, shopify_order_id: 1, _id: 0 } }).toArray();
    const invoiceOrderMap = {}; // { vendor: { orderId: { invoice_no, status } } }
    allSettlOrders.forEach(so => {
      const s = settlByIdMap[so.settlement_id];
      if (!s) return;
      if (!invoiceOrderMap[s.vendor_name]) invoiceOrderMap[s.vendor_name] = {};
      invoiceOrderMap[s.vendor_name][String(so.shopify_order_id)] = { invoice_no: s.invoice_no, status: s.status };
    });
    const settledMap = Object.fromEntries(Object.entries(settledMapRaw).map(([k,v]) => [k, parseFloat(v.toFixed(2))]));

    // Load confirmed penalties per vendor (not yet invoiced = not in any settlement_penalties)
    const invoicedPenaltyIds = new Set(
      (await mdb.collection('settlement_penalties').find({}, { projection: { penalty_id: 1, _id: 0 } }).toArray()).map(p => p.penalty_id)
    );
    const allConfirmedPenalties = await mdb.collection('order_penalties').find({ status: 'confirmed' }, { projection: { _id: 0 } }).toArray();
    const pendingPenaltyMap = {}; // { vendor_name: totalPendingPenalty }
    allConfirmedPenalties.forEach(p => {
      if (!invoicedPenaltyIds.has(p.id)) {
        pendingPenaltyMap[p.vendor_name] = (pendingPenaltyMap[p.vendor_name] || 0) + (p.penalty_amount || 0);
      }
    });

    const vendorMap = {};
    // Load all per-vendor stage overrides (include updated_at for date filtering)
    const allVendorStages = await mdb.collection('order_vendor_stage').find({}, { projection: { _id: 0 } }).toArray();
    const allVendorStageMap = {}; // { shopify_id: { vendor_name: { stage, updated_at } } }
    allVendorStages.forEach(r => {
      if (!allVendorStageMap[r.shopify_id]) allVendorStageMap[r.shopify_id] = {};
      allVendorStageMap[r.shopify_id][r.vendor_name] = { stage: r.stage, updated_at: r.updated_at };
    });

    // Date filter: apply on delivery date (when vendor stage was last updated to delivered)
    const fromDate = from ? new Date(from + "T00:00:00Z") : null;
    const toDate   = to   ? new Date(to   + "T23:59:59Z") : null;

    for (const o of allOrders) {
      const meta = metaMap[String(o.id)] || {};
      const orderStage = meta.stage || "new";
      const payType = meta.payment_type || "cod";
      const isCod = payType !== "prepaid";
      const orderShipping = (o.shipping_lines || []).reduce((s, l) => s + parseFloat(l.price || 0), 0);
      const ordVendorSet = new Set((o.line_items || []).map(li => li.vendor).filter(Boolean));
      const shippingPerVendor = ordVendorSet.size > 0 ? orderShipping / ordVendorSet.size : 0;

      // Track which vendors have DELIVERED items in THIS specific order
      const deliveredVendorsInOrder = new Set();

      // Also derive stages from Shopify fulfillments (same as admin orders endpoint)
      const shopifyVendorStages = vendorStagesFromFulfillments(o.fulfillments || [], o.line_items || []);

      for (const li of (o.line_items || [])) {
        const vendor = li.vendor;
        if (!vendor) continue;
        const vendorEntry = allVendorStageMap[String(o.id)]?.[vendor];
        const dbStage = higherStage(vendorEntry?.stage || 'new', orderStage);
        const shopifyStage = shopifyVendorStages[vendor] || null;
        const effectiveStage = higherStage(dbStage, shopifyStage);
        if (effectiveStage !== "delivered") continue;
        deliveredVendorsInOrder.add(vendor);
        if (!vendorMap[vendor]) vendorMap[vendor] = { orders: new Set(), orderDetails: {}, gross: 0, prepaidDiscount: 0, commission: 0, gst: 0, advance: 0, shipping: 0, net: 0, prepaidCollected: 0, codCommission: 0 };
        vendorMap[vendor].orders.add(String(o.id));
        if (!vendorMap[vendor].orderDetails[String(o.id)]) {
          const invTag = invoiceOrderMap[vendor]?.[String(o.id)] || null;
          vendorMap[vendor].orderDetails[String(o.id)] = { orderId: String(o.id), orderName: o.name, customer: `${o.customer?.first_name||''} ${o.customer?.last_name||''}`.trim(), paymentType: payType, createdAt: o.created_at, revenue: 0, items: [], invoiceNo: invTag?.invoice_no || null, invoiceStatus: invTag?.status || null };
        }
        vendorMap[vendor].orderDetails[String(o.id)].revenue += parseFloat(li.price || 0) * (li.quantity || 1);
        vendorMap[vendor].orderDetails[String(o.id)].items.push(`${li.name} x${li.quantity||1}`);
        const itemRev = parseFloat(li.price || 0) * (li.quantity || 1);

        // Check for product-level commission rule
        const productRule = await findProductRule(vendor, li.product_id, li.sku);
        let calc;
        if (productRule) {
          calc = calcProductCommission(productRule, li.price, li.quantity || 1);
        } else {
          const commPct = vProfileMap[vendor]?.commission_pct ?? vConfigMap[vendor]?.commission_pct ?? 20;
          calc = calcCommission(itemRev, payType, commPct, 0);
        }

        vendorMap[vendor].gross += itemRev;
        if (!isCod) {
          vendorMap[vendor].prepaidDiscount += (itemRev - calc.base);
          vendorMap[vendor].prepaidCollected += itemRev;
        } else {
          vendorMap[vendor].codCommission += calc.commission + calc.gst;
        }
        vendorMap[vendor].commission += calc.commission;
        vendorMap[vendor].gst += calc.gst;
        vendorMap[vendor].net += calc.net;
      }

      // Advance + shipping: only for vendors with delivered items IN THIS ORDER
      // Split advance equally across delivered vendors in this order (not all vendors)
      const deliveredCount = deliveredVendorsInOrder.size || 1;
      const advanceShare = (meta.advance_paid || 0) > 0 ? parseFloat(((meta.advance_paid || 0) / deliveredCount).toFixed(2)) : 0;

      deliveredVendorsInOrder.forEach(vendor => {
        if (isCod && advanceShare > 0) {
          vendorMap[vendor].advance += advanceShare;
          vendorMap[vendor].net -= advanceShare; // advance already collected → reduces what vendor owes
        }
        if (isCod && shippingPerVendor > 0) {
          vendorMap[vendor].shipping += shippingPerVendor;
          vendorMap[vendor].net += shippingPerVendor;
        }
      });
    }

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
      const prepaidCollected = parseFloat(d.prepaidCollected.toFixed(2));
      const codCommission = parseFloat(d.codCommission.toFixed(2));
      const pendingPenalty = parseFloat((pendingPenaltyMap[name] || 0).toFixed(2));
      const ordersList = Object.values(d.orderDetails || {}).sort((a,b) => new Date(b.createdAt)-new Date(a.createdAt));
      return { vendor: name, totalOrders: d.orders.size, gross, prepaidDiscount, commissionableSale, commissionPct: commPct, commission, gst, advance, shipping, netPayable, totalSettled, pendingSettlement, prepaidCollected, codCommission, pendingPenalty, ordersList };
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
      acc.pendingPenalty += v.pendingPenalty;
      return acc;
    }, { totalOrders: 0, gross: 0, prepaidDiscount: 0, commissionableSale: 0, commission: 0, gst: 0, advance: 0, shipping: 0, netPayable: 0, totalSettled: 0, pendingSettlement: 0, prepaidCollected: 0, codCommission: 0, pendingPenalty: 0 });

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
  const { shopify_tag, stage, priority = 99, super_hold_power = false } = req.body || {};
  if (!shopify_tag || !stage) return res.status(400).json({ error: "shopify_tag and stage required." });
  const VALID_STAGES = ["new","confirmed","partial","ready","pickup","transit","delivered","rto","hold","cancelled"];
  if (!VALID_STAGES.includes(stage)) return res.status(400).json({ error: `Invalid stage '${stage}'. Valid: ${VALID_STAGES.join(", ")}` });
  const existing = await mdb.collection('tag_mappings').findOne({ shopify_tag: { $regex: new RegExp(`^${shopify_tag.trim()}$`, 'i') } });
  if (existing) return res.status(400).json({ error: "A mapping for this tag already exists." });
  const id = await nextId('tag_mappings');
  await mdb.collection('tag_mappings').insertOne({ id, shopify_tag: shopify_tag.trim(), stage, priority: Number(priority), super_hold_power: !!super_hold_power, created_at: new Date().toISOString() });
  res.json({ success: true, id });
});

app.put("/admin/tag-mappings/:id/super-hold-power", adminAuth, async (req, res) => {
  const { enabled } = req.body || {};
  await mdb.collection('tag_mappings').updateOne({ id: parseInt(req.params.id) }, { $set: { super_hold_power: !!enabled } });
  res.json({ success: true });
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

function buildDemoTemplates(to) {
  const demoOrder = {
    id: 99999, name: '#TEST-001',
    created_at: new Date().toISOString(),
    financial_status: 'pending',
    total_price: '1299.00',
    total_shipping_price_set: { shop_money: { amount: '49.00' } },
    email: to || 'test@example.com',
    line_items: [{ title: 'Demo Product (Size: M)', variant_title: 'Size: M', quantity: 1, price: '1250.00', vendor: 'Demo Vendor', sku: 'DEMO-001' }],
    shipping_address: { name: 'Test Customer', address1: '123 Test Street', address2: '', city: 'Mumbai', province: 'Maharashtra', zip: '400001', phone: '+91 9876543210' },
    shipping_lines: [{ price: '49.00' }],
  };
  const demoMeta = { advance_paid: 200, payment_type: 'cod' };
  const demoRR = {
    request_id: 'RR-20240501-0001',
    type: 'exchange',
    order_name: '#TEST-001',
    customer_name: 'Test Customer',
    customer_email: to || 'test@example.com',
    vendor_name: 'Demo Vendor',
    reason: 'Wrong size received',
    items: [{ title: 'Demo Product', variant_title: 'Size: M', qty: 1, exchange_size_label: 'Size: L' }],
    created_at: new Date(Date.now() - 86400000).toISOString(),
  };
  return {
    vendor_welcome: { subject: `Welcome to the All-New CrosCrow Vendor Panel 🚀`, html: templateVendorWelcome({ vendorName: 'Demo Vendor', username: 'demovendor47', password: 'Croscrow@00' }) },
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
    order_on_hold:      { subject: `[TEST] Your Order ${demoOrder.name} is On Hold — Please Confirm`, html: templateOrderOnHoldCustomer({ order: demoOrder }) },
    rr_submitted:       { subject: `Return/Exchange Request Received — ${demoRR.request_id}`, html: templateRRSubmittedCustomer({ req: demoRR }) },
    rr_approved_admin:  { subject: `Return/Exchange Approved — ${demoRR.request_id}`, html: templateRRApprovedCustomer({ req: demoRR }) },
    rr_rejected:        { subject: `Return/Exchange Update — ${demoRR.request_id}`, html: templateRRRejectedCustomer({ req: demoRR }) },
    rr_pickup:          { subject: `Pickup Scheduled — ${demoRR.request_id}`, html: templateRRPickupCustomer({ req: demoRR }) },
    rr_in_transit:      { subject: `Return In Transit — ${demoRR.request_id}`, html: templateRRInTransitCustomer({ req: demoRR }) },
    rr_completed:       { subject: `Return/Exchange Complete — ${demoRR.request_id}`, html: templateRRCompletedCustomer({ req: demoRR }) },
    rr_admin_new:       { subject: `New Return/Exchange Request — ${demoRR.request_id}`, html: templateRRSubmittedAdmin({ req: demoRR }) },
    rr_vendor_new:      { subject: `New Return/Exchange for Your Order — ${demoRR.request_id}`, html: templateRRSubmittedVendor({ req: demoRR }) },
    rr_vendor_approved: { subject: `Return/Exchange Approved — Arrange Pickup — ${demoRR.request_id}`, html: templateRRApprovedVendor({ req: demoRR }) },
  };
}

app.get("/admin/email-settings/preview-template", adminAuth, async (req, res) => {
  const { template } = req.query;
  if (!template) return res.status(400).json({ error: "template required" });
  const TEMPLATES = buildDemoTemplates('preview@example.com');
  const tpl = TEMPLATES[template];
  if (!tpl) return res.status(400).json({ error: `Unknown template. Valid: ${Object.keys(TEMPLATES).join(', ')}` });
  res.json({ subject: tpl.subject, html: tpl.html });
});

app.post("/admin/email-settings/test-template", adminAuth, async (req, res) => {
  const { to, template } = req.body || {};
  if (!to || !template) return res.status(400).json({ error: "to and template required" });
  const cfg = await getSmtpConfig();
  if (!cfg?.host) return res.status(400).json({ error: "SMTP not configured yet" });

  const TEMPLATES = buildDemoTemplates(to);

  const tpl = TEMPLATES[template];
  if (!tpl) return res.status(400).json({ error: `Unknown template. Valid: ${Object.keys(TEMPLATES).join(', ')}` });

  try {
    const transporter = createTransporter(cfg);
    await transporter.sendMail({ from: `"${cfg.fromName || 'CrosCrow'}" <${cfg.fromEmail || cfg.user}>`, to, subject: tpl.subject, html: tpl.html });
    res.json({ ok: true, message: `Test "${template}" sent to ${to}` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── POST /admin/vendors/send-credentials ─────────────────────────────────
// Sends welcome email with credentials to all vendors that have email + username set
app.post("/admin/vendors/send-credentials", adminAuth, async (req, res) => {
  const cfg = await getSmtpConfig();
  if (!cfg?.host) return res.status(400).json({ error: "SMTP not configured." });
  try {
    const docs = await mdb.collection('vendor_profiles').find(
      { username: { $exists: true, $ne: '' }, email: { $exists: true, $ne: '' } },
      { projection: { vendor_name: 1, username: 1, email: 1, _id: 0 } }
    ).toArray();
    if (!docs.length) return res.status(400).json({ error: "No vendors with both email and credentials set." });

    const sent = [], failed = [];
    for (const doc of docs) {
      try {
        await sendEmail({
          to: doc.email,
          subject: `Welcome to the All-New CrosCrow Vendor Panel 🚀`,
          html: templateVendorWelcome({ vendorName: doc.vendor_name, username: doc.username, password: 'Croscrow@00' }),
          trigger: 'vendor_welcome',
        });
        sent.push(doc.vendor_name);
      } catch (e) {
        failed.push({ vendor: doc.vendor_name, error: e.message });
      }
    }
    auditLog("admin", "send_vendor_credentials", "all", { sent: sent.length, failed: failed.length });
    res.json({ success: true, sent, failed });
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

// ── GET/PUT /vendor/box-presets ───────────────────────────────────────────
app.get("/vendor/box-presets", vendorAuth, async (req, res) => {
  const p = await mdb.collection('vendor_profiles').findOne({ vendor_name: req.vendor }, { projection: { box_presets: 1, _id: 0 } });
  res.json({ presets: p?.box_presets || [] });
});

app.put("/vendor/box-presets", vendorAuth, async (req, res) => {
  const { presets } = req.body || {};
  if (!Array.isArray(presets)) return res.status(400).json({ error: "presets array required" });
  // Validate each preset
  const clean = presets.filter(p => p.name && p.length > 0 && p.breadth > 0 && p.height > 0).map(p => ({
    name:    String(p.name).slice(0, 40),
    length:  parseFloat(p.length)  || 1,
    breadth: parseFloat(p.breadth) || 1,
    height:  parseFloat(p.height)  || 1,
  }));
  await mdb.collection('vendor_profiles').updateOne(
    { vendor_name: req.vendor },
    { $set: { box_presets: clean, updated_at: new Date().toISOString() } },
    { upsert: true }
  );
  res.json({ success: true, presets: clean });
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
  const allowed = ["shiprocket", "delhivery", "shipmozo"];
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
          shipment_length: String(length),
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
    } else if (partner === "shipmozo") {
      // ShipMozo — base: https://shipping-api.com, auth via public-key + private-key headers
      const smPublicKey  = creds.public_key  || "";
      const smPrivateKey = creds.private_key || creds.api_key || "";
      if (!smPublicKey || !smPrivateKey) return res.status(400).json({ error: "ShipMozo public and private keys required. Go to Shipping Settings." });

      const smHeaders = { "Content-Type": "application/json", "public-key": smPublicKey, "private-key": smPrivateKey };
      const safeJson = async (fetchPromise) => {
        const r = await fetchPromise;
        const text = await r.text();
        try { return { ok: r.ok, status: r.status, data: JSON.parse(text) }; }
        catch { return { ok: false, status: r.status, data: null, raw: text.slice(0, 400) }; }
      };

      const custName = `${addr.first_name || ""} ${addr.last_name || ""}`.trim() || "Customer";
      // ShipMozo expects weight in grams
      const weightGrams = Math.round(parseFloat(weight) * 1000);

      const smPayload = {
        order_id:                   shopifyOrder.name,
        order_date:                 (shopifyOrder.created_at || "").slice(0, 10),
        consignee_name:             custName,
        consignee_phone:            (addr.phone || "").replace(/\D/g, "").slice(-10),
        consignee_email:            shopifyOrder.email || "",
        consignee_address_line_one: addr.address1 || "",
        consignee_address_line_two: addr.address2 || "",
        consignee_pin_code:         addr.zip      || "",
        consignee_city:             addr.city     || "",
        consignee_state:            addr.province || "",
        product_detail:             items.map(li => li.title).join(", ").slice(0, 250),
        payment_type:               cod ? "COD" : "PREPAID",
        cod_amount:                 cod ? String(codAmt) : "0",
        weight:                     String(weightGrams),
        length:                     String(length),
        width:                      String(breadth),
        height:                     String(height),
        ...(creds.warehouse_id ? { warehouse_id: creds.warehouse_id } : {}),
      };

      console.log(`[ShipMozo] POST /push-order for ${shopifyOrder.name} weight=${weightGrams}g`);
      const pushResult = await safeJson(fetch("https://shipping-api.com/api/v1/push-order", {
        method: "POST", headers: smHeaders, body: JSON.stringify(smPayload),
      }));

      if (!pushResult.data) {
        return res.status(500).json({ error: `ShipMozo returned non-JSON (HTTP ${pushResult.status}): ${pushResult.raw}` });
      }
      console.log(`[ShipMozo] push-order response:`, JSON.stringify(pushResult.data).slice(0, 300));

      const smOrderId = pushResult.data?.order_id || pushResult.data?.data?.order_id;
      if (!smOrderId && !pushResult.ok) {
        return res.status(400).json({ error: pushResult.data?.message || JSON.stringify(pushResult.data) });
      }

      // Auto-assign courier to generate AWB
      const assignResult = await safeJson(fetch("https://shipping-api.com/api/v1/auto-assign-order", {
        method: "POST", headers: smHeaders, body: JSON.stringify({ order_id: smOrderId }),
      }));
      console.log(`[ShipMozo] auto-assign response:`, JSON.stringify(assignResult.data).slice(0, 300));

      const awbNum = assignResult.data?.awb_number || assignResult.data?.data?.awb_number
        || pushResult.data?.awb_number || pushResult.data?.data?.awb_number;

      if (awbNum) {
        result = { success: true, awb: awbNum };
      } else {
        const smMsg = assignResult.data?.message || pushResult.data?.message || "";
        return res.status(400).json({ error: `ShipMozo order pushed (ID: ${smOrderId}) but AWB not yet assigned. ${smMsg}. Check ShipMozo panel.` });
      }
    }

    // Save AWB to this vendor's order_vendor_stage only — never to order_meta.awb
    if (result?.awb) {
      const sid = String(shopifyOrder.id);
      await OVS.upsert(sid, req.vendor, { awb: result.awb, courier: partner, stage: 'ready', updated_at: new Date().toISOString() });

      // Also create a Shopify partial fulfillment for this vendor's line items
      try {
        const shopifyToken = await getAccessToken();
        const vendorLineItemIds = new Set(items.map(li => li.id));

        // Fetch open fulfillment orders and match this vendor's items
        const foRes = await fetch(
          `https://${SHOP}.myshopify.com/admin/api/2025-01/orders/${sid}/fulfillment_orders.json`,
          { headers: { 'X-Shopify-Access-Token': shopifyToken } }
        );
        const foData = await foRes.json();
        const openFOs = (foData.fulfillment_orders || []).filter(fo => ['open', 'in_progress'].includes(fo.status));

        const line_items_by_fulfillment_order = [];
        for (const fo of openFOs) {
          const matching = (fo.line_items || []).filter(foli => vendorLineItemIds.has(foli.line_item_id));
          if (matching.length) {
            line_items_by_fulfillment_order.push({
              fulfillment_order_id: fo.id,
              fulfillment_order_line_items: matching.map(foli => ({ id: foli.id, quantity: foli.quantity })),
            });
          }
        }

        if (line_items_by_fulfillment_order.length) {
          const courierName = partner === 'shiprocket' ? 'Shiprocket' : partner === 'shipmozo' ? 'ShipMozo' : 'Delhivery';
          const trackUrl = partner === 'delhivery'
            ? `https://www.delhivery.com/track/package/${result.awb}`
            : partner === 'shipmozo'
            ? `https://panel.shipmozo.com/track-order?awb=${result.awb}`
            : `https://shiprocket.co/tracking/${result.awb}`;
          await fetch(`https://${SHOP}.myshopify.com/admin/api/2025-01/fulfillments.json`, {
            method: 'POST',
            headers: { 'X-Shopify-Access-Token': shopifyToken, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              fulfillment: {
                line_items_by_fulfillment_order,
                tracking_info: { number: result.awb, url: trackUrl, company: courierName },
                notify_customer: false,
              },
            }),
          });
          result.shopifyFulfilled = true;
        }
      } catch (e) {
        console.error('⚠️  Shopify fulfillment after create-shipment failed:', e.message);
        result.shopifyFulfillError = e.message;
      }
    }

    res.json(result);
  } catch (err) {
    console.error("❌ /create-shipment:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Admin Global Shipping Credentials ────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════
// PRODUCT COMMISSION RULES
// ══════════════════════════════════════════════════════════════════════════

app.get("/admin/commission-rules", adminAuth, async (req, res) => {
  const { vendor } = req.query;
  const q = vendor ? { vendor_name: vendor } : {};
  const rules = await mdb.collection('product_commission_rules').find(q, { projection: { _id: 0 } }).sort({ vendor_name: 1, title: 1 }).toArray();
  res.json({ rules });
});

app.post("/admin/commission-rules", adminAuth, async (req, res) => {
  try {
    const { vendor_name, product_id, sku, title, image, mode, flat_amount, flat_gst_inclusive, vendor_cost, margin_pct, margin_gst_inclusive } = req.body || {};
    if (!vendor_name) return res.status(400).json({ error: "vendor_name required" });
    if (!['flat','margin','mixed'].includes(mode)) return res.status(400).json({ error: "mode must be flat, margin, or mixed" });
    const id = await nextId('product_commission_rules');
    const rule = {
      id, vendor_name, product_id: product_id ? String(product_id) : null,
      sku: sku || null, title: title || '', image: image || null,
      mode, flat_amount: parseFloat(flat_amount || 0),
      flat_gst_inclusive: !!flat_gst_inclusive,
      vendor_cost: parseFloat(vendor_cost || 0),
      margin_pct: parseFloat(margin_pct || 0),
      margin_gst_inclusive: !!margin_gst_inclusive,
      created_at: new Date().toISOString(),
    };
    await mdb.collection('product_commission_rules').insertOne(rule);
    auditLog("admin", "commission_rule_created", String(id), { vendor_name, title, mode });
    res.json({ ok: true, rule });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put("/admin/commission-rules/:id", adminAuth, async (req, res) => {
  try {
    const { mode, flat_amount, flat_gst_inclusive, vendor_cost, margin_pct, margin_gst_inclusive, title, sku, product_id, image } = req.body || {};
    if (mode && !['flat','margin','mixed'].includes(mode)) return res.status(400).json({ error: "Invalid mode" });
    const upd = {};
    if (mode !== undefined)                upd.mode = mode;
    if (title !== undefined)               upd.title = title;
    if (sku !== undefined)                 upd.sku = sku;
    if (product_id !== undefined)          upd.product_id = product_id ? String(product_id) : null;
    if (image !== undefined)               upd.image = image || null;
    if (flat_amount !== undefined)         upd.flat_amount = parseFloat(flat_amount);
    if (flat_gst_inclusive !== undefined)  upd.flat_gst_inclusive = !!flat_gst_inclusive;
    if (vendor_cost !== undefined)         upd.vendor_cost = parseFloat(vendor_cost);
    if (margin_pct !== undefined)          upd.margin_pct = parseFloat(margin_pct);
    if (margin_gst_inclusive !== undefined) upd.margin_gst_inclusive = !!margin_gst_inclusive;
    upd.updated_at = new Date().toISOString();
    await mdb.collection('product_commission_rules').updateOne({ id: parseInt(req.params.id) }, { $set: upd });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete("/admin/commission-rules/:id", adminAuth, async (req, res) => {
  await mdb.collection('product_commission_rules').deleteOne({ id: parseInt(req.params.id) });
  res.json({ ok: true });
});

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

// Manage saved pickup locations for a partner (admin)
app.get("/admin/shipping-creds/:partner/locations", adminAuth, async (req, res) => {
  try {
    const row = await mdb.collection('global_shipping_creds').findOne({ partner: req.params.partner });
    if (!row) return res.status(404).json({ error: 'Partner not connected' });
    const creds = JSON.parse(row.credentials || '{}');
    res.json({ locations: creds.pickup_locations || [] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put("/admin/shipping-creds/:partner/locations", adminAuth, async (req, res) => {
  const { locations } = req.body || {};
  if (!Array.isArray(locations)) return res.status(400).json({ error: 'locations array required' });
  try {
    const row = await mdb.collection('global_shipping_creds').findOne({ partner: req.params.partner });
    if (!row) return res.status(404).json({ error: 'Partner not connected' });
    const creds = JSON.parse(row.credentials || '{}');
    creds.pickup_locations = locations;
    await mdb.collection('global_shipping_creds').updateOne({ partner: req.params.partner }, { $set: { credentials: JSON.stringify(creds) } });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/vendor/shipping/partners/:partner/locations", vendorAuth, async (req, res) => {
  try {
    const row = await mdb.collection('vendor_shipping_partners').findOne({ vendor_name: req.vendor, partner: req.params.partner, active: 1 });
    if (!row) return res.status(404).json({ error: 'Partner not connected' });
    const creds = JSON.parse(row.credentials || '{}');
    res.json({ locations: creds.pickup_locations || [] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put("/vendor/shipping/partners/:partner/locations", vendorAuth, async (req, res) => {
  const { locations } = req.body || {};
  if (!Array.isArray(locations)) return res.status(400).json({ error: 'locations array required' });
  try {
    const row = await mdb.collection('vendor_shipping_partners').findOne({ vendor_name: req.vendor, partner: req.params.partner, active: 1 });
    if (!row) return res.status(404).json({ error: 'Partner not connected' });
    const creds = JSON.parse(row.credentials || '{}');
    creds.pickup_locations = locations;
    await mdb.collection('vendor_shipping_partners').updateOne({ vendor_name: req.vendor, partner: req.params.partner }, { $set: { credentials: JSON.stringify(creds) } });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Debug endpoint — shows every step of tracking for an AWB
app.get("/admin/debug-delhivery-warehouses", adminAuth, async (req, res) => {
  try {
    const credRow = await mdb.collection('global_shipping_creds').findOne({ partner: 'delhivery' });
    if (!credRow) return res.json({ error: 'Delhivery not connected' });
    const creds = JSON.parse(credRow.credentials);
    const token = creds.api_token;
    // Try both endpoints
    const r1 = await fetch('https://track.delhivery.com/api/backend/clientwarehouse/list/?format=json', {
      headers: { 'Authorization': `Token ${token}` },
    });
    const text1 = await r1.text();
    let parsed1; try { parsed1 = JSON.parse(text1); } catch { parsed1 = text1.slice(0,500); }

    const r2 = await fetch('https://track.delhivery.com/api/cmu/pickup.json?format=json', {
      headers: { 'Authorization': `Token ${token}` },
    });
    const text2 = await r2.text();
    let parsed2; try { parsed2 = JSON.parse(text2); } catch { parsed2 = text2.slice(0,500); }

    res.json({
      list_endpoint: { status: r1.status, body: parsed1 },
      pickup_endpoint: { status: r2.status, body: parsed2 },
      token_prefix: token?.slice(0,8) + '...',
    });
  } catch(err) { res.json({ error: err.message }); }
});

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
    // Get AWB from vendor stage (most reliable) or order_meta or Shopify fulfillments
    let awb = '', courier = '';
    const vendorStage = await mdb.collection('order_vendor_stage').findOne(
      { shopify_id: shopifyId, awb: { $exists: true, $ne: '' } },
      { projection: { awb: 1, courier: 1, _id: 0 } }
    );
    if (vendorStage?.awb) { awb = vendorStage.awb; courier = vendorStage.courier || ''; }

    if (!awb) {
      const meta = await mdb.collection('order_meta').findOne({ shopify_id: shopifyId }, { projection: { awb: 1, courier: 1, delivery_status: 1, _id: 0 } }) || {};
      awb = meta.awb || '';
      courier = (meta.courier || '').toLowerCase();
    }
    if (!awb) {
      const { data } = await shopifyRESTRaw(`/orders/${shopifyId}.json?fields=fulfillments`);
      const f = (data.order?.fulfillments || []).find(f => f.tracking_number);
      if (f) { awb = f.tracking_number; courier = (f.tracking_company || '').toLowerCase(); }
    }
    if (!awb) return res.json({ status: '', awb: '' });

    // Use ShipSagar if configured — tracks any courier
    const ssCreds = await getShipSagarCreds();
    if (ssCreds?.api_key) {
      const ss = await shipsagarTrackShipment(awb);
      const cached = await mdb.collection('order_meta').findOne({ shopify_id: shopifyId }, { projection: { delivery_status: 1, _id: 0 } });
      const cachedStatus = cached?.delivery_status || '';

      if (ss?.found && ss.history?.length) {
        // Has tracking events — use latest
        const latest = ss.history[ss.history.length - 1];
        const status = latest.ActionDescription || '';
        const newStage = shipsagarStatusToStage(status);
        if (newStage) {
          if (vendorStage) await OVS.upsert(shopifyId, vendorStage.vendor_name || '', { stage: newStage, updated_at: new Date().toISOString() });
          await OM.upsert(shopifyId, { delivery_status: status, delivery_status_updated_at: new Date().toISOString() });
        }
        applyShipSagarTag(shopifyId, status).catch(() => {});
        return res.json({ status, awb, courier: ss.detail?.CourierCode || courier, source: 'shipsagar', history: ss.history.slice(-5), tag: shipsagarDescToTag(status) });
      }

      if (ss?.found && !ss.history?.length) {
        // Registered in ShipSagar but no events yet — show cached, no push needed
        return res.json({ status: cachedStatus, awb, source: 'shipsagar', message: 'Shipment tracked — no events yet. Check back soon.' });
      }

      // AWB not in ShipSagar at all — register it and return cached
      shipsagarPushShipment({ awb, courierCode: courier, orderNo: shopifyId }).catch(() => {});
      return res.json({ status: cachedStatus, awb, message: 'AWB registered with ShipSagar — refresh in a moment to see live tracking.' });
    }

    // Fallback: old direct-courier fetch
    const detectPartner = c => {
      if (c.includes('delhivery')) return 'delhivery';
      if (c.includes('shiprocket')) return 'shiprocket';
      if (c.includes('shipmozo')) return 'shipmozo';
      return c;
    };
    const partner = detectPartner(courier);
    const credRow = await mdb.collection('global_shipping_creds').findOne({ partner }, { projection: { credentials: 1, _id: 0 } });
    if (!credRow) { const m = await mdb.collection('order_meta').findOne({ shopify_id: shopifyId }, { projection: { delivery_status: 1, _id: 0 } }); return res.json({ status: m?.delivery_status || '', awb, message: 'ShipSagar not configured' }); }
    const creds = JSON.parse(credRow.credentials);
    const status = await fetchDeliveryStatus(partner, creds, awb);
    if (status) await OM.upsert(shopifyId, { awb, courier, delivery_status: status, delivery_status_updated_at: new Date().toISOString() });
    res.json({ status, awb });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin bulk sync delivery status for all orders with AWB
// ── POST /admin/orders/sync-fulfillment ──────────────────────────────────
// Write Shopify fulfillment stages back to order_vendor_stage for all orders
app.post("/admin/orders/sync-fulfillment", adminAuth, async (req, res) => {
  try {
    const allOrders = await fetchAllOrders("any", "2020-01-01T00:00:00Z");
    let updated = 0;
    const now = new Date().toISOString();
    for (const o of allOrders) {
      if (!(o.fulfillments || []).length) continue;
      const derived = vendorStagesFromFulfillments(o.fulfillments, o.line_items);
      if (!Object.keys(derived).length) continue;
      const sid = String(o.id);
      for (const [vendor, shopifyStage] of Object.entries(derived)) {
        const existing = await mdb.collection('order_vendor_stage').findOne({ shopify_id: sid, vendor_name: vendor }, { projection: { stage: 1, _id: 0 } });
        const currentStage = existing?.stage || 'new';
        const betterStage  = higherStage(currentStage, shopifyStage);
        if (betterStage !== currentStage) {
          await OVS.upsert(sid, vendor, { stage: betterStage, updated_at: now });
          updated++;
        }
      }
    }
    auditLog("admin", "sync_fulfillment_stages", "all", { updated });
    res.json({ success: true, updated });
  } catch (err) {
    console.error("❌ /admin/orders/sync-fulfillment:", err.message);
    res.status(500).json({ error: err.message });
  }
});

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
  if (partner === "shipmozo") {
    const smPublic  = creds.public_key  || "";
    const smPrivate = creds.private_key || creds.api_key || "";
    if (!smPublic || !smPrivate) return "";
    try {
      const r = await fetch(`https://shipping-api.com/api/v1/track-order?awb_number=${awb}`, {
        headers: { "public-key": smPublic, "private-key": smPrivate },
      });
      const track = await r.json();
      return track?.data?.current_status || track?.data?.status || track?.status || "";
    } catch { return ""; }
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
    const shopifyId = req.params.shopifyId;
    // Get AWB from vendor stage for this vendor first
    const vs = await mdb.collection('order_vendor_stage').findOne(
      { shopify_id: shopifyId, vendor_name: req.vendor, awb: { $exists: true, $ne: '' } },
      { projection: { awb: 1, courier: 1, _id: 0 } }
    );
    const meta = await mdb.collection('order_meta').findOne({ shopify_id: shopifyId }, { projection: { awb: 1, courier: 1, delivery_status: 1, _id: 0 } }) || {};
    const awb = vs?.awb || meta.awb || '';
    const courier = vs?.courier || meta.courier || '';
    if (!awb) return res.json({ status: '', awb: '' });

    // Use ShipSagar if configured
    const ssCreds = await getShipSagarCreds();
    if (ssCreds?.api_key) {
      const ss = await shipsagarTrackShipment(awb);
      const cachedStatus = meta?.delivery_status || '';

      if (ss?.found && ss.history?.length) {
        const latest = ss.history[ss.history.length - 1];
        const status = latest.ActionDescription || '';
        const newStage = shipsagarStatusToStage(status);
        if (newStage) {
          await OVS.upsert(shopifyId, req.vendor, { stage: newStage, updated_at: new Date().toISOString() });
          await OM.upsert(shopifyId, { delivery_status: status, delivery_status_updated_at: new Date().toISOString() });
        }
        applyShipSagarTag(shopifyId, status).catch(() => {});
        return res.json({ status, awb, courier: ss.detail?.CourierCode || courier, source: 'shipsagar', history: ss.history.slice(-5), tag: shipsagarDescToTag(status) });
      }

      if (ss?.found && !ss.history?.length) {
        return res.json({ status: cachedStatus, awb, source: 'shipsagar', message: 'Shipment tracked — no events yet. Check back soon.' });
      }

      shipsagarPushShipment({ awb, courierCode: courier, orderNo: shopifyId }).catch(() => {});
      return res.json({ status: cachedStatus, awb, message: 'AWB registered with ShipSagar — refresh in a moment to see live tracking.' });
    }

    // Fallback: vendor's own shipping partner creds
    const partner = courier.toLowerCase();
    const partnerRow = await mdb.collection('vendor_shipping_partners').findOne({ vendor_name: req.vendor, partner, active: 1 }, { projection: { credentials: 1, _id: 0 } });
    let status = meta.delivery_status || '';
    if (partnerRow) {
      try {
        const creds = JSON.parse(partnerRow.credentials);
        status = await fetchDeliveryStatus(partner, creds, awb);
        if (status) await OM.upsert(shopifyId, { delivery_status: status, delivery_status_updated_at: new Date().toISOString() });
      } catch {}
    }
    res.json({ status, awb });
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
// GET /admin/products?vendor=NAME — fetch Shopify products filtered by vendor name
app.get("/admin/products", adminAuth, async (req, res) => {
  try {
    const { vendor } = req.query;
    const url = vendor
      ? `/products.json?limit=250&fields=id,title,variants,image&vendor=${encodeURIComponent(vendor)}`
      : `/products.json?limit=250&fields=id,title,variants,image`;
    const data = await shopifyREST(url);
    const products = (data.products || []).map(p => ({
      id: String(p.id),
      title: p.title,
      image: p.image?.src || null,
      variants: (p.variants || []).map(v => ({ id: String(v.id), sku: v.sku, title: v.title, price: parseFloat(v.price||0) })),
      price: parseFloat(p.variants?.[0]?.price || 0),
    }));
    res.json({ products });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

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

app.delete("/admin/penalties/:id", adminAuth, async (req, res) => {
  const p = await OP.get(req.params.id);
  if (!p) return res.status(404).json({ error: "Penalty not found." });
  await mdb.collection('order_penalties').deleteOne({ id: parseInt(req.params.id) });
  auditLog("admin", "penalty_deleted", req.params.id, { vendor: p.vendor_name, order: p.order_name, was: p.status });
  res.json({ ok: true });

  // Email vendor that penalty has been waived
  (async () => {
    try {
      const cfg = await getSmtpConfig();
      const vcfg = await VC.get(p.vendor_name);
      if (!cfg?.host || !vcfg?.email) return;
      await sendEmail({
        to: vcfg.email,
        subject: `✅ Penalty Waived — ${p.order_name}`,
        html: emailBase(
          'Penalty Waived',
          '#10b981',
          `<div class="subtitle">Good news! The penalty raised for order <strong>${p.order_name}</strong> has been waived off by CrosCrow. No amount will be deducted from your settlement.</div>
           <table style="width:100%;border-collapse:collapse;margin:16px 0;font-size:13px;">
             <tr><td style="padding:8px;color:#94a3b8;width:130px">Order</td><td style="padding:8px;color:#e2e8f0;font-weight:600">${p.order_name}</td></tr>
             <tr style="background:#0f1f2e"><td style="padding:8px;color:#94a3b8">Original Reason</td><td style="padding:8px;color:#f59e0b">${p.trigger_reason==='48hr_breach'?'48hr fulfilment breach':p.trigger_reason==='eta_breach'?'ETA date missed':p.trigger_reason}</td></tr>
             ${p.penalty_amount>0?`<tr><td style="padding:8px;color:#94a3b8">Amount Waived</td><td style="padding:8px;color:#10b981;font-weight:700">₹${(p.penalty_amount||0).toFixed(2)}</td></tr>`:''}
           </table>
           <div style="text-align:center;color:#64748b;font-size:12px;margin-top:16px">This penalty will not appear in your settlement invoice.</div>`,
        ),
        shopifyId: p.shopify_id, trigger: 'penalty_waived',
      });
    } catch(e) { console.error('penalty waived email error:', e.message); }
  })();
});

app.get("/admin/penalties", adminAuth, async (req, res) => {
  const { status } = req.query;
  res.json({ penalties: await OP.all(status) });
});

// Vendor: get penalties for a specific order (their vendor only)
app.get("/vendor/orders/:shopifyId/penalties", vendorAuth, async (req, res) => {
  const penalties = await mdb.collection('order_penalties').find(
    { shopify_id: String(req.params.shopifyId), vendor_name: req.vendor },
    { projection: { _id: 0 } }
  ).sort({ triggered_at: -1 }).toArray();
  res.json({ penalties });
});

// Vendor: submit review request on a confirmed penalty
app.post("/vendor/penalties/:id/review-request", vendorAuth, async (req, res) => {
  const { message } = req.body || {};
  if (!message?.trim()) return res.status(400).json({ error: "Message required." });
  const p = await OP.get(req.params.id);
  if (!p) return res.status(404).json({ error: "Penalty not found." });
  if (p.vendor_name !== req.vendor) return res.status(403).json({ error: "Forbidden." });
  await mdb.collection('order_penalties').updateOne(
    { id: parseInt(req.params.id) },
    { $set: { vendor_review_request: message.trim(), vendor_review_at: new Date().toISOString() } }
  );
  auditLog("vendor", "penalty_review_request", req.params.id, { vendor: req.vendor, message: message.trim() });

  // Email admin
  (async () => {
    try {
      const cfg = await getSmtpConfig();
      if (!cfg?.adminEmail) return;
      await sendEmail({
        to: cfg.adminEmail,
        subject: `📨 Penalty Review Request — ${p.order_name} (${req.vendor})`,
        html: emailBase(
          `Penalty Review Request`,
          '#6366f1',
          `<div class="subtitle">Vendor <strong>${req.vendor}</strong> has requested a review for the penalty on order <strong>${p.order_name}</strong>.</div>
           <table style="width:100%;border-collapse:collapse;margin:16px 0;font-size:13px;">
             <tr><td style="padding:8px;color:#94a3b8;width:130px">Order</td><td style="padding:8px;color:#e2e8f0;font-weight:600">${p.order_name}</td></tr>
             <tr style="background:#0f1f2e"><td style="padding:8px;color:#94a3b8">Penalty Amount</td><td style="padding:8px;color:#ef4444;font-weight:700">₹${(p.penalty_amount||0).toFixed(2)}</td></tr>
             <tr><td style="padding:8px;color:#94a3b8">Reason</td><td style="padding:8px;color:#f59e0b">${p.trigger_reason==='48hr_breach'?'48hr fulfilment breach':p.trigger_reason==='eta_breach'?'ETA date missed':p.trigger_reason}</td></tr>
             <tr style="background:#0f1f2e"><td style="padding:8px;color:#94a3b8;vertical-align:top">Vendor Message</td><td style="padding:8px;color:#e2e8f0;line-height:1.6">${message.trim()}</td></tr>
           </table>
           <div style="text-align:center;margin-top:20px">
             <a href="${process.env.ADMIN_URL||'#'}/admin#penalties" style="background:#6366f1;color:#fff;padding:10px 24px;border-radius:8px;text-decoration:none;font-weight:700;font-size:13px">Review in Admin Panel →</a>
           </div>`,
        ),
        shopifyId: p.shopify_id, trigger: 'penalty_review_request',
      });
    } catch(e) { console.error('penalty review email error:', e.message); }
  })();

  res.json({ success: true });
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

// ══════════════════════════════════════════════════════════════════════════
// GOOGLE CONTACTS INTEGRATION
// ══════════════════════════════════════════════════════════════════════════

const GOOGLE_CLIENT_ID     = process.env.GOOGLE_CLIENT_ID     || "";
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";
const GOOGLE_REDIRECT_URI  = `${process.env.SERVER_URL || 'http://localhost:3001'}/admin/google/callback`;

function getGoogleOAuth2Client() {
  return new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI);
}

async function getGoogleTokens() {
  return await mdb.collection('app_settings').findOne({ key: 'google_tokens' }, { projection: { value: 1, _id: 0 } }).then(r => r?.value || null);
}

async function saveGoogleTokens(tokens) {
  await mdb.collection('app_settings').updateOne(
    { key: 'google_tokens' },
    { $set: { key: 'google_tokens', value: tokens, updated_at: new Date().toISOString() } },
    { upsert: true }
  );
}

async function getAuthedPeopleClient() {
  const tokens = await getGoogleTokens();
  if (!tokens) throw new Error("Google Contacts not connected. Go to Admin Settings → Integrations to connect.");
  const auth = getGoogleOAuth2Client();
  auth.setCredentials(tokens);
  // Auto-refresh if expired
  auth.on('tokens', async (newTokens) => {
    const merged = { ...tokens, ...newTokens };
    await saveGoogleTokens(merged);
  });
  return google.people({ version: 'v1', auth });
}

async function upsertGoogleContact({ name, phone, orderName }) {
  const people = await getAuthedPeopleClient();
  const contactName = `${name} — ${orderName}`;
  const phoneClean  = (phone || "").replace(/\D/g, "");

  // Search for existing contact by phone
  let existingResourceName = null;
  try {
    const search = await people.people.searchContacts({
      query: phoneClean,
      readMask: 'names,phoneNumbers,biographies',
      pageSize: 5,
    });
    const results = search.data?.results || [];
    for (const r of results) {
      const phones = r.person?.phoneNumbers || [];
      if (phones.some(p => (p.value || "").replace(/\D/g, "").endsWith(phoneClean.slice(-10)))) {
        existingResourceName = r.person.resourceName;
        break;
      }
    }
  } catch {}

  if (existingResourceName) {
    // Update: append order number to name if not already there
    try {
      const existing = await people.people.get({ resourceName: existingResourceName, personFields: 'names,phoneNumbers,biographies,metadata' });
      const currentName = existing.data?.names?.[0]?.displayName || "";
      // Append new order to name if not already present
      const newDisplayName = currentName.includes(orderName) ? currentName : `${currentName}, ${orderName}`;
      await people.people.updateContact({
        resourceName: existingResourceName,
        updatePersonFields: 'names',
        requestBody: {
          etag: existing.data.etag,
          names: [{ givenName: newDisplayName }],
        },
      });
      console.log(`📒 Google Contacts: updated ${existingResourceName} → ${newDisplayName}`);
    } catch (e) {
      console.error('Google Contacts update error:', e.message);
    }
  } else {
    // Create new contact
    await people.people.createContact({
      requestBody: {
        names: [{ givenName: contactName }],
        phoneNumbers: [{ value: phone, type: 'mobile' }],
        memberships: [{ contactGroupMembership: { contactGroupId: 'myContacts' } }],
      },
    });
    console.log(`📒 Google Contacts: created "${contactName}" (${phone})`);
  }
}

// GET /admin/google/auth — redirect to Google OAuth consent
app.get("/admin/google/auth", (req, res) => {
  // Allow token via query param (browser popup can't set Authorization header)
  const token = (req.query.token || (req.headers.authorization || "").replace("Bearer ", "")).trim();
  if (!token || !adminSessions.has(token)) return res.status(401).send("Unauthorized");
  const s = adminSessions.get(token);
  if (Date.now() > s.expiresAt) { adminSessions.delete(token); return res.status(401).send("Session expired"); }
  if (!GOOGLE_CLIENT_ID) return res.status(400).json({ error: "Google credentials not configured in .env" });
  const auth = getGoogleOAuth2Client();
  const url  = auth.generateAuthUrl({
    access_type: 'offline',
    prompt:      'consent',
    scope:       ['https://www.googleapis.com/auth/contacts'],
  });
  res.redirect(url);
});

// GET /admin/google/callback — OAuth callback, save tokens
app.get("/admin/google/callback", async (req, res) => {
  const { code, error } = req.query;
  if (error) return res.send(`<script>window.opener?.postMessage({type:'google_auth',error:'${error}'},'*');window.close();</script>`);
  try {
    const auth = getGoogleOAuth2Client();
    const { tokens } = await auth.getToken(code);
    await saveGoogleTokens(tokens);
    console.log("✅ Google Contacts connected");
    res.send(`<script>window.opener?.postMessage({type:'google_auth',success:true},'*');window.close();</script>`);
  } catch (e) {
    res.send(`<script>window.opener?.postMessage({type:'google_auth',error:'${e.message}'},'*');window.close();</script>`);
  }
});

// GET /admin/google/status — check if connected
app.get("/admin/google/status", adminAuth, async (req, res) => {
  const tokens = await getGoogleTokens();
  res.json({ connected: !!tokens });
});

// DELETE /admin/google/disconnect
app.delete("/admin/google/disconnect", adminAuth, async (req, res) => {
  await mdb.collection('app_settings').deleteOne({ key: 'google_tokens' });
  res.json({ ok: true });
});

// POST /admin/google/sync — manual bulk sync all customers to Google Contacts
app.post("/admin/google/sync", adminAuth, async (req, res) => {
  try {
    const orders = await fetchAllOrders("any", "2020-01-01T00:00:00Z");
    let synced = 0, errors = 0;
    for (const o of orders) {
      const phone = o.shipping_address?.phone || o.billing_address?.phone || o.phone || "";
      const name  = o.shipping_address ? `${o.shipping_address.first_name || ""} ${o.shipping_address.last_name || ""}`.trim() : (o.customer?.first_name || "Customer");
      if (!phone) continue;
      try {
        await upsertGoogleContact({ name, phone, orderName: o.name });
        synced++;
      } catch (e) { errors++; console.error(`Google sync error for ${o.name}:`, e.message); }
    }
    res.json({ ok: true, synced, errors });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
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
      const fulfilledStages = ['ready','pickup','transit','delivered','rto','cancelled'];
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
//  AUTO-HOLD: orders stuck in "new" for 7 days → move to hold + tag Shopify
// ══════════════════════════════════════════════════════════════════════════
const AUTO_HOLD_DAYS = 7;
const AUTO_HOLD_TAG  = 'on hold';

function templateOrderOnHoldCustomer({ order }) {
  const waNum  = (process.env.WHATSAPP_NUMBER || '').replace(/\D/g, '');
  const waLink = waNum ? `https://wa.me/${waNum}?text=${encodeURIComponent('Hi! I want to confirm my order ' + order.name + ' placed on CrosCrow. Please proceed.')}` : '#';
  const items  = order.line_items || [];
  const total  = parseFloat(order.total_price || 0);
  const shipping = parseFloat(order.shipping_lines?.[0]?.price || 0);
  const subtotal = items.reduce((s, li) => s + parseFloat(li.price || 0) * li.quantity, 0);
  const addr   = order.shipping_address;
  const IMG    = 'https://i.ibb.co/YFCVGFxR/Concrete-is-a-construct-So-are-the-rules-The-jungle-isn-t-wild-it-s-designed.jpg';
  const LOGO   = 'https://i.ibb.co/DHx0VCZb/Untitled-design-1.jpg';
  const firstName = addr?.first_name || order.email?.split('@')[0] || 'there';
  const firstItem = items[0];
  const heroImg = firstItem?.image_url || firstItem?.image?.src || (firstItem?.properties?.find(p => p.name === '_image')?.value) || '';

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0d0d0d;font-family:Arial,sans-serif;">
<div style="max-width:620px;margin:0 auto;">

  <!-- HERO IMAGE -->
  <div style="position:relative;line-height:0;">
    <img src="${IMG}" width="620" alt="CrosCrow" style="width:100%;max-width:620px;display:block;object-fit:cover;max-height:340px;">
    <div style="position:absolute;bottom:0;left:0;right:0;padding:28px 32px;background:linear-gradient(to top,rgba(0,0,0,0.92) 0%,rgba(0,0,0,0.4) 70%,transparent 100%);">
      <div style="font-size:9px;font-weight:700;letter-spacing:4px;color:rgba(255,255,255,0.45);text-transform:uppercase;margin-bottom:8px;">ORDER UPDATE &nbsp;|&nbsp; ACTION REQUIRED</div>
      <div style="font-size:28px;font-weight:900;color:#f59e0b;letter-spacing:3px;text-transform:uppercase;line-height:1.1;">ORDER<br>ON HOLD.</div>
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
        <div style="font-size:20px;font-weight:900;color:#f59e0b;letter-spacing:1px;">&#8377;${total.toFixed(2)}</div>
      </td>
    </tr>
  </table>

  <!-- BODY -->
  <div style="background:#161616;padding:32px;">

    <!-- Greeting -->
    <div style="margin-bottom:24px;">
      <div style="font-size:17px;font-weight:700;color:#f0f0f0;margin-bottom:6px;">Hey ${firstName} —</div>
      <div style="font-size:13px;color:#888;line-height:1.8;">Your order has been placed on hold because we haven't received your confirmation yet. Please confirm on WhatsApp so we can get it processed right away.</div>
    </div>

    <!-- WhatsApp confirm banner -->
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#1c1208;border:2px solid #f59e0b;border-radius:8px;margin-bottom:28px;">
      <tr><td style="padding:22px 24px;text-align:center;">
        <div style="font-size:9px;font-weight:700;letter-spacing:4px;color:#f59e0b;text-transform:uppercase;margin-bottom:8px;">⚠️ Confirmation Required</div>
        <div style="font-size:13px;color:#aaa;line-height:1.7;margin-bottom:18px;">Tap the button below to confirm your order on WhatsApp. Takes less than 10 seconds.</div>
        <a href="${waLink}" style="display:inline-block;background:#25d366;color:#fff;text-decoration:none;font-weight:800;font-size:12px;letter-spacing:3px;text-transform:uppercase;padding:14px 32px;border-radius:4px;">Confirm on WhatsApp</a>
        <div style="font-size:10px;color:#555;margin-top:12px;">If your order is not confirmed, it may be cancelled.</div>
      </td></tr>
    </table>

    ${heroImg ? `
    <!-- Big Product Photo -->
    <div style="margin-bottom:24px;text-align:center;">
      <img src="${heroImg}" alt="${firstItem?.title || ''}" style="max-width:100%;width:320px;border-radius:10px;display:inline-block;object-fit:cover;">
    </div>` : ''}

    <!-- Items label -->
    <div style="font-size:9px;font-weight:700;letter-spacing:4px;color:#444;text-transform:uppercase;margin-bottom:14px;">Your Items</div>

    <!-- Items list -->
    ${items.map(li => {
      const img = li.image?.src || (li.properties?.find(p => p.name === '_image')?.value) || '';
      return `
    <table width="100%" cellpadding="0" cellspacing="0" style="border-bottom:1px solid #1e1e1e;">
      <tr>
        ${img ? `<td style="padding:14px 14px 14px 0;width:64px;vertical-align:top;">
          <img src="${img}" width="60" height="60" alt="" style="border-radius:6px;object-fit:cover;display:block;background:#222;">
        </td>` : `<td style="padding:14px 14px 14px 0;width:64px;vertical-align:top;">
          <div style="width:60px;height:60px;background:#1e1e1e;border-radius:6px;"></div>
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

    <!-- Payment summary -->
    <table width="100%" cellpadding="0" cellspacing="0" style="margin:20px 0;background:#0f0f0f;border-radius:6px;overflow:hidden;">
      <tr>
        <td style="padding:12px 20px;font-size:11px;color:#555;">Subtotal</td>
        <td style="padding:12px 20px;text-align:right;font-size:11px;color:#888;">&#8377;${subtotal.toFixed(2)}</td>
      </tr>
      ${shipping > 0 ? `<tr>
        <td style="padding:8px 20px;font-size:11px;color:#555;border-top:1px solid #1a1a1a;">Shipping</td>
        <td style="padding:8px 20px;text-align:right;font-size:11px;color:#888;border-top:1px solid #1a1a1a;">&#8377;${shipping.toFixed(2)}</td>
      </tr>` : ''}
      <tr style="background:#1a1a1a;">
        <td style="padding:14px 20px;font-size:10px;font-weight:700;letter-spacing:3px;color:#555;text-transform:uppercase;">Cash on Delivery</td>
        <td style="padding:14px 20px;text-align:right;font-size:20px;font-weight:900;color:#f59e0b;">&#8377;${total.toFixed(2)}</td>
      </tr>
    </table>

    <!-- Ship to -->
    ${addr ? `
    <div style="margin-bottom:24px;">
      <div style="font-size:9px;font-weight:700;letter-spacing:4px;color:#444;text-transform:uppercase;margin-bottom:12px;">Shipping To</div>
      <div style="font-size:13px;color:#888;line-height:1.9;">
        <span style="font-weight:700;color:#ccc;">${addr.name}</span><br>
        ${addr.address1}${addr.address2 ? ', ' + addr.address2 : ''}<br>
        ${addr.city}, ${addr.province} ${addr.zip}<br>
        ${addr.phone ? `<span style="color:#555;font-size:12px;">${addr.phone}</span>` : ''}
      </div>
    </div>` : ''}

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

async function autoHoldCronJob() {
  try {
    const cutoff = Date.now() - AUTO_HOLD_DAYS * 24 * 60 * 60 * 1000;
    const cutoffISO = new Date(cutoff).toISOString();

    // Fetch all orders created before the cutoff
    const oldOrders = await fetchAllOrders("any", "2020-01-01T00:00:00Z", cutoffISO);
    const metas = await mdb.collection('order_meta').find({}, { projection: { shopify_id: 1, stage: 1, _id: 0 } }).toArray();
    const metaMap = Object.fromEntries(metas.map(m => [m.shopify_id, m]));
    const token = await getAccessToken();
    const cfg = await getSmtpConfig();

    const moved = [];
    for (const o of oldOrders) {
      const sid = String(o.id);
      const meta = metaMap[sid] || {};
      const stage = meta.stage || 'new';
      if (stage !== 'new') continue; // only auto-hold orders still in new

      // Move to hold in our DB
      await OM.upsert(sid, { stage: 'hold', updated_at: new Date().toISOString() });

      // Add "on hold" tag in Shopify (preserve existing tags)
      const existingTags = (o.tags || '').split(',').map(t => t.trim()).filter(Boolean);
      if (!existingTags.some(t => t.toLowerCase() === AUTO_HOLD_TAG)) {
        const newTags = [...existingTags, AUTO_HOLD_TAG].join(', ');
        await fetch(`https://${SHOP}.myshopify.com/admin/api/2025-01/orders/${sid}.json`, {
          method: 'PUT',
          headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
          body: JSON.stringify({ order: { id: sid, tags: newTags } }),
        });
      }

      moved.push({ name: o.name, id: sid, created_at: o.created_at });
      auditLog('system', 'auto_hold', sid, { reason: `${AUTO_HOLD_DAYS}d in new stage` });
      console.log(`🔒 Auto-hold: ${o.name} (${sid}) moved to hold after ${AUTO_HOLD_DAYS} days`);

      // Send hold notification email to customer (COD orders only)
      const isCodOrder = o.financial_status !== 'paid';
      const customerEmail = o.email;
      if (isCodOrder && customerEmail && cfg) {
        try {
          const enriched = await enrichOrderImages(o);
          const html = templateOrderOnHoldCustomer({ order: enriched });
          await sendEmail({ to: customerEmail, subject: `Your Order ${o.name} is On Hold — Please Confirm`, html, trigger: 'auto_hold_customer' });
          console.log(`📧 Hold email sent to ${customerEmail} for ${o.name}`);
        } catch (emailErr) {
          console.error(`⚠️  Hold email failed for ${o.name}:`, emailErr.message);
        }
      }
    }

    if (moved.length === 0) return;

    // Send notification email to admin + staff
    const rsSettings = await RS.get();
    const adminEmail = cfg?.adminEmail || cfg?.user;
    const staffList  = (rsSettings.staff_emails || '').split(',').map(e => e.trim()).filter(Boolean);
    const recipients = [adminEmail, ...staffList].filter(Boolean);
    if (!cfg || !recipients.length) return;

    const orderRows = moved.map(o => `
      <tr>
        <td style="padding:8px 12px;border-bottom:1px solid #1e293b;font-family:monospace;color:#a5b4fc;font-weight:700">${o.name}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #1e293b;color:#94a3b8;font-size:12px">${new Date(o.created_at).toLocaleDateString('en-IN',{day:'numeric',month:'short',year:'numeric'})}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #1e293b"><span style="background:#1c1208;color:#f59e0b;border:1px solid #92400e;border-radius:4px;padding:2px 8px;font-size:11px;font-weight:700">ON HOLD</span></td>
      </tr>`).join('');

    const html = emailBase(`🔒 ${moved.length} Order${moved.length>1?'s':''} Auto-Moved to Hold`, '#f59e0b', `
      <div class="subtitle">${moved.length} order${moved.length>1?'s':''} have been automatically moved to <strong>On Hold</strong> after sitting in New stage for ${AUTO_HOLD_DAYS}+ days.</div>

      <div style="background:#1c1208;border:2px solid #f59e0b;border-radius:8px;padding:14px 18px;margin-bottom:20px;text-align:center">
        <div style="font-size:32px;font-weight:900;color:#f59e0b;">${moved.length}</div>
        <div style="font-size:12px;color:#92400e;font-weight:600;margin-top:4px;">Order${moved.length>1?'s':''} require your attention</div>
      </div>

      <div style="font-size:13px;font-weight:700;color:#94a3b8;margin-bottom:10px;">Orders moved to hold:</div>
      <div style="background:#1e293b;border-radius:8px;overflow:hidden;margin-bottom:20px">
        <table style="width:100%;border-collapse:collapse">
          <tr style="background:#0f172a">
            <th style="padding:9px 12px;text-align:left;font-size:11px;color:#64748b;font-weight:600">ORDER</th>
            <th style="padding:9px 12px;text-align:left;font-size:11px;color:#64748b;font-weight:600">PLACED ON</th>
            <th style="padding:9px 12px;text-align:left;font-size:11px;color:#64748b;font-weight:600">STATUS</th>
          </tr>
          ${orderRows}
        </table>
      </div>

      <div style="background:#0d1520;border:1px solid #1a3a6a;border-radius:8px;padding:14px 18px;margin-bottom:16px">
        <div style="font-size:13px;font-weight:700;color:#7eb8f7;margin-bottom:6px;">Action Required</div>
        <div style="font-size:12px;color:#94a3b8;line-height:1.8">
          Please review these orders on the admin panel and either:<br>
          • <strong style="color:#10b981">Confirm</strong> the order (move to Confirmed stage)<br>
          • <strong style="color:#ef4444">Cancel</strong> the order if it cannot be fulfilled
        </div>
      </div>
    `);

    for (const to of recipients) {
      await sendEmail({ to, subject: `🔒 ${moved.length} Order${moved.length>1?'s':''} Auto-Moved to Hold — Action Required`, html, trigger: 'auto_hold_notify' });
    }
    console.log(`🔒 Auto-hold cron: ${moved.length} orders moved, notified ${recipients.length} recipient(s)`);
  } catch (e) {
    console.error('⚠️  Auto-hold cron error:', e.message);
  }
}

// Run once at startup (in case server restarted mid-day), then every 6 hours
autoHoldCronJob().catch(() => {});
setInterval(autoHoldCronJob, 6 * 60 * 60 * 1000);

// ══════════════════════════════════════════════════════════════════════════
//  DELHIVERY TRACKING CRON
// ══════════════════════════════════════════════════════════════════════════

// Map Delhivery status strings → our internal stage
function delhiveryStatusToStage(status) {
  if (!status) return null;
  const s = status.toLowerCase();
  if (s.includes('delivered'))                          return 'delivered';
  if (s.includes('rto') || s.includes('return'))        return 'rto';
  if (s.includes('out for delivery') || s.includes('out_for_delivery')) return 'ofd';
  if (s.includes('in transit') || s.includes('in_transit') || s.includes('transit')) return 'transit';
  if (s.includes('picked up') || s.includes('pickup') || s.includes('manifested')) return 'pickup';
  if (s.includes('lost') || s.includes('damage'))       return 'rto';
  return null;
}

async function delhiveryTrackingCron() {
  const runLog = { ran_at: new Date().toISOString(), checked: 0, updated: 0, skipped: 0, errors: [], updates: [] };
  try {
    const credRow = await mdb.collection('global_shipping_creds').findOne({ partner: 'delhivery' }, { projection: { credentials: 1, _id: 0 } });
    if (!credRow) { runLog.message = 'No Delhivery credentials configured.'; await mdb.collection('delhivery_cron_log').insertOne(runLog); return; }
    const creds = JSON.parse(credRow.credentials);
    if (!creds.api_token) { runLog.message = 'Delhivery API token missing in credentials.'; await mdb.collection('delhivery_cron_log').insertOne(runLog); return; }

    const activeStages = await mdb.collection('order_vendor_stage').find(
      { stage: { $in: ['transit', 'pickup', 'ready'] }, awb: { $exists: true, $ne: '' } },
      { projection: { shopify_id: 1, vendor_name: 1, awb: 1, courier: 1, stage: 1, _id: 0 } }
    ).toArray();

    const delhiveryStages = activeStages.filter(r => (r.courier || '').toLowerCase().includes('delhivery') || (r.awb || '').match(/^\d{14,}$/));
    runLog.checked = delhiveryStages.length;

    if (!delhiveryStages.length) {
      runLog.message = 'No active Delhivery shipments to check.';
      await mdb.collection('delhivery_cron_log').insertOne(runLog);
      return;
    }

    console.log(`🚚 Delhivery cron: checking ${delhiveryStages.length} active shipments…`);

    const BATCH = 10;
    for (let i = 0; i < delhiveryStages.length; i += BATCH) {
      const batch = delhiveryStages.slice(i, i + BATCH);
      const waybills = batch.map(r => r.awb).join(',');
      try {
        const dlRes = await fetch(
          `https://track.delhivery.com/api/v1/packages/json/?waybill=${waybills}`,
          { headers: { 'Authorization': `Token ${creds.api_token}`, 'Content-Type': 'application/json' } }
        ).then(r => r.json());

        for (const shipData of (dlRes.ShipmentData || [])) {
          const shipment = shipData.Shipment;
          const awb = shipment?.AWB || shipment?.waybill || '';
          const rawStatus = shipment?.Status?.Status || shipment?.status || '';
          const newStage = delhiveryStatusToStage(rawStatus);
          const record = batch.find(r => r.awb === awb);
          if (!record) continue;

          if (!newStage || record.stage === newStage) {
            runLog.skipped++;
            runLog.checked_detail = runLog.checked_detail || [];
            runLog.checked_detail.push({ shopify_id: record.shopify_id, vendor: record.vendor_name, awb, current_stage: record.stage, delhivery_status: rawStatus || '(no status)', action: !newStage ? 'unmapped' : 'no_change' });
            continue;
          }

          const now = new Date().toISOString();
          await OVS.upsert(record.shopify_id, record.vendor_name, { stage: newStage, updated_at: now });
          await OM.upsert(record.shopify_id, { delivery_status: rawStatus, delivery_status_updated_at: now });
          auditLog('cron', 'delhivery_stage_update', record.shopify_id, { vendor: record.vendor_name, awb, rawStatus, newStage });
          runLog.updated++;
          runLog.updates.push({ shopify_id: record.shopify_id, vendor: record.vendor_name, awb, from: record.stage, to: newStage, status: rawStatus });
          runLog.checked_detail = runLog.checked_detail || [];
          runLog.checked_detail.push({ shopify_id: record.shopify_id, vendor: record.vendor_name, awb, current_stage: record.stage, delhivery_status: rawStatus, action: 'updated_to_' + newStage });
          console.log(`  ✓ ${record.shopify_id} (${record.vendor_name}) AWB ${awb}: ${record.stage} → ${newStage} (${rawStatus})`);
        }
        // Track AWBs Delhivery returned no data for
        for (const rec of batch) {
          const found = (dlRes.ShipmentData || []).some(s => (s.Shipment?.AWB || s.Shipment?.waybill) === rec.awb);
          if (!found) {
            runLog.checked_detail = runLog.checked_detail || [];
            runLog.checked_detail.push({ shopify_id: rec.shopify_id, vendor: rec.vendor_name, awb: rec.awb, current_stage: rec.stage, delhivery_status: '(not found in response)', action: 'not_found' });
          }
        }
      } catch(e) {
        runLog.errors.push({ batch: waybills, error: e.message });
        console.error(`  ✗ Delhivery batch error: ${e.message}`);
      }

      if (i + BATCH < delhiveryStages.length) await new Promise(r => setTimeout(r, 1000));
    }

    runLog.message = `Checked ${runLog.checked}, updated ${runLog.updated}, skipped ${runLog.skipped}`;
    console.log(`🚚 Delhivery cron done: ${runLog.message}`);
  } catch(e) {
    runLog.errors.push({ error: e.message });
    console.error('❌ delhiveryTrackingCron:', e.message);
  }
  // Save log (keep last 50 runs)
  await mdb.collection('delhivery_cron_log').insertOne(runLog);
  await mdb.collection('delhivery_cron_log').deleteMany({ ran_at: { $lt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString() } });
}

// Manual trigger + log endpoints
app.post("/admin/delhivery/sync", adminAuth, async (req, res) => {
  delhiveryTrackingCron().catch(() => {});
  res.json({ success: true, message: "Delhivery sync triggered — check logs in a moment." });
});

app.get("/admin/delhivery/logs", adminAuth, async (req, res) => {
  const logs = await mdb.collection('delhivery_cron_log').find({}, { projection: { _id: 0 } }).sort({ ran_at: -1 }).limit(20).toArray();
  res.json({ logs });
});

// Run every 3 hours (delay startup run by 30s to let MongoDB connect first)
setTimeout(() => delhiveryTrackingCron().catch(() => {}), 30000);
setInterval(delhiveryTrackingCron, 3 * 60 * 60 * 1000);

// ══════════════════════════════════════════════════════════════════════════
//  SHIPSAGAR INTEGRATION
// ══════════════════════════════════════════════════════════════════════════

async function getShipSagarCreds() {
  const row = await mdb.collection('global_shipping_creds').findOne({ partner: 'shipsagar' });
  if (!row) return null;
  return JSON.parse(row.credentials || '{}');
}

// Emoji tag for each ShipSagar tracking status
const SS_STATUS_TAG_MAP = [
  { match: ['successfully delivered'],                                    tag: '✅ Delivered' },
  { match: ['rto', 'return to origin', 'return initiated'],              tag: '🔄 RTO' },
  { match: ['lost', 'damage'],                                           tag: '⚠️ Lost/Damaged' },
  { match: ['out for delivery', 'ofd'],                                  tag: '🛵 Out for Delivery' },  // → maps to 'ofd' stage
  { match: ['undelivered', 'failed delivery', 'delivery attempt', 'not delivered'], tag: '❌ Delivery Attempted' },
  { match: ['pickdone', 'pick done', 'picked up', 'pickup done'],        tag: '📦 Picked Up' },
  { match: ['manifested', 'shipment booked', 'dispatched'],              tag: '📋 Manifested' },
  { match: ['in transit', 'intransit', 'arrived', 'received at', 'facility', 'hub', 'sorting'], tag: '🚚 In Transit' },
  { match: ['data received', 'label created', 'softdata', 'booked'],     tag: '🏷️ Label Created' },
];

// All tracking tags we manage — used to remove old one before adding new
const SS_ALL_TRACKING_TAGS = SS_STATUS_TAG_MAP.map(e => e.tag);

function shipsagarDescToTag(desc) {
  if (!desc) return null;
  const s = desc.toLowerCase().replace(/[_\s]+/g, ' ');
  for (const entry of SS_STATUS_TAG_MAP) {
    if (entry.match.some(m => s.includes(m))) return entry.tag;
  }
  return null;
}

async function applyShipSagarTag(shopifyId, desc) {
  const newTag = shipsagarDescToTag(desc);
  if (!newTag) return;
  try {
    const shopifyToken = await getAccessToken();
    // Fetch current tags
    const od = await fetch(`https://${SHOP}.myshopify.com/admin/api/2025-01/orders/${shopifyId}.json?fields=id,tags`, {
      headers: { 'X-Shopify-Access-Token': shopifyToken },
    }).then(r => r.json());
    const currentTags = (od.order?.tags || '').split(',').map(t => t.trim()).filter(Boolean);
    // Remove old tracking tags, add new one
    const cleaned = currentTags.filter(t => !SS_ALL_TRACKING_TAGS.includes(t));
    if (!cleaned.includes(newTag)) cleaned.push(newTag);
    const tagStr = cleaned.join(', ');
    await fetch(`https://${SHOP}.myshopify.com/admin/api/2025-01/orders/${shopifyId}.json`, {
      method: 'PUT',
      headers: { 'X-Shopify-Access-Token': shopifyToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ order: { id: shopifyId, tags: tagStr } }),
    });
    console.log(`🏷️  ShipSagar tag updated: order ${shopifyId} → "${newTag}"`);
  } catch(e) { console.error('ShipSagar tag error:', e.message); }
}

// Map ShipSagar ActionDescription / CurrentStatus → internal stage
function shipsagarStatusToStage(desc) {
  if (!desc) return null;
  const s = desc.toLowerCase().replace(/[_\s]+/g, ' ');
  if (s.includes('successfully delivered') || (s.includes('delivered') && !s.includes('out for') && !s.includes('undeliver') && !s.includes('not deliver'))) return 'delivered';
  if (s.includes('rto') || s.includes('return to origin') || s.includes('return initiated')) return 'rto';
  if (s.includes('lost') || s.includes('damage'))               return 'rto';
  if (s.includes('out for delivery') || s.includes('ofd'))      return 'ofd';
  if (s.includes('undelivered') || s.includes('failed delivery') || s.includes('delivery attempt')) return 'transit';
  if (s.includes('in transit') || s.includes('intransit') || s.includes('arrived') || s.includes('received at') || s.includes('facility') || s.includes('hub') || s.includes('sorting')) return 'transit';
  if (s.includes('pickdone') || s.includes('pick done') || s.includes('picked up') || s.includes('pickup done') || s.includes('manifested') || s.includes('dispatched') || s.includes('shipment booked') || s.includes('data received')) return 'pickup';
  return null;
}

// Map our internal courier names to ShipSagar courier codes
function toShipSagarCourierCode(courier) {
  const c = (courier || '').toLowerCase();
  if (c.includes('xpressbees'))                        return 'XPRESSBEES';
  if (c.includes('delhivery'))                         return 'DELHIVERY';
  if (c.includes('bluedart') || c.includes('blue dart')) return 'BLUEDART';
  if (c.includes('dtdc'))                              return 'DTDC';
  if (c.includes('ecom') || c.includes('ecom express')) return 'ECME';
  if (c.includes('fedex'))                             return 'FEDEX';
  if (c.includes('dhl'))                               return 'DHL';
  if (c.includes('ups'))                               return 'UPS';
  if (c.includes('aramex'))                            return 'ARAMEX';
  if (c.includes('india post') || c.includes('indiapost')) return 'INDIAPOST';
  if (c.includes('shadowfax'))                         return 'SHADOWFAX';
  if (c.includes('ekart'))                             return 'EKART';
  if (c.includes('shiprocket'))                        return '';  // aggregator, no single code
  if (c.includes('shipmozo'))                          return '';
  return courier.toUpperCase();  // pass through as-is
}

// Push a single AWB to ShipSagar for tracking
async function shipsagarPushShipment({ awb, courierCode = '', orderNo = '', customerName = '', email = '', mobileNo = '' }) {
  const creds = await getShipSagarCreds();
  if (!creds?.api_key) return { ok: false, reason: 'ShipSagar not configured' };
  // ShipSagar requires EmailID, MobileNo, ShipmentType — use fallbacks if not provided
  const adminEmail = creds.admin_email || 'harshitvj24@gmail.com';
  const adminPhone = (creds.admin_phone || mobileNo || '9999999999').replace(/\D/g,'').slice(-10);
  try {
    const res = await fetch('https://app.shipsagar.com/api/Web/PushShipment', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        Token:        creds.api_key,
        ClientCode:   creds.client_code,
        CourierCode:  toShipSagarCourierCode(courierCode),
        TrackingNo:   awb,
        OrderNo:      orderNo || awb,
        CustomerName: customerName || 'Customer',
        EmailID:      email || adminEmail,
        MobileNo:     mobileNo || adminPhone,
        ShipmentType: 'surface',
        CountryName:  'India',
        CompanyName:  'CrosCrow',
      }),
    }).then(r => r.json());
    console.log(`📦 ShipSagar push AWB ${awb}: ${res.status} — ${res.message}`);
    return { ok: res.status?.toLowerCase() === 'success', response: res };
  } catch(e) { return { ok: false, reason: e.message }; }
}

// Track a single AWB via ShipSagar
// Returns: { found: true, detail, history } | { found: false } | null (not configured)
async function shipsagarTrackShipment(awb) {
  const creds = await getShipSagarCreds();
  if (!creds?.api_key) return null;
  try {
    const res = await fetch('https://app.shipsagar.com/api/Web/TrackShipment', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ Token: creds.api_key, ClientCode: creds.client_code, TrackingNo: awb }),
    }).then(r => r.json());
    if (res.status?.toUpperCase() !== 'SUCCESS') return { found: false };

    // ShipSagar returns trackingDetails as a double-encoded JSON string
    // e.g. trackingDetails: "\"{ ... }\""  OR TrackingDetails: [...]
    let detail = null;
    if (res.TrackingDetails?.[0]) {
      detail = res.TrackingDetails[0];
    } else if (res.trackingDetails) {
      try {
        let raw = res.trackingDetails;
        // Unwrap double encoding: might be "\"{ json }\"" or "{ json }"
        if (typeof raw === 'string') {
          raw = raw.trim();
          if (raw.startsWith('"')) raw = JSON.parse(raw); // unwrap outer quotes
          if (typeof raw === 'string') raw = JSON.parse(raw); // parse inner JSON
          detail = raw;
        }
      } catch { detail = null; }
    }

    if (!detail) return { found: false };
    const history = detail.TrackingHistory || [];
    return { found: true, detail, history, currentStatus: detail.CurrentStatus || '' };
  } catch { return { found: false }; }
}

async function shipsagarTrackingCron() {
  const runLog = { ran_at: new Date().toISOString(), checked: 0, tagged: 0, updated: 0, skipped: 0, errors: [], updates: [] };
  try {
    const creds = await getShipSagarCreds();
    if (!creds?.api_key) { runLog.message = 'ShipSagar not configured.'; await mdb.collection('shipsagar_cron_log').insertOne(runLog); return; }

    // Only orders with AWB updated/created after 3 May 2026
    const TRACK_FROM = new Date('2026-05-03T00:00:00.000Z').toISOString();
    const activeStages = await mdb.collection('order_vendor_stage').find(
      { stage: { $nin: ['new', 'cancelled'] }, awb: { $exists: true, $ne: '' }, updated_at: { $gte: TRACK_FROM } },
      { projection: { shopify_id: 1, vendor_name: 1, awb: 1, courier: 1, stage: 1, _id: 0 } }
    ).toArray();

    // Deduplicate by AWB — one ShipSagar call per unique AWB
    const awbMap = new Map();
    for (const r of activeStages) {
      if (!awbMap.has(r.awb)) awbMap.set(r.awb, r);
    }
    const toCheck = [...awbMap.values()];

    runLog.checked = toCheck.length;
    if (!toCheck.length) { runLog.message = 'No active shipments with AWB.'; await mdb.collection('shipsagar_cron_log').insertOne(runLog); return; }
    console.log(`📦 ShipSagar cron: checking ${toCheck.length} shipments…`);

    for (const rec of toCheck) {
      try {
        const ss = await shipsagarTrackShipment(rec.awb);
        if (!ss?.found || !ss.history?.length) { runLog.skipped++; continue; }

        const latest = ss.history[ss.history.length - 1];
        const desc = latest.ActionDescription || '';
        const tag = shipsagarDescToTag(desc);
        const newStage = shipsagarStatusToStage(desc);
        const now = new Date().toISOString();

        // Always update delivery_status and apply tag
        await OM.upsert(rec.shopify_id, { delivery_status: desc, delivery_status_updated_at: now });
        if (tag) {
          applyShipSagarTag(rec.shopify_id, desc).catch(() => {});
          runLog.tagged++;
        }

        // Update stage only if it changed
        if (newStage && rec.stage !== newStage) {
          await OVS.upsert(rec.shopify_id, rec.vendor_name, { stage: newStage, updated_at: now });
          auditLog('cron', 'shipsagar_stage_update', rec.shopify_id, { vendor: rec.vendor_name, awb: rec.awb, desc, newStage });
          runLog.updated++;
          runLog.updates.push({ shopify_id: rec.shopify_id, vendor: rec.vendor_name, awb: rec.awb, from: rec.stage, to: newStage, desc, tag });
          console.log(`  ✓ ${rec.shopify_id} ${rec.awb}: ${rec.stage}→${newStage} "${desc}" ${tag||''}`);
        } else {
          runLog.skipped++;
        }
      } catch(e) { runLog.errors.push({ awb: rec.awb, error: e.message }); }

      await new Promise(r => setTimeout(r, 300)); // 300ms between calls
    }

    runLog.message = `Checked ${runLog.checked}, updated ${runLog.updated}, skipped ${runLog.skipped}`;
    console.log(`📦 ShipSagar cron done: ${runLog.message}`);
  } catch(e) {
    runLog.errors.push({ error: e.message });
    console.error('❌ shipsagarTrackingCron:', e.message);
  }
  await mdb.collection('shipsagar_cron_log').insertOne(runLog);
  await mdb.collection('shipsagar_cron_log').deleteMany({ ran_at: { $lt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString() } });
}

// Manual trigger
app.post("/admin/shipsagar/sync", adminAuth, async (req, res) => {
  shipsagarTrackingCron().catch(() => {});
  res.json({ success: true, message: 'ShipSagar sync triggered — check logs.' });
});
// Raw debug — shows exact ShipSagar response for any AWB
app.get("/admin/shipsagar/debug", adminAuth, async (req, res) => {
  const { awb } = req.query;
  if (!awb) return res.status(400).json({ error: 'Pass ?awb=YOUR_AWB' });
  const creds = await getShipSagarCreds();
  if (!creds?.api_key) return res.status(400).json({ error: 'ShipSagar not configured' });
  try {
    // Raw track response
    const trackRes = await fetch('https://app.shipsagar.com/api/Web/TrackShipment', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ Token: creds.api_key, ClientCode: creds.client_code, TrackingNo: awb }),
    }).then(r => r.json());

    // Also try push to see if it registers
    const { courier } = req.query;
    const pushRes = await shipsagarPushShipment({ awb, courierCode: courier || '', orderNo: awb });

    res.json({ awb, track: trackRes, push: pushRes });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get("/admin/shipsagar/logs", adminAuth, async (req, res) => {
  const logs = await mdb.collection('shipsagar_cron_log').find({}, { projection: { _id: 0 } }).sort({ ran_at: -1 }).limit(20).toArray();
  res.json({ logs });
});
// Push a single AWB manually
// Push single AWB
app.post("/admin/shipsagar/push", adminAuth, async (req, res) => {
  const { awb, courierCode, orderNo, customerName, email, mobileNo } = req.body || {};
  if (!awb) return res.status(400).json({ error: 'awb required' });
  const result = await shipsagarPushShipment({ awb, courierCode, orderNo, customerName, email, mobileNo });
  res.json(result);
});

// Bulk register all AWBs from orders after 3 May 2026
app.post("/admin/shipsagar/register-all", adminAuth, async (req, res) => {
  try {
    const TRACK_FROM = new Date('2026-05-03T00:00:00.000Z').toISOString();
    const rows = await mdb.collection('order_vendor_stage').find(
      { awb: { $exists: true, $ne: '' }, updated_at: { $gte: TRACK_FROM } },
      { projection: { shopify_id: 1, awb: 1, courier: 1, _id: 0 } }
    ).toArray();

    // Deduplicate by AWB
    const unique = [...new Map(rows.map(r => [r.awb, r])).values()];
    res.json({ message: `Registering ${unique.length} AWBs with ShipSagar in background…`, count: unique.length });

    // Fire and forget — push all in background
    (async () => {
      let success = 0, failed = 0;
      for (const r of unique) {
        const result = await shipsagarPushShipment({ awb: r.awb, courierCode: r.courier || '', orderNo: r.shopify_id });
        if (result.ok) success++; else failed++;
        await new Promise(resolve => setTimeout(resolve, 400)); // rate limit
      }
      console.log(`📦 ShipSagar bulk register done: ${success} registered, ${failed} failed`);
    })().catch(e => console.error('ShipSagar bulk register error:', e.message));
  } catch(err) { res.status(500).json({ error: err.message }); }
});
// Get supported couriers
async function fetchShipSagarCouriers() {
  const creds = await getShipSagarCreds();
  if (!creds?.api_key) return [];
  const data = await fetch('https://app.shipsagar.com/api/Web/GetCourier', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ Token: creds.api_key, ClientCode: creds.client_code }),
  }).then(r => r.json());
  return data.getCourier || [];
}

app.get("/admin/shipsagar/couriers", adminAuth, async (req, res) => {
  try {
    const list = await fetchShipSagarCouriers();
    res.json({ getCourier: list });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get("/vendor/shipsagar/couriers", vendorAuth, async (req, res) => {
  try {
    const list = await fetchShipSagarCouriers();
    res.json({ getCourier: list });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Run every 2 hours, offset 60s from startup
setTimeout(() => shipsagarTrackingCron().catch(() => {}), 60000);
setInterval(shipsagarTrackingCron, 2 * 60 * 60 * 1000);

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

// ══════════════════════════════════════════════════════════════════════════
// RETURN / EXCHANGE EMAIL TEMPLATES
// ══════════════════════════════════════════════════════════════════════════

function rrItemsHtml(items = [], type = 'return') {
  const rows = items.map(it => `
    <tr>
      <td style="padding:10px 14px;border-bottom:1px solid #f1f5f9;font-size:13px;color:#374151;vertical-align:middle">
        <strong>${it.title || ''}</strong>
        ${it.variant_title ? `<br><span style="font-size:11px;color:#9ca3af">${it.variant_title}</span>` : ''}
        ${type === 'exchange' && it.exchange_size_label ? `<br><span style="font-size:11px;color:#002eff;font-weight:600">↔ Exchange for: ${it.exchange_size_label}</span>` : ''}
      </td>
      <td style="padding:10px 14px;border-bottom:1px solid #f1f5f9;font-size:13px;text-align:center;color:#6b7280;vertical-align:middle">${it.qty || 1}</td>
    </tr>`).join('');
  return `<table style="width:100%;border-collapse:collapse;margin-bottom:20px;">
    <thead><tr style="background:#f8fafc">
      <th style="padding:10px 14px;text-align:left;font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:1px">Item</th>
      <th style="padding:10px 14px;text-align:center;font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:1px">Qty</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function rrInfoBox(req) {
  return `<div class="info-box">
    <div class="info-row"><span class="info-label">Request ID</span><span class="info-val">${req.request_id}</span></div>
    <div class="info-row"><span class="info-label">Order</span><span class="info-val">${req.order_name}</span></div>
    <div class="info-row"><span class="info-label">Type</span><span class="info-val">${req.type === 'exchange' ? '🔄 Exchange' : '↩ Return'}</span></div>
    <div class="info-row"><span class="info-label">Customer</span><span class="info-val">${req.customer_name}</span></div>
    <div class="info-row"><span class="info-label">Reason</span><span class="info-val">${req.reason}</span></div>
  </div>`;
}

// Customer: submitted
function templateRRSubmittedCustomer({ req }) {
  const accent = '#002eff';
  const body = `
    <div class="subtitle">We've received your ${req.type} request and will review it shortly.</div>
    ${rrInfoBox(req)}
    ${rrItemsHtml(req.items, req.type)}
    <p style="font-size:13px;color:#6b7280;line-height:1.7">Our team typically reviews requests within 24 hours. We'll email you once a decision is made.</p>`;
  return emailBase(`${req.type === 'exchange' ? 'Exchange' : 'Return'} Request Received`, accent, body);
}

// Admin: new request
function templateRRSubmittedAdmin({ req }) {
  const accent = '#002eff';
  const body = `
    <div class="subtitle">A customer has submitted a new ${req.type} request.</div>
    ${rrInfoBox(req)}
    <div class="info-box"><div class="info-row"><span class="info-label">Vendor</span><span class="info-val">${req.vendor_name || '—'}</span></div>
    <div class="info-row"><span class="info-label">Email</span><span class="info-val">${req.customer_email}</span></div>
    <div class="info-row"><span class="info-label">Phone</span><span class="info-val">${req.customer_phone || '—'}</span></div></div>
    ${rrItemsHtml(req.items, req.type)}
    <p style="font-size:13px;color:#6b7280">Go to <strong>Admin Portal → Returns</strong> to approve or reject this request.</p>`;
  return emailBase(`New ${req.type === 'exchange' ? 'Exchange' : 'Return'} Request — ${req.order_name}`, accent, body);
}

// Vendor: new request
function templateRRSubmittedVendor({ req }) {
  const accent = '#6366f1';
  const body = `
    <div class="subtitle">A customer has submitted a ${req.type} request for one of your orders.</div>
    ${rrInfoBox(req)}
    ${rrItemsHtml(req.items, req.type)}
    <p style="font-size:13px;color:#6b7280">Please log in to the <strong>Vendor Portal → Returns</strong> to review. Admin will approve or reject within 24 hours.</p>`;
  return emailBase(`New ${req.type === 'exchange' ? 'Exchange' : 'Return'} Request — ${req.order_name}`, accent, body);
}

// Customer: approved
function templateRRApprovedCustomer({ req }) {
  const body = `
    <div class="subtitle">Great news — your ${req.type} request has been approved!</div>
    ${rrInfoBox(req)}
    ${rrItemsHtml(req.items, req.type)}
    <p style="font-size:13px;color:#6b7280;line-height:1.7">Our team will arrange pickup of your item${req.items.length > 1 ? 's' : ''} shortly. Please keep the item${req.items.length > 1 ? 's' : ''} ready and packed. You'll receive another email when pickup is scheduled.</p>`;
  return emailBase(`Your ${req.type === 'exchange' ? 'Exchange' : 'Return'} Request Approved ✓`, '#10b981', body);
}

// Vendor: admin approved — arrange pickup
function templateRRApprovedVendor({ req }) {
  const body = `
    <div class="subtitle">Admin has approved a ${req.type} request. Please arrange reverse pickup from the customer.</div>
    ${rrInfoBox(req)}
    <div class="info-box">
      <div class="info-row"><span class="info-label">Customer</span><span class="info-val">${req.customer_name}</span></div>
      <div class="info-row"><span class="info-label">Email</span><span class="info-val">${req.customer_email}</span></div>
      <div class="info-row"><span class="info-label">Phone</span><span class="info-val">${req.customer_phone || '—'}</span></div>
    </div>
    ${rrItemsHtml(req.items, req.type)}
    <p style="font-size:13px;color:#6b7280;line-height:1.7">Please arrange reverse pickup within <strong>24 hours</strong>. Log in to <strong>Vendor Portal → Returns</strong> to update the status.</p>`;
  return emailBase(`Action Needed: ${req.type === 'exchange' ? 'Exchange' : 'Return'} Approved — ${req.order_name}`, '#f59e0b', body);
}

// Admin: vendor approved
function templateRRApprovedAdmin({ req }) {
  const body = `
    <div class="subtitle">Vendor has approved the ${req.type} request and will arrange pickup.</div>
    ${rrInfoBox(req)}
    ${rrItemsHtml(req.items, req.type)}
    <p style="font-size:13px;color:#6b7280">Monitor progress in <strong>Admin Portal → Returns</strong>.</p>`;
  return emailBase(`Vendor Approved: ${req.type === 'exchange' ? 'Exchange' : 'Return'} ${req.request_id}`, '#10b981', body);
}

// Customer: rejected
function templateRRRejectedCustomer({ req }) {
  const body = `
    <div class="subtitle">Unfortunately, your ${req.type} request could not be approved at this time.</div>
    ${rrInfoBox(req)}
    ${req.admin_note ? `<div class="info-box"><div class="info-row"><span class="info-label">Reason</span><span class="info-val">${req.admin_note}</span></div></div>` : ''}
    <p style="font-size:13px;color:#6b7280;line-height:1.7">If you believe this is an error or need further assistance, please contact our support team.</p>`;
  return emailBase(`Update on Your ${req.type === 'exchange' ? 'Exchange' : 'Return'} Request`, '#dc2626', body);
}

// Customer: pickup scheduled
function templateRRPickupCustomer({ req }) {
  const body = `
    <div class="subtitle">Pickup has been scheduled for your ${req.type} request. Please keep your item ready.</div>
    ${rrInfoBox(req)}
    ${rrItemsHtml(req.items, req.type)}
    <p style="font-size:13px;color:#6b7280;line-height:1.7">Our pickup partner will collect the item from your address. Please ensure it is securely packed. You'll receive a tracking update once picked up.</p>`;
  return emailBase(`Pickup Scheduled — ${req.request_id}`, '#6366f1', body);
}

// Customer: in transit
function templateRRInTransitCustomer({ req }) {
  const body = `
    <div class="subtitle">Your ${req.type} item is on its way to us.</div>
    ${rrInfoBox(req)}
    <p style="font-size:13px;color:#6b7280;line-height:1.7">${req.type === 'exchange' ? 'We\'ll process your exchange and dispatch the new item once we receive yours.' : 'We\'ll process your return and initiate the refund once we receive the item.'}</p>`;
  return emailBase(`Your ${req.type === 'exchange' ? 'Exchange' : 'Return'} is In Transit`, '#6366f1', body);
}

// Customer: completed
function templateRRCompletedCustomer({ req }) {
  const body = `
    <div class="subtitle">${req.type === 'exchange' ? 'Your exchange order has been delivered!' : 'We\'ve received your returned item. Your request is complete.'}</div>
    ${rrInfoBox(req)}
    ${req.type === 'exchange' ? `<p style="font-size:13px;color:#6b7280;line-height:1.7">Enjoy your new item! Thank you for shopping with CrosCrow.</p>` : `<p style="font-size:13px;color:#6b7280;line-height:1.7">Your refund will be processed within 5–7 business days. Thank you for your patience.</p>`}`;
  return emailBase(`${req.type === 'exchange' ? 'Exchange Complete ✓' : 'Return Received ✓'} — ${req.request_id}`, '#10b981', body);
}

// Admin: 24hr reminder — still pending
function templateRRReminder24Admin({ req }) {
  const hrs = Math.round((Date.now() - new Date(req.created_at).getTime()) / 3600000);
  const body = `
    <div class="subtitle">This ${req.type} request has been pending for <strong>${hrs} hours</strong> and needs your attention.</div>
    ${rrInfoBox(req)}
    <div class="info-box"><div class="info-row"><span class="info-label">Vendor</span><span class="info-val">${req.vendor_name || '—'}</span></div>
    <div class="info-row"><span class="info-label">Customer Email</span><span class="info-val">${req.customer_email}</span></div></div>
    <p style="font-size:13px;color:#6b7280">Go to <strong>Admin Portal → Returns</strong> to approve or reject.</p>`;
  return emailBase(`⏰ 24hr Reminder: ${req.type === 'exchange' ? 'Exchange' : 'Return'} Request Still Pending`, '#f59e0b', body);
}

// Vendor: 24hr reminder — approved but not fulfilled
function templateRRReminder24Vendor({ req }) {
  const hrs = Math.round((Date.now() - new Date(req.updated_at || req.created_at).getTime()) / 3600000);
  const body = `
    <div class="subtitle">This ${req.type} request was approved <strong>${hrs} hours ago</strong> but pickup has not been arranged yet.</div>
    ${rrInfoBox(req)}
    <div class="info-box">
      <div class="info-row"><span class="info-label">Customer</span><span class="info-val">${req.customer_name}</span></div>
      <div class="info-row"><span class="info-label">Phone</span><span class="info-val">${req.customer_phone || '—'}</span></div>
    </div>
    <p style="font-size:13px;color:#f59e0b;font-weight:700">Please arrange reverse pickup immediately from the customer's address.</p>
    <p style="font-size:13px;color:#6b7280">Log in to <strong>Vendor Portal → Returns</strong> to update the status.</p>`;
  return emailBase(`⏰ Action Needed: ${req.type === 'exchange' ? 'Exchange' : 'Return'} Not Yet Arranged`, '#f59e0b', body);
}

// ── Helper: send RR email by type ─────────────────────────────────────────
async function sendRREmail(type, req) {
  try {
    const cfg = await getSmtpConfig();
    const ADMIN = cfg?.adminEmail || 'harshitvj24@gmail.com';
    const vendorCfg = req.vendor_name ? (await mdb.collection('vendor_config').findOne({ vendor_name: req.vendor_name }) || {}) : {};
    const vendorEmail = vendorCfg.email || null;

    const send = (to, subject, html) => sendEmail({ to, subject, html, trigger: 'return_request' });

    const T = req.type === 'exchange' ? 'Exchange' : 'Return';
    switch (type) {
      case 'submitted':
        if (req.customer_email) await send(req.customer_email, `${T} Request Received — ${req.request_id}`, templateRRSubmittedCustomer({req}));
        await send(ADMIN, `New ${T} Request ${req.request_id} — ${req.order_name}`, templateRRSubmittedAdmin({req}));
        if (vendorEmail) await send(vendorEmail, `New ${T} Request for Order ${req.order_name}`, templateRRSubmittedVendor({req}));
        break;
      case 'approved_by_admin':
        if (req.customer_email) await send(req.customer_email, `Your ${T} Request Approved ✓ — ${req.request_id}`, templateRRApprovedCustomer({req}));
        if (vendorEmail) await send(vendorEmail, `Action Needed: ${T} Approved — ${req.order_name}`, templateRRApprovedVendor({req}));
        break;
      case 'approved_by_vendor':
        if (req.customer_email) await send(req.customer_email, `Your ${T} Request Approved ✓ — ${req.request_id}`, templateRRApprovedCustomer({req}));
        await send(ADMIN, `Vendor Approved ${T} Request ${req.request_id}`, templateRRApprovedAdmin({req}));
        break;
      case 'rejected':
        if (req.customer_email) await send(req.customer_email, `Update on Your ${T} Request — ${req.request_id}`, templateRRRejectedCustomer({req}));
        break;
      case 'pickup':
        if (req.customer_email) await send(req.customer_email, `Pickup Scheduled — ${req.request_id}`, templateRRPickupCustomer({req}));
        break;
      case 'in_transit':
        if (req.customer_email) await send(req.customer_email, `Your ${T} is In Transit — ${req.request_id}`, templateRRInTransitCustomer({req}));
        break;
      case 'completed':
        if (req.customer_email) await send(req.customer_email, `${T} Complete ✓ — ${req.request_id}`, templateRRCompletedCustomer({req}));
        break;
      case 'reminder_admin':
        await send(ADMIN, `⏰ 24hr Reminder: ${T} Request Still Pending — ${req.request_id}`, templateRRReminder24Admin({req}));
        break;
      case 'reminder_vendor':
        if (vendorEmail) await send(vendorEmail, `⏰ Action Needed: Approved ${T} Not Yet Arranged — ${req.request_id}`, templateRRReminder24Vendor({req}));
        break;
    }
  } catch(e) { console.error('RR email error:', e.message); }
}

// ── 24hr reminder cron ────────────────────────────────────────────────────
async function rrReminderCron() {
  try {
    const ago24 = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    // Pending > 24hrs — remind admin
    const pendingOld = await mdb.collection('return_requests').find({
      status: 'pending', created_at: { $lt: ago24 }, reminder_sent_pending: { $ne: true }
    }).toArray();
    for (const r of pendingOld) {
      await sendRREmail('reminder_admin', r);
      await mdb.collection('return_requests').updateOne({ request_id: r.request_id }, { $set: { reminder_sent_pending: true } });
    }
    // Approved > 24hrs — remind vendor
    const approvedOld = await mdb.collection('return_requests').find({
      status: 'approved', updated_at: { $lt: ago24 }, reminder_sent_approved: { $ne: true }
    }).toArray();
    for (const r of approvedOld) {
      await sendRREmail('reminder_vendor', r);
      await mdb.collection('return_requests').updateOne({ request_id: r.request_id }, { $set: { reminder_sent_approved: true } });
    }
    if (pendingOld.length + approvedOld.length > 0)
      console.log(`📧 RR reminders sent: ${pendingOld.length} admin, ${approvedOld.length} vendor`);
  } catch(e) { console.error('RR reminder cron error:', e.message); }
}
setTimeout(rrReminderCron, 90000);
setInterval(rrReminderCron, 3600000);

// ══════════════════════════════════════════════════════════════════════════
// RETURN / EXCHANGE SYSTEM
// ══════════════════════════════════════════════════════════════════════════

// ── Serve track.html ──────────────────────────────────────────────────────
app.get("/track", (req, res) => {
  res.sendFile(require('path').join(__dirname, 'track.html'));
});

// ── Public: lookup order by order number + email ──────────────────────────
// normalize phone: strip all non-digits, remove leading country code 91
function normalizePhone(p='') {
  const d = p.replace(/\D/g,'');
  return d.startsWith('91') && d.length > 10 ? d.slice(2) : d;
}

async function buildOrderPayload(order) {
  const meta = await mdb.collection('order_meta').findOne({ shopify_id: String(order.id) }, { projection: { _id: 0 } }) || {};
  const vendorStages = await mdb.collection('order_vendor_stage').find({ shopify_id: String(order.id) }, { projection: { _id: 0 } }).toArray();
  const vendorNames = [...new Set((order.line_items || []).map(li => li.vendor).filter(Boolean))];
  const returnConfigs = {};
  for (const v of vendorNames) {
    const cfg = await mdb.collection('vendor_return_config').findOne({ vendor_name: v }, { projection: { _id: 0 } }) || {};
    returnConfigs[v] = { exchange_enabled: true, return_enabled: cfg.return_enabled !== false, return_window_days: cfg.return_window_days || 7, return_address: cfg.return_address || null };
  }
  const items = (order.line_items || []).map(li => ({
    line_item_id: li.id, product_id: li.product_id, variant_id: li.variant_id,
    title: li.title, variant_title: li.variant_title, sku: li.sku,
    qty: li.quantity, price: li.price, vendor: li.vendor || '',
  }));
  const stage = meta.stage || 'new';
  let awb = null, trackingUrl = null;
  for (const f of (order.fulfillments || [])) { if (f.tracking_number) { awb = f.tracking_number; trackingUrl = f.tracking_url || null; break; } }
  const customerName = order.shipping_address
    ? `${order.shipping_address.first_name||''} ${order.shipping_address.last_name||''}`.trim()
    : order.customer ? `${order.customer.first_name||''} ${order.customer.last_name||''}`.trim() : '';
  return {
    shopify_order_id: order.id, order_name: order.name, customer_name: customerName,
    customer_email: order.email || '', customer_phone: order.shipping_address?.phone || order.billing_address?.phone || order.phone || '',
    stage, financial_status: order.financial_status, fulfillment_status: order.fulfillment_status,
    created_at: order.created_at, awb, tracking_url: trackingUrl, items, vendor_names: vendorNames, return_configs: returnConfigs,
  };
}

app.get("/track/order", async (req, res) => {
  try {
    const { q, contact } = req.query;
    if (!q) return res.status(400).json({ error: "Order number is required" });
    if (!contact || (!contact.trim() && contact.trim().toLowerCase() !== 'na'))
      return res.status(400).json({ error: "Email or mobile number is required" });

    const normalized = q.replace(/^#/, '').trim();
    const name = `#${normalized}`;

    const data = await shopifyREST(`/orders.json?name=${encodeURIComponent(name)}&status=any&limit=10`);
    const orders = data.orders || [];

    // If contact is "na" or empty — return by order number only (no identity check)
    const skipContact = !contact || contact.trim().toLowerCase() === 'na';
    let order;
    if (skipContact) {
      order = orders[0];
    } else {
      const contactClean = contact.toLowerCase().trim();
      const contactPhone = normalizePhone(contact);
      order = orders.find(o => {
        const oEmail = (o.email || o.contact_email || o.billing_address?.email || '').toLowerCase().trim();
        const oPhone = normalizePhone(o.shipping_address?.phone || o.billing_address?.phone || o.phone || '');
        return oEmail === contactClean || (contactPhone.length >= 10 && oPhone === contactPhone);
      });
    }

    if (!order) return res.status(404).json({ error: "Order not found. Please check the order number and your contact details." });

    // Get meta (stage, AWB etc.)
    res.json(await buildOrderPayload(order));
  } catch (err) {
    console.error("❌ /track/order:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Public: find all orders by email or phone ─────────────────────────────
app.get("/track/my-orders", async (req, res) => {
  try {
    const { contact } = req.query;
    if (!contact || contact.trim().length < 5) return res.status(400).json({ error: "Please enter a valid email or phone number." });

    const contactClean = contact.trim().toLowerCase();
    const contactPhone = normalizePhone(contact);
    const isPhone = /^\d{7,}$/.test(contactPhone);

    // Fetch all orders and filter locally — Shopify's phone/email params are unreliable
    let allOrders = [];
    let page = await shopifyREST(`/orders.json?status=any&limit=250`);
    allOrders = allOrders.concat(page.orders || []);
    // follow pagination if needed (up to 1000 recent orders)
    for (let i = 0; i < 3 && (page.orders||[]).length === 250; i++) {
      const lastId = page.orders[page.orders.length - 1]?.id;
      if (!lastId) break;
      page = await shopifyREST(`/orders.json?status=any&limit=250&since_id=${lastId}`);
      allOrders = allOrders.concat(page.orders || []);
    }

    const shopifyOrders = allOrders.filter(o => {
      const oEmail = (o.email || o.contact_email || '').toLowerCase().trim();
      const oPhone = normalizePhone(o.shipping_address?.phone || o.billing_address?.phone || o.phone || '');
      if (isPhone) return oPhone === contactPhone && contactPhone.length >= 7;
      return oEmail === contactClean && contactClean.includes('@');
    });

    if (!shopifyOrders.length) return res.status(404).json({ error: "No orders found for this contact." });

    // Get meta for all orders
    const ids = shopifyOrders.map(o => String(o.id));
    const metas = await mdb.collection('order_meta').find({ shopify_id: { $in: ids } }, { projection: { shopify_id:1, stage:1, _id:0 } }).toArray();
    const metaMap = Object.fromEntries(metas.map(m => [m.shopify_id, m]));

    const result = shopifyOrders.slice(0, 20).map(o => {
      const meta = metaMap[String(o.id)] || {};
      const customerName = o.shipping_address
        ? `${o.shipping_address.first_name||''} ${o.shipping_address.last_name||''}`.trim()
        : o.customer ? `${o.customer.first_name||''} ${o.customer.last_name||''}`.trim() : '';
      return {
        shopify_order_id: o.id,
        order_name: o.name,
        customer_name: customerName,
        created_at: o.created_at,
        stage: meta.stage || 'new',
        financial_status: o.financial_status,
        item_count: (o.line_items||[]).reduce((s,li)=>s+li.quantity,0),
        items_preview: (o.line_items||[]).slice(0,2).map(li=>li.title).join(', '),
        total: o.total_price,
        currency: o.currency,
      };
    });

    res.json({ orders: result });
  } catch (err) {
    console.error("❌ /track/my-orders:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Public: get single order by shopify ID (after customer selects from list) ──
app.get("/track/order-by-id", async (req, res) => {
  try {
    const { id } = req.query;
    if (!id) return res.status(400).json({ error: "id required" });
    const data = await shopifyREST(`/orders/${id}.json`);
    if (!data.order) return res.status(404).json({ error: "Order not found" });
    res.json(await buildOrderPayload(data.order));
  } catch (err) {
    console.error("❌ /track/order-by-id:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Public: get product variants for exchange ─────────────────────────────
app.get("/track/product/:productId/variants", async (req, res) => {
  try {
    const data = await shopifyREST(`/products/${req.params.productId}.json?fields=id,title,variants`);
    const variants = (data.product?.variants || []).map(v => ({
      id: v.id,
      title: v.title,
      sku: v.sku,
      // If inventory_management is null/blank, tracking is OFF → always available
      available: !v.inventory_management || v.inventory_quantity > 0,
    }));
    res.json({ variants });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Batch product images — ?ids=pid1,pid2,pid3 (adminAuth) ───────────────
app.get("/admin/product-images", adminAuth, async (req, res) => {
  try {
    const ids = (req.query.ids || '').split(',').map(s=>s.trim()).filter(Boolean);
    if (!ids.length) return res.json({ images: {} });
    const imageMap = {};
    await Promise.all(ids.map(async pid => {
      try {
        const d = await shopifyREST(`/products/${pid}.json?fields=id,image,images`);
        const src = d.product?.image?.src || d.product?.images?.[0]?.src || null;
        if (src) imageMap[pid] = src;
      } catch {}
    }));
    res.json({ images: imageMap });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Same for vendor
app.get("/vendor/product-images", vendorAuth, async (req, res) => {
  try {
    const ids = (req.query.ids || '').split(',').map(s=>s.trim()).filter(Boolean);
    if (!ids.length) return res.json({ images: {} });
    const imageMap = {};
    await Promise.all(ids.map(async pid => {
      try {
        const d = await shopifyREST(`/products/${pid}.json?fields=id,image,images`);
        const src = d.product?.image?.src || d.product?.images?.[0]?.src || null;
        if (src) imageMap[pid] = src;
      } catch {}
    }));
    res.json({ images: imageMap });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Public: submit return/exchange request ────────────────────────────────
app.post("/track/request", async (req, res) => {
  try {
    const { shopify_order_id, order_name, customer_email, customer_name, customer_phone, type, items, reason, vendor_name } = req.body;

    if (!shopify_order_id || !type || !items?.length || !reason) {
      return res.status(400).json({ error: "Missing required fields" });
    }
    if (!['return', 'exchange'].includes(type)) {
      return res.status(400).json({ error: "type must be 'return' or 'exchange'" });
    }

    const now = new Date();
    const datePart = now.toISOString().slice(0, 10).replace(/-/g, '');
    const rand = String(Math.floor(Math.random() * 9000) + 1000);
    const request_id = `RR-${datePart}-${rand}`;

    const doc = {
      request_id,
      shopify_order_id: String(shopify_order_id),
      order_name: order_name || '',
      customer_email: customer_email.toLowerCase().trim(),
      customer_name: customer_name || '',
      customer_phone: customer_phone || '',
      type,
      items,
      reason,
      status: 'pending',
      vendor_name: vendor_name || '',
      created_at: now.toISOString(),
      admin_note: '',
      vendor_note: '',
    };

    await mdb.collection('return_requests').insertOne(doc);

    // Create indexes on first use
    mdb.collection('return_requests').createIndex({ request_id: 1 }, { unique: true }).catch(() => {});
    mdb.collection('return_requests').createIndex({ vendor_name: 1, status: 1 }).catch(() => {});
    mdb.collection('return_requests').createIndex({ customer_email: 1 }).catch(() => {});

    sendRREmail('submitted', doc).catch(() => {});

    res.json({ success: true, request_id });
  } catch (err) {
    console.error("❌ /track/request:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Admin: list all return requests ──────────────────────────────────────
app.get("/admin/return-requests", adminAuth, async (req, res) => {
  try {
    const { status } = req.query;
    const q = status && status !== 'all' ? { status } : {};
    const requests = await mdb.collection('return_requests').find(q, { projection: { _id: 0 } }).sort({ created_at: -1 }).toArray();
    res.json({ requests });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Admin: update return request status / notes ───────────────────────────
app.put("/admin/return-requests/:id", adminAuth, async (req, res) => {
  try {
    const { status, admin_note } = req.body;
    const update = { updated_at: new Date().toISOString() };
    if (status) update.status = status;
    if (admin_note !== undefined) update.admin_note = admin_note;
    await mdb.collection('return_requests').updateOne({ request_id: req.params.id }, { $set: update });
    if (status) {
      const updated = await mdb.collection('return_requests').findOne({ request_id: req.params.id }, { projection: { _id: 0 } });
      if (updated) {
        const emailType = { approved: 'approved_by_admin', rejected: 'rejected', pickup: 'pickup', in_transit: 'in_transit', completed: 'completed' }[status];
        if (emailType) sendRREmail(emailType, updated).catch(() => {});
      }
    }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Shared: create reverse/forward shipment for a return/exchange request ─
async function createRRShipment({ rr, direction, partner, creds, weight, length, breadth, height, warehouseId, warehouseName }) {
  // direction: 'reverse' = customer→vendor (pickup from customer)
  //            'forward' = vendor→customer (send exchange item out)
  const isReverse = direction === 'reverse';

  // Addresses
  const customerAddr = {
    name:     rr.customer_name || 'Customer',
    address1: rr.customer_address1 || '',
    address2: rr.customer_address2 || '',
    city:     rr.customer_city    || '',
    state:    rr.customer_state   || '',
    zip:      rr.customer_pincode || rr.customer_zip || '',
    phone:    rr.customer_phone   || '',
    email:    rr.customer_email   || '',
  };
  const vendorAddr = {
    name:     creds.company_name  || rr.vendor_name || 'Vendor',
    address1: creds.return_address || creds.pickup_address || '',
    city:     creds.return_city   || creds.pickup_city   || '',
    state:    creds.return_state  || creds.pickup_state  || '',
    zip:      creds.return_pincode|| creds.pickup_pincode|| '',
    phone:    creds.return_phone  || creds.pickup_phone  || '',
  };

  const pickup   = isReverse ? customerAddr : vendorAddr;
  const delivery = isReverse ? vendorAddr   : customerAddr;

  const orderId  = `${rr.request_id}-${direction.toUpperCase()[0]}`;
  const desc     = (rr.items||[]).map(it=>it.title).join(', ').slice(0,250) || 'Return/Exchange items';
  const itemVal  = (rr.items||[]).reduce((s,it)=>s+parseFloat(it.price||0)*it.qty,0);

  if (partner === 'shiprocket') {
    const authRes = await fetch('https://apiv2.shiprocket.in/v1/external/auth/login', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ email: creds.email, password: creds.password }),
    }).then(r=>r.json());
    if (!authRes.token) throw new Error('Shiprocket auth failed. Check credentials.');

    const payload = {
      order_id:                orderId,
      order_date:              new Date().toISOString(),
      pickup_location:         warehouseName || warehouseId || creds.pickup_location || 'Primary',
      billing_customer_name:   pickup.name.split(' ')[0] || 'Customer',
      billing_last_name:       pickup.name.split(' ').slice(1).join(' ') || '',
      billing_address:         pickup.address1,
      billing_address_2:       pickup.address2 || '',
      billing_city:            pickup.city,
      billing_pincode:         String(pickup.zip||''),
      billing_state:           pickup.state,
      billing_country:         'India',
      billing_email:           pickup.email || '',
      billing_phone:           (pickup.phone||'').replace(/\D/g,'').slice(-10),
      shipping_is_billing:     true,
      order_items: (rr.items||[]).map(it=>({ name: it.title, sku: it.line_item_id||it.title.slice(0,40), units: it.qty, selling_price: parseFloat(it.price||0) })),
      payment_method: 'Prepaid',
      sub_total: itemVal,
      length, breadth, height, weight,
    };
    const srRes = await fetch('https://apiv2.shiprocket.in/v1/external/orders/create/adhoc', {
      method: 'POST', headers: {'Content-Type':'application/json','Authorization':`Bearer ${authRes.token}`},
      body: JSON.stringify(payload),
    }).then(r=>r.json());
    if (srRes.status_code === 1) return { awb: srRes.awb_code, courier: 'shiprocket' };
    throw new Error(srRes.message || JSON.stringify(srRes));

  } else if (partner === 'delhivery') {
    const orderDateStr = new Date().toISOString().replace('T',' ').replace(/\.\d+Z$/,'').replace('Z','');
    const warehouseNameFinal = warehouseName || warehouseId || creds.pickup_location || 'Primary';

    // In Delhivery's API, `add`/`city`/`pin`/`phone` is ALWAYS the customer (consignee).
    // `pickup_location.name` is always your registered warehouse.
    // For reverse: driver goes to customer (add), picks up, returns to warehouse (pickup_location).
    // For forward: driver goes from warehouse (pickup_location), delivers to customer (add).
    const custAddr  = isReverse ? pickup   : delivery;   // customer is always the "add" side
    const custPhone = (custAddr.phone||'').replace(/\D/g,'').slice(-10) || '9999999999';
    // return_* fields = warehouse address (fallback if consignee refuses)
    const wh = vendorAddr;
    const whPhone = (wh.phone||'').replace(/\D/g,'').slice(-10) || (creds.return_phone||'').replace(/\D/g,'').slice(-10) || '9999999999';

    const shipData = {
      pickup_location: { name: warehouseNameFinal },
      shipments: [{
        name:          custAddr.name    || rr.customer_name || 'Customer',
        add:           custAddr.address1|| '',
        add2:          custAddr.address2|| '',
        pin:           String(custAddr.zip||custAddr.pincode||''),
        city:          custAddr.city    || '',
        state:         custAddr.state   || '',
        country:       'India',
        phone:         custPhone,
        order:         orderId,
        payment_mode:  isReverse ? 'Pickup' : 'Pre-paid',
        return_pin:    String(wh.zip||wh.pincode||''),
        return_city:   wh.city    || '',
        return_phone:  whPhone,
        return_name:   wh.name    || '',
        return_add:    wh.address1|| '',
        return_state:  wh.state   || '',
        return_country:'India',
        products_desc: desc,
        hsn_code:      '',
        cod_amount:    '',
        order_date:    orderDateStr,
        total_amount:  itemVal,
        seller_inv:    orderId,
        quantity:      String((rr.items||[]).reduce((s,it)=>s+it.qty,0)||1),
        shipment_length: String(length),
        shipment_width:  String(breadth),
        shipment_height: String(height),
        weight:          String(weight),
        seller_name:   vendorAddr.name,
        seller_add:    vendorAddr.address1  || '',
        seller_city:   vendorAddr.city      || '',
        seller_state:  vendorAddr.state     || '',
        seller_pin:    String(vendorAddr.zip||''),
        seller_country:'India',
      }],
    };
    const dlBody = new URLSearchParams();
    dlBody.append('format','json');
    dlBody.append('data', JSON.stringify(shipData));
    const dlRes = await fetch('https://track.delhivery.com/api/cmu/create.json', {
      method:'POST', headers:{'Authorization':`Token ${creds.api_token}`,'Content-Type':'application/x-www-form-urlencoded'},
      body: dlBody.toString(),
    }).then(r=>r.json());
    if (dlRes.packages?.[0]?.waybill) return { awb: dlRes.packages[0].waybill, courier: 'delhivery' };
    throw new Error(dlRes.packages?.[0]?.remarks || dlRes.rmk || JSON.stringify(dlRes));

  } else if (partner === 'shipmozo') {
    if (!creds.public_key || !(creds.private_key||creds.api_key)) throw new Error('ShipMozo public and private keys required.');
    const smHeaders = {'Content-Type':'application/json','public-key':creds.public_key,'private-key':creds.private_key||creds.api_key};
    const smPayload = {
      order_id:                   orderId,
      order_date:                 new Date().toISOString().slice(0,10),
      consignee_name:             delivery.name,
      consignee_phone:            (delivery.phone||'').replace(/\D/g,'').slice(-10),
      consignee_email:            delivery.email || '',
      consignee_address_line_one: delivery.address1 || '',
      consignee_address_line_two: delivery.address2 || '',
      consignee_pin_code:         String(delivery.zip||''),
      consignee_city:             delivery.city  || '',
      consignee_state:            delivery.state || '',
      product_detail:             desc,
      payment_type:               'PREPAID',
      cod_amount:                 '0',
      weight:                     String(Math.round(parseFloat(weight)*1000)),
      length: String(length), width: String(breadth), height: String(height),
      ...(warehouseId || creds.warehouse_id ? { warehouse_id: warehouseId || creds.warehouse_id } : {}),
    };
    const safeJson = async (p) => { const r = await p; const t = await r.text(); try { return {ok:r.ok,data:JSON.parse(t)}; } catch { return {ok:false,data:null,raw:t.slice(0,400)}; } };
    const push = await safeJson(fetch('https://shipping-api.com/api/v1/push-order',{method:'POST',headers:smHeaders,body:JSON.stringify(smPayload)}));
    if (!push.data) throw new Error('ShipMozo non-JSON: '+(push.raw||''));
    const smOrderId = push.data?.order_id || push.data?.data?.order_id;
    if (!smOrderId && !push.ok) throw new Error(push.data?.message || JSON.stringify(push.data));
    const assign = await safeJson(fetch('https://shipping-api.com/api/v1/auto-assign-order',{method:'POST',headers:smHeaders,body:JSON.stringify({order_id:smOrderId})}));
    const awbNum = assign.data?.awb_number || assign.data?.data?.awb_number || push.data?.awb_number;
    if (awbNum) return { awb: awbNum, courier: 'shipmozo' };
    throw new Error(`ShipMozo order pushed (ID:${smOrderId}) but AWB not yet assigned.`);
  }
  throw new Error('Unknown partner: ' + partner);
}

// ── Shared: fetch warehouses/pickup locations from a shipping partner ────────
function credsToWarehouses(creds) {
  // Saved pickup_locations array (managed on settings page) — always authoritative
  if (Array.isArray(creds.pickup_locations) && creds.pickup_locations.length) {
    return creds.pickup_locations.map(l => ({
      id: l.name, name: l.name,
      address: [l.address, l.city, l.state, l.pincode].filter(Boolean).join(', '),
    }));
  }
  // Fall back to the single pickup_location string saved in credentials
  const name = creds.pickup_location || creds.return_city || 'Primary';
  const address = [creds.return_address, creds.return_city, creds.return_state, creds.return_pincode].filter(Boolean).join(', ');
  return [{ id: name, name, address }];
}

async function fetchPartnerWarehouses(partner, creds) {
  // Delhivery: warehouse list API is on their internal portal (not accessible via standard token)
  // Use saved locations managed on the settings page
  if (partner === 'delhivery') {
    return credsToWarehouses(creds);
  }

  if (partner === 'shiprocket') {
    try {
      const authRes = await fetch('https://apiv2.shiprocket.in/v1/external/auth/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: creds.email, password: creds.password }),
      }).then(r => r.json());
      if (authRes.token) {
        const data = await fetch('https://apiv2.shiprocket.in/v1/external/settings/company/pickup', {
          headers: { 'Authorization': `Bearer ${authRes.token}` },
        }).then(r => r.json());
        const locs = data?.data?.shipping_address || data?.shipping_address || [];
        if (locs.length) {
          return locs.map(l => ({
            id:      String(l.pickup_location || l.id || ''),
            name:    l.pickup_location || l.warehouse_name || '',
            address: [l.address, l.city, l.state, l.pin_code].filter(Boolean).join(', '),
          })).filter(l => l.name);
        }
      }
    } catch {}
  }

  return credsToWarehouses(creds);
}

app.get("/admin/shipping/warehouses", adminAuth, async (req, res) => {
  const { partner } = req.query;
  if (!partner) return res.status(400).json({ error: 'partner required' });
  try {
    const credRow = await mdb.collection('global_shipping_creds').findOne({ partner });
    if (!credRow) return res.status(404).json({ error: `${partner} not connected` });
    const creds = JSON.parse(credRow.credentials);
    const warehouses = await fetchPartnerWarehouses(partner, creds);
    res.json({ warehouses });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/vendor/shipping/warehouses", vendorAuth, async (req, res) => {
  const { partner } = req.query;
  if (!partner) return res.status(400).json({ error: 'partner required' });
  try {
    const credRow = await mdb.collection('vendor_shipping_partners').findOne({ vendor_name: req.vendor, partner, active: 1 });
    if (!credRow) return res.status(404).json({ error: `${partner} not connected` });
    const creds = JSON.parse(credRow.credentials);
    const warehouses = await fetchPartnerWarehouses(partner, creds);
    res.json({ warehouses });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Admin: create shipment for return/exchange request ─────────────────────
app.post("/admin/return-requests/:id/create-shipment", adminAuth, async (req, res) => {
  try {
    const { direction, partner, weight = 0.5, length = 15, breadth = 12, height = 8, warehouseId, warehouseName } = req.body || {};
    if (!direction || !partner) return res.status(400).json({ error: 'direction and partner required' });
    if (!['reverse','forward'].includes(direction)) return res.status(400).json({ error: 'direction must be reverse or forward' });

    const rr = await mdb.collection('return_requests').findOne({ request_id: req.params.id }, { projection: { _id: 0 } });
    if (!rr) return res.status(404).json({ error: 'Request not found' });
    if (direction === 'forward' && rr.type !== 'exchange') return res.status(400).json({ error: 'Forward shipment only valid for exchange requests' });

    // Get creds — admin uses global_shipping_creds
    const credRow = await mdb.collection('global_shipping_creds').findOne({ partner });
    if (!credRow) return res.status(404).json({ error: `${partner} not connected. Go to Shipping Settings.` });
    const creds = JSON.parse(credRow.credentials);

    // For reverse, also pull customer address from Shopify order if not on RR doc
    if (!rr.customer_address1 || !rr.customer_phone) {
      try {
        const { order } = await shopifyREST(`/orders/${rr.shopify_order_id}.json?fields=id,shipping_address,billing_address,phone`);
        if (order) {
          const sa = order.shipping_address || order.billing_address || {};
          rr.customer_address1 = rr.customer_address1 || sa.address1 || '';
          rr.customer_address2 = rr.customer_address2 || sa.address2 || '';
          rr.customer_city     = rr.customer_city     || sa.city     || '';
          rr.customer_state    = rr.customer_state    || sa.province || '';
          rr.customer_pincode  = rr.customer_pincode  || sa.zip      || '';
          rr.customer_phone    = rr.customer_phone    || sa.phone || order.phone || '';
        }
      } catch {}
    }

    const result = await createRRShipment({ rr, direction, partner, creds, weight, length, breadth, height, warehouseId, warehouseName });

    // Save AWB to return_request doc
    const field = direction === 'reverse' ? 'reverse_shipment' : 'forward_shipment';
    await mdb.collection('return_requests').updateOne(
      { request_id: req.params.id },
      { $set: { [field]: { awb: result.awb, courier: result.courier, partner, created_at: new Date().toISOString() }, updated_at: new Date().toISOString() } }
    );
    res.json({ success: true, awb: result.awb, courier: result.courier });
  } catch (err) {
    console.error('❌ admin create-shipment RR:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Vendor: create shipment for return/exchange request ────────────────────
app.post("/vendor/return-requests/:id/create-shipment", vendorAuth, async (req, res) => {
  try {
    const { direction, partner, weight = 0.5, length = 15, breadth = 12, height = 8, warehouseId, warehouseName } = req.body || {};
    if (!direction || !partner) return res.status(400).json({ error: 'direction and partner required' });
    if (!['reverse','forward'].includes(direction)) return res.status(400).json({ error: 'direction must be reverse or forward' });

    const rr = await mdb.collection('return_requests').findOne({ request_id: req.params.id, vendor_name: req.vendor }, { projection: { _id: 0 } });
    if (!rr) return res.status(404).json({ error: 'Request not found' });
    if (direction === 'forward' && rr.type !== 'exchange') return res.status(400).json({ error: 'Forward shipment only valid for exchange requests' });

    // Get creds — vendor uses vendor_shipping_partners
    const credRow = await mdb.collection('vendor_shipping_partners').findOne({ vendor_name: req.vendor, partner, active: 1 });
    if (!credRow) return res.status(404).json({ error: `${partner} not connected. Go to Shipping Settings.` });
    const creds = JSON.parse(credRow.credentials);

    if (!rr.customer_address1 || !rr.customer_phone) {
      try {
        const { order } = await shopifyREST(`/orders/${rr.shopify_order_id}.json?fields=id,shipping_address,billing_address,phone`);
        if (order) {
          const sa = order.shipping_address || order.billing_address || {};
          rr.customer_address1 = rr.customer_address1 || sa.address1 || '';
          rr.customer_address2 = rr.customer_address2 || sa.address2 || '';
          rr.customer_city     = rr.customer_city     || sa.city     || '';
          rr.customer_state    = rr.customer_state    || sa.province || '';
          rr.customer_pincode  = rr.customer_pincode  || sa.zip      || '';
          rr.customer_phone    = rr.customer_phone    || sa.phone || order.phone || '';
        }
      } catch {}
    }

    const result = await createRRShipment({ rr, direction, partner, creds, weight, length, breadth, height, warehouseId, warehouseName });

    const field = direction === 'reverse' ? 'reverse_shipment' : 'forward_shipment';
    await mdb.collection('return_requests').updateOne(
      { request_id: req.params.id, vendor_name: req.vendor },
      { $set: { [field]: { awb: result.awb, courier: result.courier, partner, created_at: new Date().toISOString() }, updated_at: new Date().toISOString() } }
    );
    res.json({ success: true, awb: result.awb, courier: result.courier });
  } catch (err) {
    console.error('❌ vendor create-shipment RR:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Admin: get vendor return config ──────────────────────────────────────
app.get("/admin/vendors/:name/return-config", adminAuth, async (req, res) => {
  try {
    const cfg = await mdb.collection('vendor_return_config').findOne({ vendor_name: req.params.name }, { projection: { _id: 0 } }) || {};
    res.json({ config: { exchange_enabled: true, return_enabled: true, return_window_days: 7, return_address: {}, ...cfg } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Admin: save vendor return config ─────────────────────────────────────
app.put("/admin/vendors/:name/return-config", adminAuth, async (req, res) => {
  try {
    const { return_enabled, return_window_days, return_address } = req.body;
    await mdb.collection('vendor_return_config').updateOne(
      { vendor_name: req.params.name },
      { $set: { vendor_name: req.params.name, exchange_enabled: true, return_enabled: !!return_enabled, return_window_days: parseInt(return_window_days) || 7, return_address: return_address || {}, updated_at: new Date().toISOString() } },
      { upsert: true }
    );
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Vendor: list own return requests ─────────────────────────────────────
app.get("/vendor/return-requests", vendorAuth, async (req, res) => {
  try {
    const { status } = req.query;
    const q = { vendor_name: req.vendor };
    if (status && status !== 'all') q.status = status;
    const requests = await mdb.collection('return_requests').find(q, { projection: { _id: 0 } }).sort({ created_at: -1 }).toArray();
    res.json({ requests });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Vendor: update own return request ────────────────────────────────────
app.put("/vendor/return-requests/:id", vendorAuth, async (req, res) => {
  try {
    const { vendor_note, status } = req.body;
    const update = { updated_at: new Date().toISOString() };
    if (vendor_note !== undefined) update.vendor_note = vendor_note;
    if (status) update.status = status;
    await mdb.collection('return_requests').updateOne({ request_id: req.params.id, vendor_name: req.vendor }, { $set: update });
    if (status === 'approved') {
      const updated = await mdb.collection('return_requests').findOne({ request_id: req.params.id }, { projection: { _id: 0 } });
      if (updated) sendRREmail('approved_by_vendor', updated).catch(() => {});
    }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Vendor: get own return config ─────────────────────────────────────────
app.get("/vendor/return-config", vendorAuth, async (req, res) => {
  try {
    const cfg = await mdb.collection('vendor_return_config').findOne({ vendor_name: req.vendor }, { projection: { _id: 0 } }) || {};
    res.json({ config: { exchange_enabled: true, return_enabled: true, return_window_days: 7, return_address: {}, ...cfg } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Vendor: save own return config ────────────────────────────────────────
app.put("/vendor/return-config", vendorAuth, async (req, res) => {
  try {
    const { return_enabled, return_window_days, return_address } = req.body;
    await mdb.collection('vendor_return_config').updateOne(
      { vendor_name: req.vendor },
      { $set: { vendor_name: req.vendor, exchange_enabled: true, return_enabled: !!return_enabled, return_window_days: parseInt(return_window_days) || 7, return_address: return_address || {}, updated_at: new Date().toISOString() } },
      { upsert: true }
    );
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

