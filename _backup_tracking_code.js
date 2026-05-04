// ============================================================
// BACKUP: Removed tracking code (replaced by ShipSagar)
// Removed: 2026-05-04T19:12:50.551Z
// ============================================================

// --- Lines 5467-5556 from server.js ---
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

// --- Lines 5552-5627 from server.js ---
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

// --- Lines 5655-5681 from server.js ---

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

// --- Lines 5684-5818 from server.js ---

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


// --- Lines 7036-7153 from server.js ---
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


