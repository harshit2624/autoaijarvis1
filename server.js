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
const Database   = require("better-sqlite3");
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
      mdb.collection("tag_mappings").createIndex({ tag: 1 }, { unique: true }),
      mdb.collection("global_shipping_creds").createIndex({ partner: 1 }, { unique: true }),
      mdb.collection("vendor_shipping_partners").createIndex({ vendor_name: 1, partner: 1 }, { unique: true }),
    mdb.collection("email_log").createIndex({ sent_at: -1 }),
    ];
    await Promise.all(idxOps.map(p => p.catch(()=>{})));

    await mongoRestoreToSQLite();
    setInterval(syncSQLiteToMongo, 3 * 60 * 1000);
  } catch (err) {
    console.warn("⚠️  MongoDB connection failed — starting with empty SQLite:", err.message);
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

// ── Tables to sync and their primary keys ─────────────────────────────────
const SYNC_TABLES = [
  { name: 'vendor_config',             pk: 'vendor_name' },
  { name: 'email_settings',            pk: 'id' },
  { name: 'order_meta',                pk: 'shopify_id' },
  { name: 'order_vendor_stage',        pk: null, compound: ['shopify_id','vendor_name'] },
  { name: 'vendor_shopify_connections',pk: 'vendor_name' },
  { name: 'vendor_product_mappings',   pk: null, compound: ['vendor_name','vendor_variant_id'] },
  { name: 'order_penalties',           pk: 'id' },
  { name: 'order_notes',               pk: 'id' },
  { name: 'delay_remarks',             pk: 'id' },
  { name: 'croscrow_profile',          pk: 'id' },
  { name: 'vendor_profiles',           pk: 'vendor_name' },
  { name: 'tag_mappings',              pk: 'tag' },
  { name: 'global_shipping_creds',     pk: 'partner' },
  { name: 'vendor_shipping_partners',  pk: null, compound: ['vendor_name','partner'] },
  { name: 'email_log',                 pk: 'id' },
];

async function mongoRestoreToSQLite() {
  if (!mdb) return;
  console.log("🔄  Restoring data from MongoDB → SQLite...");
  for (const t of SYNC_TABLES) {
    try {
      const docs = await mdb.collection(t.name).find({}, { projection: { _id: 0, _created: 0, _updated: 0 } }).toArray();
      if (!docs.length) continue;
      // Build INSERT OR REPLACE for each doc
      for (const doc of docs) {
        const keys = Object.keys(doc);
        const placeholders = keys.map(() => '?').join(',');
        const values = keys.map(k => doc[k]);
        try {
          db.prepare(`INSERT OR REPLACE INTO ${t.name} (${keys.join(',')}) VALUES (${placeholders})`).run(...values);
        } catch {}
      }
      console.log(`   ✓ ${t.name}: restored ${docs.length} records`);
    } catch (e) {
      console.warn(`   ⚠ ${t.name}: restore failed —`, e.message);
    }
  }
  console.log("✅  MongoDB restore complete");
}

async function syncSQLiteToMongo() {
  if (!mdb) return;
  for (const t of SYNC_TABLES) {
    try {
      const rows = db.prepare(`SELECT * FROM ${t.name}`).all();
      for (const row of rows) {
        let filter;
        if (t.pk) {
          filter = { [t.pk]: row[t.pk] };
        } else {
          filter = Object.fromEntries(t.compound.map(k => [k, row[k]]));
        }
        await mdb.collection(t.name).updateOne(filter, { $set: { ...row, _updated: new Date() } }, { upsert: true });
      }
    } catch {}
  }
}

// ── MongoDB primary helpers (Section 1 migration) ─────────────────────────
// mCol(name) returns a MongoDB collection. All migrated tables use these.
const mCol = (name) => mdb.collection(name);

// vendor_config: MongoDB primary, SQLite as fallback cache
const VC = {
  async all() {
    if (mdb) return mdb.collection('vendor_config').find({}, { projection: { _id: 0 } }).toArray();
    return db.prepare("SELECT * FROM vendor_config").all();
  },
  async get(vendor_name) {
    if (mdb) return mdb.collection('vendor_config').findOne({ vendor_name }, { projection: { _id: 0 } });
    return db.prepare("SELECT * FROM vendor_config WHERE vendor_name=?").get(vendor_name);
  },
  async upsert(vendor_name, fields) {
    if (mdb) {
      await mdb.collection('vendor_config').updateOne({ vendor_name }, { $set: { vendor_name, ...fields, _updated: new Date() } }, { upsert: true });
    }
    // Keep SQLite in sync
    const existing = db.prepare("SELECT * FROM vendor_config WHERE vendor_name=?").get(vendor_name);
    if (existing) {
      const setClauses = Object.keys(fields).map(k => `${k}=?`).join(',');
      db.prepare(`UPDATE vendor_config SET ${setClauses} WHERE vendor_name=?`).run(...Object.values(fields), vendor_name);
    } else {
      const allFields = { vendor_name, ...fields };
      const keys = Object.keys(allFields);
      db.prepare(`INSERT OR IGNORE INTO vendor_config (${keys.join(',')}) VALUES (${keys.map(()=>'?').join(',')})`).run(...Object.values(allFields));
    }
  },
};

// email_settings: MongoDB primary
const ES = {
  async get() {
    if (mdb) return mdb.collection('email_settings').findOne({}, { projection: { _id: 0 } });
    return db.prepare("SELECT * FROM email_settings LIMIT 1").get();
  },
  async save(fields) {
    if (mdb) {
      await mdb.collection('email_settings').updateOne({}, { $set: { ...fields, _updated: new Date() } }, { upsert: true });
    }
    // Sync SQLite
    const existing = db.prepare("SELECT id FROM email_settings LIMIT 1").get();
    if (existing) {
      const setClauses = Object.keys(fields).map(k => `${k}=?`).join(',');
      db.prepare(`UPDATE email_settings SET ${setClauses} WHERE id=?`).run(...Object.values(fields), existing.id);
    } else {
      const keys = Object.keys(fields);
      db.prepare(`INSERT INTO email_settings (${keys.join(',')}) VALUES (${keys.map(()=>'?').join(',')})`).run(...Object.values(fields));
    }
  },
};

// ── order_meta: MongoDB primary for writes, SQLite for bulk reads ──────────
const OM = {
  async upsert(shopify_id, fields) {
    const sid = String(shopify_id);
    if (mdb) {
      await mdb.collection('order_meta').updateOne(
        { shopify_id: sid },
        { $set: { shopify_id: sid, ...fields, _updated: new Date() } },
        { upsert: true }
      );
    }
    // Keep SQLite in sync
    const existing = db.prepare("SELECT shopify_id FROM order_meta WHERE shopify_id=?").get(sid);
    if (existing) {
      const setClauses = Object.keys(fields).map(k => `${k}=?`).join(',');
      db.prepare(`UPDATE order_meta SET ${setClauses} WHERE shopify_id=?`).run(...Object.values(fields), sid);
    } else {
      const allF = { shopify_id: sid, ...fields };
      const keys = Object.keys(allF);
      db.prepare(`INSERT OR IGNORE INTO order_meta (${keys.join(',')}) VALUES (${keys.map(()=>'?').join(',')})`).run(...Object.values(allF));
    }
  },
};

// ── order_vendor_stage: MongoDB primary for writes ─────────────────────────
const OVS = {
  async upsert(shopify_id, vendor_name, fields) {
    const sid = String(shopify_id);
    if (mdb) {
      await mdb.collection('order_vendor_stage').updateOne(
        { shopify_id: sid, vendor_name },
        { $set: { shopify_id: sid, vendor_name, ...fields, _updated: new Date() } },
        { upsert: true }
      );
    }
    // Keep SQLite in sync
    const existing = db.prepare("SELECT shopify_id FROM order_vendor_stage WHERE shopify_id=? AND vendor_name=?").get(sid, vendor_name);
    if (existing) {
      const setClauses = Object.keys(fields).map(k => `${k}=?`).join(',');
      db.prepare(`UPDATE order_vendor_stage SET ${setClauses} WHERE shopify_id=? AND vendor_name=?`).run(...Object.values(fields), sid, vendor_name);
    } else {
      const allF = { shopify_id: sid, vendor_name, ...fields };
      const keys = Object.keys(allF);
      db.prepare(`INSERT OR IGNORE INTO order_vendor_stage (${keys.join(',')}) VALUES (${keys.map(()=>'?').join(',')})`).run(...Object.values(allF));
    }
  },
};

// ── vendor_shopify_connections: MongoDB primary ────────────────────────────
const VSC = {
  async get(vendor_name) {
    if (mdb) return mdb.collection('vendor_shopify_connections').findOne({ vendor_name }, { projection: { _id: 0 } });
    return db.prepare("SELECT * FROM vendor_shopify_connections WHERE vendor_name=?").get(vendor_name);
  },
  async all() {
    if (mdb) return mdb.collection('vendor_shopify_connections').find({}, { projection: { _id: 0 } }).toArray();
    return db.prepare("SELECT * FROM vendor_shopify_connections").all();
  },
  async upsert(vendor_name, fields) {
    if (mdb) {
      await mdb.collection('vendor_shopify_connections').updateOne(
        { vendor_name }, { $set: { vendor_name, ...fields, _updated: new Date() } }, { upsert: true }
      );
    }
    const keys = ['vendor_name', ...Object.keys(fields)];
    const vals = [vendor_name, ...Object.values(fields)];
    db.prepare(`INSERT OR REPLACE INTO vendor_shopify_connections (${keys.join(',')}) VALUES (${keys.map(()=>'?').join(',')})`).run(...vals);
  },
  async delete(vendor_name) {
    if (mdb) await mdb.collection('vendor_shopify_connections').deleteOne({ vendor_name });
    db.prepare("DELETE FROM vendor_shopify_connections WHERE vendor_name=?").run(vendor_name);
  },
};

// ── vendor_product_mappings: MongoDB primary ───────────────────────────────
const VPM = {
  async allForVendor(vendor_name) {
    if (mdb) return mdb.collection('vendor_product_mappings').find({ vendor_name }, { projection: { _id: 0 } }).toArray();
    return db.prepare("SELECT * FROM vendor_product_mappings WHERE vendor_name=?").all(vendor_name);
  },
  async all(vendor_name) {
    if (mdb) {
      const q = vendor_name ? { vendor_name } : {};
      return mdb.collection('vendor_product_mappings').find(q, { projection: { _id: 0 } }).sort({ _id: -1 }).toArray();
    }
    const where = vendor_name ? "WHERE vendor_name=?" : "";
    const params = vendor_name ? [vendor_name] : [];
    return db.prepare(`SELECT * FROM vendor_product_mappings ${where} ORDER BY id DESC`).all(...params);
  },
  async upsert(vendor_name, vendor_variant_id, fields) {
    const vvid = String(vendor_variant_id);
    if (mdb) {
      await mdb.collection('vendor_product_mappings').updateOne(
        { vendor_name, vendor_variant_id: vvid },
        { $set: { vendor_name, vendor_variant_id: vvid, ...fields, _updated: new Date() } },
        { upsert: true }
      );
    }
    const allF = { vendor_name, vendor_variant_id: vvid, ...fields };
    const keys = Object.keys(allF);
    db.prepare(`INSERT OR REPLACE INTO vendor_product_mappings (${keys.join(',')}) VALUES (${keys.map(()=>'?').join(',')})`).run(...Object.values(allF));
  },
  async updateSynced(vendor_name, vendor_variant_id) {
    const vvid = String(vendor_variant_id);
    if (mdb) {
      await mdb.collection('vendor_product_mappings').updateOne(
        { vendor_name, vendor_variant_id: vvid }, { $set: { last_synced_at: Date.now(), _updated: new Date() } }
      );
    }
    db.prepare("UPDATE vendor_product_mappings SET last_synced_at=? WHERE vendor_name=? AND vendor_variant_id=?").run(Date.now(), vendor_name, vvid);
  },
  async delete(id) {
    if (mdb) await mdb.collection('vendor_product_mappings').deleteOne({ id: parseInt(id) });
    db.prepare("DELETE FROM vendor_product_mappings WHERE id=?").run(id);
  },
};

// ── order_notes: MongoDB primary ──────────────────────────────────────────
const ON = {
  async allFor(shopify_id) {
    if (mdb) return mdb.collection('order_notes').find({ shopify_id: String(shopify_id) }, { projection: { _id: 0 } }).sort({ created_at: 1 }).toArray();
    return db.prepare("SELECT * FROM order_notes WHERE shopify_id=? ORDER BY created_at ASC").all(String(shopify_id));
  },
  async insert(shopify_id, role, author, note) {
    const sid = String(shopify_id);
    const created_at = new Date().toISOString();
    if (mdb) await mdb.collection('order_notes').insertOne({ shopify_id: sid, role, author, note, created_at });
    db.prepare("INSERT INTO order_notes (shopify_id, role, author, note, created_at) VALUES (?,?,?,?,?)").run(sid, role, author, note, created_at);
  },
};

// ── delay_remarks: MongoDB primary ────────────────────────────────────────
const DR = {
  async allFor(shopify_id, vendor_name) {
    if (mdb) {
      const q = vendor_name ? { shopify_id: String(shopify_id), vendor_name } : { shopify_id: String(shopify_id) };
      return mdb.collection('delay_remarks').find(q, { projection: { _id: 0 } }).sort({ submitted_at: 1 }).toArray();
    }
    if (vendor_name) return db.prepare("SELECT * FROM delay_remarks WHERE shopify_id=? AND vendor_name=? ORDER BY submitted_at ASC").all(String(shopify_id), vendor_name);
    return db.prepare("SELECT * FROM delay_remarks WHERE shopify_id=? ORDER BY submitted_at ASC").all(String(shopify_id));
  },
  async latest(shopify_id, vendor_name) {
    if (mdb) return mdb.collection('delay_remarks').findOne({ shopify_id: String(shopify_id), vendor_name }, { projection: { _id: 0 }, sort: { submitted_at: -1 } });
    return db.prepare("SELECT * FROM delay_remarks WHERE shopify_id=? AND vendor_name=? ORDER BY submitted_at DESC LIMIT 1").get(String(shopify_id), vendor_name);
  },
  async insert(shopify_id, vendor_name, reason, eta_date) {
    const sid = String(shopify_id);
    const submitted_at = Date.now();
    if (mdb) await mdb.collection('delay_remarks').insertOne({ shopify_id: sid, vendor_name, reason, eta_date, submitted_at, eta_penalty_triggered: 0 });
    db.prepare("INSERT INTO delay_remarks (shopify_id, vendor_name, reason, eta_date, submitted_at, eta_penalty_triggered) VALUES (?,?,?,?,?,0)").run(sid, vendor_name, reason, eta_date, submitted_at);
  },
  async markEtaPenalty(id) {
    if (mdb) await mdb.collection('delay_remarks').updateOne({ id }, { $set: { eta_penalty_triggered: 1 } });
    db.prepare("UPDATE delay_remarks SET eta_penalty_triggered=1 WHERE id=?").run(id);
  },
  async expiredEta(today) {
    if (mdb) return mdb.collection('delay_remarks').find({ eta_date: { $lt: today }, eta_penalty_triggered: 0 }, { projection: { _id: 0 } }).toArray();
    return db.prepare("SELECT * FROM delay_remarks WHERE eta_date < ? AND eta_penalty_triggered=0").all(today);
  },
};

// ── order_penalties: MongoDB primary ──────────────────────────────────────
const OP = {
  async all(status) {
    if (mdb) {
      const q = status && status !== 'all' ? { status } : {};
      return mdb.collection('order_penalties').find(q, { projection: { _id: 0 } }).sort({ triggered_at: -1 }).toArray();
    }
    const where = status && status !== 'all' ? "WHERE status=?" : "";
    const params = status && status !== 'all' ? [status] : [];
    return db.prepare(`SELECT * FROM order_penalties ${where} ORDER BY triggered_at DESC`).all(...params);
  },
  async get(id) {
    if (mdb) return mdb.collection('order_penalties').findOne({ id: parseInt(id) }, { projection: { _id: 0 } });
    return db.prepare("SELECT * FROM order_penalties WHERE id=?").get(id);
  },
  async hasPending(shopify_id, vendor_name) {
    if (mdb) return !!(await mdb.collection('order_penalties').findOne({ shopify_id: String(shopify_id), vendor_name, status: 'pending' }));
    return !!db.prepare("SELECT id FROM order_penalties WHERE shopify_id=? AND vendor_name=? AND status='pending'").get(String(shopify_id), vendor_name);
  },
  async insert(shopify_id, vendor_name, order_name, trigger_reason) {
    const sid = String(shopify_id);
    const triggered_at = Date.now();
    if (mdb) await mdb.collection('order_penalties').insertOne({ shopify_id: sid, vendor_name, order_name: order_name || '', triggered_at, trigger_reason, status: 'pending' });
    db.prepare("INSERT INTO order_penalties (shopify_id, vendor_name, order_name, triggered_at, trigger_reason, status) VALUES (?,?,?,?,?,'pending')").run(sid, vendor_name, order_name || '', triggered_at, trigger_reason);
  },
  async resolve(id, status, penalty_amount, admin_note) {
    const resolved_at = Date.now();
    if (mdb) await mdb.collection('order_penalties').updateOne({ id: parseInt(id) }, { $set: { status, penalty_amount, admin_note: admin_note || '', resolved_at, resolved_by: 'admin' } });
    db.prepare("UPDATE order_penalties SET status=?, penalty_amount=?, admin_note=?, resolved_at=?, resolved_by='admin' WHERE id=?").run(status, penalty_amount, admin_note || '', resolved_at, id);
  },
};

const app = express();

app.use(express.static('.'));

// ── Raw body needed for webhook HMAC verification ──────────────────────────
app.use("/webhooks", express.raw({ type: "application/json" }));
app.use(express.json());

// ── Sync to MongoDB after every mutating request ──────────────────────────
const WRITE_METHODS = new Set(['POST','PUT','DELETE','PATCH']);
app.use((req, res, next) => {
  if (!WRITE_METHODS.has(req.method)) return next();
  const originalJson = res.json.bind(res);
  res.json = (body) => {
    originalJson(body);
    // Fire-and-forget sync after response sent
    setImmediate(() => syncSQLiteToMongo().catch(()=>{}));
  };
  next();
});

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

// ── MongoDB helpers — used when mdb is available ──────────────────────────
// These wrap common patterns so routes can call mdb or fall back to SQLite

async function mGet(collection, filter) {
  if (!mdb) return null;
  return mdb.collection(collection).findOne(filter);
}

async function mGetAll(collection, filter = {}, sort = {}) {
  if (!mdb) return null;
  return mdb.collection(collection).find(filter).sort(sort).toArray();
}

async function mUpsert(collection, filter, doc) {
  if (!mdb) return;
  await mdb.collection(collection).updateOne(filter, { $set: { ...doc, _updated: new Date() } }, { upsert: true });
}

async function mInsert(collection, doc) {
  if (!mdb) return null;
  const r = await mdb.collection(collection).insertOne({ ...doc, _created: new Date() });
  return r.insertedId;
}

async function mUpdate(collection, filter, update) {
  if (!mdb) return;
  await mdb.collection(collection).updateOne(filter, { $set: update });
}

async function mDelete(collection, filter) {
  if (!mdb) return;
  await mdb.collection(collection).deleteOne(filter);
}

async function mDeleteMany(collection, filter) {
  if (!mdb) return;
  await mdb.collection(collection).deleteMany(filter);
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
// ── Migrate: email enabled toggle
try { db.exec("ALTER TABLE email_settings ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1"); } catch {}

// ── Migrate: penalty tracking columns on order_vendor_stage
try { db.exec("ALTER TABLE order_vendor_stage ADD COLUMN stage_started_at INTEGER DEFAULT 0"); } catch {}
try { db.exec("ALTER TABLE order_vendor_stage ADD COLUMN warning_sent INTEGER DEFAULT 0"); } catch {}
try { db.exec("ALTER TABLE order_vendor_stage ADD COLUMN penalty_triggered INTEGER DEFAULT 0"); } catch {}
// Backfill stage_started_at for existing confirmed/partial rows with no timestamp
try { db.exec(`UPDATE order_vendor_stage SET stage_started_at=${Date.now()} WHERE stage IN ('confirmed','partial') AND (stage_started_at IS NULL OR stage_started_at=0)`); } catch {}

// ── Penalty & delay tables
db.exec(`
  CREATE TABLE IF NOT EXISTS order_penalties (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    shopify_id     TEXT NOT NULL,
    vendor_name    TEXT NOT NULL,
    order_name     TEXT DEFAULT '',
    triggered_at   INTEGER NOT NULL,
    trigger_reason TEXT DEFAULT '48hr_breach',
    status         TEXT DEFAULT 'pending',
    penalty_amount REAL DEFAULT 0,
    admin_note     TEXT DEFAULT '',
    resolved_at    INTEGER,
    resolved_by    TEXT
  );
  CREATE TABLE IF NOT EXISTS delay_remarks (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    shopify_id           TEXT NOT NULL,
    vendor_name          TEXT NOT NULL,
    reason               TEXT NOT NULL,
    eta_date             TEXT NOT NULL,
    submitted_at         INTEGER NOT NULL,
    eta_penalty_triggered INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS settlement_penalties (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    settlement_id INTEGER REFERENCES settlements(id),
    penalty_id    INTEGER REFERENCES order_penalties(id),
    amount        REAL NOT NULL
  );
`);
try { db.exec("ALTER TABLE settlements ADD COLUMN penalty_deduction REAL DEFAULT 0"); } catch {}

// ── Migrate: per-vendor stage tracking
db.exec(`
  CREATE TABLE IF NOT EXISTS order_vendor_stage (
    shopify_id   TEXT NOT NULL,
    vendor_name  TEXT NOT NULL,
    stage        TEXT NOT NULL DEFAULT 'new',
    updated_at   TEXT DEFAULT '',
    PRIMARY KEY (shopify_id, vendor_name)
  );
`);

// ── Tag mappings table ────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS tag_mappings (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    shopify_tag TEXT NOT NULL,
    stage       TEXT NOT NULL,
    priority    INTEGER DEFAULT 99,
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
  CREATE TABLE IF NOT EXISTS email_settings (
    id      INTEGER PRIMARY KEY CHECK (id = 1),
    smtp    TEXT NOT NULL DEFAULT '{}',
    enabled INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS email_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    shopify_id TEXT,
    trigger    TEXT,
    recipient  TEXT,
    subject    TEXT,
    status     TEXT,
    error      TEXT,
    sent_at    TEXT
  );
`);

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
  const mappings = db.prepare("SELECT * FROM tag_mappings ORDER BY priority ASC, id ASC").all();
  let winner = null;
  for (const m of mappings) {
    const hit = orderTags.find(t => t.toLowerCase() === m.shopify_tag.toLowerCase().trim());
    if (hit) { winner = m; break; }
  }
  if (winner) {
    const prev = db.prepare("SELECT stage FROM order_meta WHERE shopify_id=?").get(sid);
    await OM.upsert(sid, { stage: winner.stage, updated_at: now });
    if (!prev || prev.stage !== winner.stage) {
      fireStageEmails(sid, winner.stage).catch(()=>{});
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

  let payload = {};
  try { payload = JSON.parse(rawBody.toString()); } catch {}
  logWebhook(topic, payload);

  // Fire new-order email to customer as soon as order is created
  if (topic === 'orders/create' && payload.id && payload.email) {
    (async () => {
      try {
        const cfg = getSmtpConfig();
        if (!cfg?.host) return;
        const settingsRow = db.prepare("SELECT enabled FROM email_settings WHERE id=1").get();
        if (settingsRow && settingsRow.enabled === 0) return;
        const enrichedOrder = await enrichOrderImages(payload);
        const transporter = createTransporter(cfg);
        await transporter.sendMail({
          from: `"${cfg.fromName || 'CrosCrow'}" <${cfg.fromEmail || cfg.user}>`,
          to: payload.email,
          subject: `Your Order ${payload.name} — Please Confirm on WhatsApp`,
          html: templateNewOrderCustomer({ order: enrichedOrder }),
        });
        logEmail(payload.id, 'new_order_customer', payload.email, `Order ${payload.name} — Please Confirm on WhatsApp`, 'sent');
        console.log(`📧 New order email sent → ${payload.email}`);
      } catch(err) {
        logEmail(payload.id, 'new_order_customer', payload.email || '', '', 'failed', err.message);
      }
    })();
  }

  res.status(200).json({ received: true });
});

// ── JARVIS store snapshot builder ─────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════
// EMAIL ENGINE
// ══════════════════════════════════════════════════════════════════════════

function getSmtpConfig() {
  const row = db.prepare("SELECT smtp FROM email_settings WHERE id=1").get();
  if (!row) return null;
  try { return JSON.parse(row.smtp); } catch { return null; }
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
  const doc = { shopify_id: String(shopifyId||''), trigger, recipient, subject, status, error, sent_at };
  // Write to SQLite
  db.prepare("INSERT INTO email_log (shopify_id,trigger,recipient,subject,status,error,sent_at) VALUES (?,?,?,?,?,?,?)")
    .run(doc.shopify_id, trigger, recipient, subject, status, error, sent_at);
  // Write to MongoDB (fire-and-forget)
  if (mdb) mdb.collection('email_log').insertOne({ ...doc }).catch(()=>{});
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

function templateOrderConfirmedVendor({ order, vendorName, meta = {} }) {
  const isPrepaid   = order.financial_status === 'paid';
  const myItems     = (order.line_items || []).filter(li => li.vendor === vendorName);
  const subTotal    = myItems.reduce((s, li) => s + parseFloat(li.price || 0) * (li.quantity || 1), 0);
  const shipping    = parseFloat(order.total_shipping_price_set?.shop_money?.amount || 0);
  const advance     = parseFloat(meta.advance_paid || 0);
  const codAmount   = isPrepaid ? 0 : Math.max(0, subTotal + shipping - advance);

  const addr = order.shipping_address;

  const body = `
    <div class="subtitle">A new order has been assigned to <strong>${vendorName}</strong>. Please fulfil within 24 hours.</div>

    ${isPrepaid
      ? `<div style="background:#f0fdf4;border:2px solid #10b981;border-radius:8px;padding:12px 18px;margin-bottom:16px;text-align:center;font-weight:700;color:#065f46;font-size:14px;letter-spacing:1px;">✅ PREPAID ORDER — Payment already collected. DO NOT collect cash on delivery.</div>`
      : `<div style="background:#fffbeb;border:2px solid #f59e0b;border-radius:8px;padding:12px 18px;margin-bottom:16px;text-align:center;font-weight:700;color:#92400e;font-size:14px;letter-spacing:1px;">💵 COD ORDER — Collect ₹${codAmount.toFixed(2)} on delivery.</div>`
    }

    <div class="info-box">
      <div class="info-row"><span class="info-label">Order ID</span><span class="info-val" style="color:#6366f1;font-size:15px">${order.name}</span></div>
      <div class="info-row"><span class="info-label">Order Date</span><span class="info-val">${new Date(order.created_at).toLocaleDateString('en-IN',{day:'numeric',month:'long',year:'numeric'})}</span></div>
      <div class="info-row"><span class="info-label">Customer</span><span class="info-val">${addr?.name || order.email || '—'}</span></div>
      ${addr ? `<div class="info-row"><span class="info-label">Deliver To</span><span class="info-val">${addr.address1}${addr.address2 ? ', '+addr.address2 : ''}, ${addr.city}, ${addr.province} ${addr.zip}</span></div>` : ''}
      ${addr?.phone ? `<div class="info-row"><span class="info-label">Phone</span><span class="info-val">${addr.phone}</span></div>` : ''}
    </div>

    ${itemsTableHtml(myItems)}

    <!-- Amount Breakdown -->
    <table style="width:100%;border-collapse:collapse;margin-bottom:20px;font-size:13px;">
      <tr><td style="padding:7px 0;color:#6b7280;border-bottom:1px solid #f1f5f9">Items Subtotal</td><td style="text-align:right;padding:7px 0;border-bottom:1px solid #f1f5f9;font-weight:600">₹${subTotal.toFixed(2)}</td></tr>
      <tr><td style="padding:7px 0;color:#6b7280;border-bottom:1px solid #f1f5f9">Shipping Charge</td><td style="text-align:right;padding:7px 0;border-bottom:1px solid #f1f5f9;font-weight:600">₹${shipping.toFixed(2)}</td></tr>
      ${advance > 0 ? `<tr><td style="padding:7px 0;color:#10b981;border-bottom:1px solid #f1f5f9">Advance Collected</td><td style="text-align:right;padding:7px 0;border-bottom:1px solid #f1f5f9;font-weight:600;color:#10b981">− ₹${advance.toFixed(2)}</td></tr>` : ''}
      <tr style="background:#f8fafc"><td style="padding:10px;font-weight:800;font-size:14px;color:#1a2a3a;border-radius:4px 0 0 4px">
        ${isPrepaid ? '✅ COD to Collect' : '💵 COD to Collect'}
      </td><td style="text-align:right;padding:10px;font-weight:800;font-size:16px;border-radius:0 4px 4px 0;color:${isPrepaid ? '#10b981' : '#dc2626'}">
        ${isPrepaid ? '₹0.00 (Prepaid)' : `₹${codAmount.toFixed(2)}`}
      </td></tr>
    </table>

    <!-- Fulfilment Window -->
    <div style="background:#fef2f2;border:2px solid #fca5a5;border-radius:8px;padding:14px 18px;margin-bottom:12px;">
      <div style="font-weight:700;color:#991b1b;font-size:13px;margin-bottom:6px;">⚠️ Action Required — Fulfil Within 24–48 Hours</div>
      <div style="font-size:12px;color:#7f1d1d;line-height:1.7">
        Please pack and hand over this order to the courier within <strong>24–48 hours</strong> of receiving this email.
        Late fulfilment beyond 48 hours may result in penalties and could affect your seller rating on CrosCrow.<br><br>
        🌟 <strong>Fulfil before 24 hours?</strong> You earn a <strong>seller reward</strong> on this order — fast dispatch is always appreciated!
      </div>
    </div>

    <!-- WhatsApp Contact -->
    <div style="text-align:center;margin-bottom:8px;">
      <a href="https://wa.me/${process.env.WHATSAPP_NUMBER}?text=${encodeURIComponent(`Hi CrosCrow, I need help with order ${order.name}`)}"
         style="display:inline-flex;align-items:center;gap:8px;background:#25d366;color:#fff;text-decoration:none;font-weight:700;font-size:13px;padding:10px 22px;border-radius:8px;">
        <img src="https://upload.wikimedia.org/wikipedia/commons/6/6b/WhatsApp.svg" width="18" height="18" style="vertical-align:middle" alt="WhatsApp">
        Unable to fulfil? Contact Us on WhatsApp
      </a>
    </div>
  `;
  return emailBase(`New Order: ${order.name} — Action Required`, '#6366f1', body);
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
  const settingsRow = db.prepare("SELECT enabled FROM email_settings WHERE id=1").get();
  if (settingsRow && settingsRow.enabled === 0) {
    logEmail(shopifyId, trigger, to, subject, 'skipped', 'Emails disabled globally');
    return;
  }
  const cfg = getSmtpConfig();
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
    const cfg = getSmtpConfig();
    if (!cfg?.host) return; // no SMTP configured, skip silently

    const token = await getAccessToken();
    const r = await fetch(`https://${SHOP}.myshopify.com/admin/api/2025-01/orders/${shopifyId}.json`, {
      headers: { "X-Shopify-Access-Token": token }
    });
    if (!r.ok) return;
    let { order } = await r.json();
    order = await enrichOrderImages(order);
    const meta = db.prepare("SELECT awb, courier FROM order_meta WHERE shopify_id=?").get(String(shopifyId)) || {};

    const adminEmail = cfg.adminEmail;
    const customerEmail = order.email;
    const vendors = [...new Set((order.line_items || []).map(li => li.vendor).filter(Boolean))];

    if (newStage === 'confirmed') {
      for (const vendor of vendors) {
        const vendorRow = await VC.get(vendor);
        const vendorMeta = db.prepare("SELECT advance_paid FROM order_meta WHERE shopify_id=?").get(String(order.id)) || {};
        if (vendorRow?.email) await sendEmail({ to: vendorRow.email, subject: `New Order: ${order.name} — Action Required`, html: templateOrderConfirmedVendor({ order, vendorName: vendor, meta: vendorMeta }), shopifyId, trigger: 'confirmed_vendor' });
      }
    }

    if (newStage === 'partial') {
      const vendorMeta = db.prepare("SELECT advance_paid, payment_type FROM order_meta WHERE shopify_id=?").get(String(order.id)) || {};
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
    const metas  = db.prepare("SELECT * FROM order_meta").all();
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
    const allVS  = db.prepare("SELECT shopify_id, vendor_name, stage FROM order_vendor_stage").all();
    const vsMap  = {}; // { shopify_id: { vendor_name: stage } }
    allVS.forEach(r => { if (!vsMap[r.shopify_id]) vsMap[r.shopify_id] = {}; vsMap[r.shopify_id][r.vendor_name] = r.stage; });

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
        vendorStages:   vsMap[String(o.id)] || {},
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

  await OM.upsert(id, { stage, updated_at: new Date().toISOString() });
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
  const existing = db.prepare("SELECT * FROM order_vendor_stage WHERE shopify_id=? AND vendor_name=?").get(id, vendor_name);

  const newStartedAt = ['confirmed','partial'].includes(stage) ? nowMs : (existing?.stage_started_at || 0);
  const newWarning   = fulfilledStages.includes(stage) ? 0 : (['confirmed','partial'].includes(stage) ? 0 : (existing?.warning_sent || 0));
  const newPenalty   = fulfilledStages.includes(stage) ? 0 : (existing?.penalty_triggered || 0);

  await OVS.upsert(id, vendor_name, { stage, updated_at: now, stage_started_at: newStartedAt, warning_sent: newWarning, penalty_triggered: newPenalty });
  auditLog("admin", "vendor_stage_change", id, { vendor_name, stage });
  res.json({ success: true, vendor_name, stage });
});

