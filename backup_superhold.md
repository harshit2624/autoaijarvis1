# Super Hold System — Backup

## What it was
Super Hold locked an order's stage so tag-based mappings couldn't override it.
Only terminal courier states (delivered/rto) could bypass it.

## DB field
`order_meta.super_hold: true/false`
`tag_mappings.super_hold_power: true/false`

## Endpoints removed
- POST /admin/orders/:id/super-hold  (body: {enable: true/false})
- PUT  /admin/tag-mappings/:id/super-hold-power  (body: {enabled: true/false})

## server.js logic (removed from tag mapping handler ~line 481)
```js
const prev = await mdb.collection('order_meta').findOne({ shopify_id: sid }, { projection: { stage: 1, super_hold: 1 } });
const isSuperHold = !!prev?.super_hold;
if (isSuperHold && !['hold','rto','cancelled','delivered'].includes(winner.stage)) {
  console.log(`🔒 Super Hold active on ${sid} — tag mapping to '${winner.stage}' blocked`);
  return;
}
if (isSuperHold && ['delivered','rto'].includes(winner.stage)) {
  console.log(`🔓 Super Hold auto-released on ${sid} — courier confirmed ${winner.stage}`);
}
const isSuperHoldTag = !!winner.super_hold_power;
const newStage = isSuperHoldTag ? 'hold' : winner.stage;
const metaUpdate = { stage: newStage, updated_at: now };
if (isSuperHoldTag) metaUpdate.super_hold = true;
if (isSuperHold && ['delivered','rto'].includes(newStage)) metaUpdate.super_hold = false;
```

## Endpoint code (removed from server.js ~line 4574)
```js
app.post("/admin/orders/:id/super-hold", adminAuth, async (req, res) => {
  const { id } = req.params;
  const { enable } = req.body || {};
  const now = new Date().toISOString();
  try {
    if (enable) {
      await OM.upsert(id, { super_hold: true, stage: 'hold', updated_at: now });
      // sync all vendors to hold
      try {
        const od = await shopifyREST(`/orders/${id}.json?fields=id,line_items`);
        const vendors = [...new Set((od?.order?.line_items||[]).map(li=>li.vendor).filter(Boolean))];
        for (const v of vendors) await OVS.upsert(id, v, { stage:'hold', updated_at: now });
      } catch(e) { console.error('super-hold vendor sync error:', e.message); }
      auditLog("admin", "super_hold_set", id, {});
      res.json({ success: true, super_hold: true });
    } else {
      await OM.upsert(id, { super_hold: false, updated_at: now });
      auditLog("admin", "super_hold_released", id, {});
      res.json({ success: true, super_hold: false });
    }
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.put("/admin/tag-mappings/:id/super-hold-power", adminAuth, async (req, res) => {
  const { enabled } = req.body || {};
  await mdb.collection('tag_mappings').updateOne({ id: parseInt(req.params.id) }, { $set: { super_hold_power: !!enabled } });
  res.json({ ok: true });
});
```

## admin.html SuperHoldBadge + toggle (removed)
```jsx
function SuperHoldBadge() {
  return <span style={{fontSize:9,fontWeight:800,letterSpacing:1,color:'#ef4444',background:'rgba(239,68,68,0.12)',border:'1px solid rgba(239,68,68,0.4)',borderRadius:4,padding:'1px 5px',textTransform:'uppercase',marginLeft:4}}>HOLD</span>;
}
// state: const [superHold, setSuperHold] = useState(!!order.superHold);
// toggleSuperHold function + Super Hold section in order modal
```