// ── GET /admin/orders/:id/vendor-stages ──────────────────────────────────
app.get("/admin/orders/:id/vendor-stages", adminAuth, (req, res) => {
  const rows = db.prepare("SELECT vendor_name, stage, updated_at FROM order_vendor_stage WHERE shopify_id=?").all(req.params.id);
  res.json({ vendorStages: Object.fromEntries(rows.map(r => [r.vendor_name, r.stage])) });
});

// ── PUT /admin/orders/:id/meta ────────────────────────────────────────────
app.put("/admin/orders/:id/meta", adminAuth, async (req, res) => {
  const { id } = req.params;
  const { payment_type, advance_paid, shipping_charge, notes, awb, courier, tracking_url } = req.body || {};
  const now = new Date().toISOString();
  const advPaid = parseFloat(advance_paid) || 0;

  // Build update fields (only set non-null values, preserve existing)
  const existing = db.prepare("SELECT * FROM order_meta WHERE shopify_id=?").get(id) || {};
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

  auditLog("admin", "meta_update", id, req.body);
  res.json({ success: true });
});

// ── GET /admin/vendors ────────────────────────────────────────────────────
app.get("/admin/vendors", adminAuth, async (req, res) => {
  try {
    const vendors = await getVendorList();
    const configs = await VC.all();
    const cfgMap  = Object.fromEntries(configs.map(c => [c.vendor_name, c]));
    res.json({ vendors: vendors.map(v => ({
      name:           v,
      commission_pct: cfgMap[v]?.commission_pct ?? 20,
      active:         cfgMap[v]?.active ?? 1,
      email:          cfgMap[v]?.email || '',
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
    const existing = db.prepare("SELECT id FROM settlements WHERE vendor_name=? AND period_start=? AND period_end=?")
      .get(vendor_name, period_start, period_end);
    if (existing) return res.status(400).json({ error: "Settlement already exists for this period." });

    const allOrders = await fetchAllOrders("any", period_start + "T00:00:00Z", period_end + "T23:59:59Z");
    const vName  = vendor_name.toLowerCase();
    // Commission priority: vendor_profiles → vendor_config → default 20%
    const vProfile = db.prepare("SELECT commission_pct FROM vendor_profiles WHERE vendor_name=?").get(vendor_name);
    const vConfig  = await VC.get(vendor_name);
    const config   = { commission_pct: vProfile?.commission_pct ?? vConfig?.commission_pct ?? 20 };
    const metas  = db.prepare("SELECT * FROM order_meta").all();
    const metaMap = Object.fromEntries(metas.map(m => [m.shopify_id, m]));
    // Per-vendor stage overrides
    const vendorStages = db.prepare("SELECT shopify_id, stage FROM order_vendor_stage WHERE vendor_name=?").all(vendor_name);
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

    // Include confirmed penalties for this vendor in the settlement period
    const periodStartTs = new Date(period_start + 'T00:00:00Z').getTime();
    const periodEndTs   = new Date(period_end   + 'T23:59:59Z').getTime();
    const confirmedPenalties = db.prepare(
      "SELECT * FROM order_penalties WHERE vendor_name=? AND status='confirmed' AND triggered_at>=? AND triggered_at<=?"
    ).all(vendor_name, periodStartTs, periodEndTs);
    const penaltyTotal = confirmedPenalties.reduce((s, p) => s + (p.penalty_amount || 0), 0);
    if (penaltyTotal > 0) {
      const insP = db.prepare("INSERT INTO settlement_penalties (settlement_id, penalty_id, amount) VALUES (?,?,?)");
      confirmedPenalties.forEach(p => insP.run(settlId, p.id, p.penalty_amount));
      const updatedNet = parseFloat((netPayable + penaltyTotal).toFixed(2));
      db.prepare("UPDATE settlements SET penalty_deduction=?, net_payable=? WHERE id=?").run(penaltyTotal, updatedNet, settlId);
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
    const metas = db.prepare("SELECT * FROM order_meta").all();
    const metaMap = Object.fromEntries(metas.map(m => [m.shopify_id, m]));
    const vProfiles = db.prepare("SELECT * FROM vendor_profiles").all();
    const vConfigs  = await VC.all();
    const vProfileMap = Object.fromEntries(vProfiles.map(v => [v.vendor_name, v]));
    const vConfigMap  = Object.fromEntries(vConfigs.map(v => [v.vendor_name, v]));

    // Aggregate settled amounts per vendor from paid invoices
    const paidSettlements = db.prepare("SELECT vendor_name, SUM(net_payable) as total_settled FROM settlements WHERE status='paid' GROUP BY vendor_name").all();
    const settledMap = Object.fromEntries(paidSettlements.map(s => [s.vendor_name, s.total_settled]));

    const vendorMap = {};
    // Load all per-vendor stage overrides
    const allVendorStages = db.prepare("SELECT shopify_id, vendor_name, stage FROM order_vendor_stage").all();
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
  res.json({ mappings: db.prepare("SELECT * FROM tag_mappings ORDER BY priority ASC, id ASC").all() });
});

app.put("/admin/tag-mappings/:id/priority", adminAuth, (req, res) => {
  const { priority } = req.body || {};
  if (priority === undefined) return res.status(400).json({ error: "priority required" });
  db.prepare("UPDATE tag_mappings SET priority=? WHERE id=?").run(Number(priority), req.params.id);
  res.json({ ok: true });
});

app.post("/admin/tag-mappings", adminAuth, (req, res) => {
  const { shopify_tag, stage, priority = 99 } = req.body || {};
  if (!shopify_tag || !stage) return res.status(400).json({ error: "shopify_tag and stage required." });
  const VALID_STAGES = ["new","confirmed","partial","ready","pickup","transit","delivered","rto","hold","cancelled"];
  if (!VALID_STAGES.includes(stage)) return res.status(400).json({ error: `Invalid stage '${stage}'. Valid: ${VALID_STAGES.join(", ")}` });
  const existing = db.prepare("SELECT id FROM tag_mappings WHERE lower(shopify_tag)=lower(?)").get(shopify_tag);
  if (existing) return res.status(400).json({ error: "A mapping for this tag already exists." });
  const { lastInsertRowid } = db.prepare("INSERT INTO tag_mappings (shopify_tag, stage, priority, created_at) VALUES (?,?,?,?)")
    .run(shopify_tag.trim(), stage, Number(priority), new Date().toISOString());
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
app.get("/admin/vendors/:name/profile", adminAuth, async (req, res) => {
  const name = decodeURIComponent(req.params.name);
  const p = db.prepare("SELECT * FROM vendor_profiles WHERE vendor_name=?").get(name) || { vendor_name: name };
  const cfg = await VC.get(name);
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
  // sync commission to vendor_config too
  if (f.commission_pct != null) {
    VC.upsert(name, { commission_pct: parseFloat(f.commission_pct) }).catch(()=>{});
  }
  auditLog("admin","vendor_profile_update",name,{ commission_pct: f.commission_pct });
  res.json({ success:true });
});

// ── GET /admin/audit ──────────────────────────────────────────────────────
app.get("/admin/audit", adminAuth, (req, res) => {
  res.json({ logs: db.prepare("SELECT * FROM audit_log ORDER BY created_at DESC LIMIT 500").all() });
});

// ── Email Settings ────────────────────────────────────────────────────────
app.get("/admin/email-settings", adminAuth, (req, res) => {
  const row = db.prepare("SELECT smtp, enabled FROM email_settings WHERE id=1").get();
  const smtp = row ? JSON.parse(row.smtp) : {};
  const enabled = row ? (row.enabled !== 0) : true;
  res.json({ smtp: { ...smtp, pass: smtp.pass ? '••••••••' : '' }, enabled });
});

app.post("/admin/email-settings/toggle", adminAuth, (req, res) => {
  const { enabled } = req.body || {};
  const val = enabled ? 1 : 0;
  db.prepare("INSERT INTO email_settings (id, smtp, enabled) VALUES (1, '{}', ?) ON CONFLICT(id) DO UPDATE SET enabled=excluded.enabled")
    .run(val);
  res.json({ ok: true, enabled: val === 1 });
});

app.post("/admin/email-settings", adminAuth, (req, res) => {
  const { smtp } = req.body || {};
  if (!smtp) return res.status(400).json({ error: "smtp config required" });
  // Don't overwrite password if masked value sent
  const existing = db.prepare("SELECT smtp FROM email_settings WHERE id=1").get();
  let merged = smtp;
  if (existing) {
    const prev = JSON.parse(existing.smtp);
    if (smtp.pass === '••••••••') smtp.pass = prev.pass;
    merged = { ...prev, ...smtp };
  }
  db.prepare("INSERT INTO email_settings (id, smtp) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET smtp=excluded.smtp")
    .run(JSON.stringify(merged));
  res.json({ ok: true });
});

app.post("/admin/email-settings/test", adminAuth, async (req, res) => {
  const { to } = req.body || {};
  if (!to) return res.status(400).json({ error: "to email required" });
  const cfg = getSmtpConfig();
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
  const cfg = getSmtpConfig();
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
    new_order:  { subject: `[TEST] New Order: ${demoOrder.name} — Please Confirm`, html: templateNewOrderCustomer({ order: demoOrder }) },
    confirmed_customer: { subject: `[TEST] Order Confirmed: ${demoOrder.name} ✅`, html: templateOrderConfirmedCustomer({ order: demoOrder }) },
    confirmed_vendor:   { subject: `[TEST] New Order: ${demoOrder.name} — Action Required`, html: templateOrderConfirmedVendor({ order: demoOrder, vendorName: 'Demo Vendor', meta: demoMeta }) },
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
  if (mdb) {
    const logs = await mdb.collection('email_log').find({}, { projection: { _id: 0 } }).sort({ sent_at: -1 }).limit(200).toArray();
    return res.json({ logs });
  }
  res.json({ logs: db.prepare("SELECT * FROM email_log ORDER BY sent_at DESC LIMIT 200").all() });
});

// Vendor email update
app.put("/admin/vendors/:name/email", adminAuth, async (req, res) => {
  const name = decodeURIComponent(req.params.name);
  const { email } = req.body || {};
  await VC.upsert(name, { email: email || '' });
  res.json({ ok: true });
});

// ── Vendor wallet + settlements ───────────────────────────────────────────
// ── GET/PUT /vendor/profile ───────────────────────────────────────────────
app.get("/vendor/profile", vendorAuth, async (req, res) => {
  const p = db.prepare("SELECT * FROM vendor_profiles WHERE vendor_name=?").get(req.vendor) || { vendor_name: req.vendor };
  const cfg = await VC.get(req.vendor);
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
    const vConfig  = await VC.get(req.vendor);
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
      await OM.upsert(String(shopifyOrder.id), { awb: result.awb, courier: partner, updated_at: new Date().toISOString() });
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
    if (status) await OM.upsert(shopifyId, { awb, courier, delivery_status: status, delivery_status_updated_at: new Date().toISOString() });
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

// ── Vendor Shopify sync tables ────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS vendor_shopify_connections (
    vendor_name   TEXT PRIMARY KEY,
    shop_domain   TEXT NOT NULL,
    access_token  TEXT NOT NULL,
    scope         TEXT DEFAULT '',
    installed_at  INTEGER NOT NULL,
    sync_enabled  INTEGER DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS vendor_product_mappings (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    vendor_name           TEXT NOT NULL,
    vendor_product_id     TEXT NOT NULL,
    vendor_variant_id     TEXT NOT NULL,
    croscrow_product_id   TEXT NOT NULL,
    croscrow_variant_id   TEXT NOT NULL,
    sync_inventory        INTEGER DEFAULT 1,
    last_synced_at        INTEGER DEFAULT 0,
    UNIQUE(vendor_name, vendor_variant_id)
  );
`);

// ── Order notes table ─────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS order_notes (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    shopify_id TEXT NOT NULL,
    role       TEXT NOT NULL DEFAULT 'admin',
    author     TEXT NOT NULL DEFAULT 'Admin',
    note       TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
`);

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
    const adminEmail = getSmtpConfig()?.user;
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

    <div style="text-align:center">
      <a href="https://wa.me/${process.env.WHATSAPP_NUMBER}?text=${encodeURIComponent(`Hi CrosCrow, I need help with order ${order.name} (${vendorName})`)}"
         style="display:inline-flex;align-items:center;gap:8px;background:#25d366;color:#fff;text-decoration:none;font-weight:700;font-size:13px;padding:10px 22px;border-radius:8px;">
        <img src="https://upload.wikimedia.org/wikipedia/commons/6/6b/WhatsApp.svg" width="18" height="18" style="vertical-align:middle" alt="WhatsApp">
        Contact Support on WhatsApp
      </a>
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
    const adminEmail = getSmtpConfig()?.user;
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
    const rows = db.prepare(`
      SELECT ovs.*, om.shopify_id as mid
      FROM order_vendor_stage ovs
      LEFT JOIN order_meta om ON om.shopify_id = ovs.shopify_id
      WHERE ovs.stage IN ('confirmed','partial')
        AND ovs.stage_started_at > 0
    `).all();

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
      const ovs = db.prepare("SELECT stage FROM order_vendor_stage WHERE shopify_id=? AND vendor_name=?").get(dr.shopify_id, dr.vendor_name);
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

// ── Include confirmed penalties in settlement generation ──────────────────
// Patch: wrap the settlement generate route to add penalty deductions
// (The logic is injected into the existing route via post-insert query)

