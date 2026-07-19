# CROSCROW Platform — Complete Knowledge Base
# Jarvis uses this to answer any question about how the panel works.
# Last updated: July 2026

---

## 1. WHAT IS CROSCROW

CROSCROW is a multi-vendor Shopify marketplace. Vendors (independent clothing brands) list their products on a shared Shopify store. When a customer orders, CROSCROW collects the payment, coordinates fulfillment with the vendor, and settles the vendor's share after deducting commission + GST.

CROSCROW does NOT hold inventory and does NOT handle logistics costs — vendors ship directly to customers using their own courier accounts (Delhivery, Shiprocket, Bluedart, etc.).

---

## 2. ORDER LIFECYCLE (STAGES)

Every order goes through stages tracked internally in `order_vendor_stage` (per vendor) and `order_meta` (overall order).

```
new → confirmed → partial → ready → pickup → transit → delivered
                                                      → rto
                ↘ hold
                ↘ cancelled
```

### Stage Definitions
- **new** — Order just placed, not yet confirmed with vendor
- **confirmed** — Vendor has confirmed they will fulfill (48hr SLA starts here)
- **partial** — Multi-vendor order where some vendors confirmed, others haven't
- **hold** — Order paused (customer unreachable, address issue, etc.)
- **ready** — Vendor packed and ready to handover to courier
- **pickup** — Courier pickup scheduled / picked up
- **transit** — AWB entered, shipment in transit
- **delivered** — Courier confirmed delivery
- **rto** — Return to Origin — courier couldn't deliver, shipment returning to vendor
- **cancelled** — Order cancelled (before or after confirmation)
- **misc** — Edge case or uncategorized hold state

### Multi-vendor Orders
A single customer order can have products from multiple vendors. Each vendor has their own independent stage. The overall order stage is derived from the "winning" vendor stage using priority logic (most advanced stage wins, except hold/cancelled/rto which override).

---

## 3. PENALTY SYSTEM

### Why Penalties Exist
Vendors are required to ship within 48 hours of confirming an order. Delays hurt customer experience and CROSCROW's reputation. Penalties are a financial deterrent.

### Penalty Timeline
| Time from confirmation | What happens |
|---|---|
| 24 hours | ⚠️ Email warning sent to vendor + WhatsApp nudge (1=delay, 2=shipped) |
| 48 hours | 🚨 Penalty triggered automatically (unless vendor filed a delay with future ETA) |
| After ETA date | If vendor filed a delay remark with a future ETA and still hasn't shipped by that date → penalty triggers on ETA breach |

### How Penalties Work
- Penalty is created as a record in `order_penalties` with status `pending`
- Admin reviews and can confirm or cancel the penalty
- Confirmed penalties are deducted from the vendor's next settlement invoice
- Vendors can dispute via WhatsApp or the vendor panel

### Penalty Exceptions
- If vendor submits a delay remark with a future ETA before 48hr mark → penalty is held (not triggered at 48hr, only if ETA date is missed)
- Admin can manually cancel a penalty at any time before settlement

### Penalty Amounts
- Set per-vendor in vendor config (`vendor_penalty_amount`)
- Default is usually ₹200–₹500 per breach

### Checking Penalties
- Admin panel → Orders → Penalty tab shows all pending/confirmed penalties
- Tool: `get_vendor_fulfillment` shows per-vendor penalty count

---

## 4. COMMISSION & SETTLEMENT SYSTEM

### How Commission is Calculated
CROSCROW charges vendors a commission % on every delivered order.

```
Base = myRevenue (vendor's product price, excluding shipping)

For COD orders:
  Commission = Base × commissionRate%
  GST = Commission × 18%
  Total deduction = Commission + GST

For Prepaid orders:
  Base = myRevenue × 90%   ← 10% discount on prepaid (incentive for online payment)
  Commission = Base × commissionRate%
  GST = Commission × 18%
  Total deduction = Commission + GST
```

Default commission rate: 20% (configurable per vendor in vendor_config)

### What "My Revenue" Means
`myRevenue` = the vendor's product price only. Shipping charge is separate and goes to CROSCROW (not vendor revenue). For multi-vendor orders, each vendor's revenue is their own line items only.

### Settlement Invoice
- Generated monthly (or on demand) per vendor
- Shows: all delivered orders in period, commission per order, penalties deducted, advance received, final amount owed TO vendor
- If total commission+penalties > vendor revenue → vendor owes CROSCROW money (negative settlement)
- Vendors can view their own invoices in the vendor panel

### Advance/Partial Payment Orders
- Some COD orders require customer to pay an advance upfront (partial prepaid)
- Advance is tracked in `order_meta.advance_paid`
- At settlement: advance already received is shown as a credit to vendor (reduces what CROSCROW owes them)
- Formula: `Net to vendor = myRevenue - commission - GST - penalties + advance_already_received`

### Settlement Status
- **unsettled** — Delivered order, not yet in a settlement invoice
- **invoiced** — Included in a settlement invoice
- **paid** — Vendor has been paid out

---

## 5. NOT-CONFIRMED ORDER BREAKDOWN

The dashboard shows orders that were NOT fulfilled. Tracked in 4 sub-stages:

| Stage | Meaning |
|---|---|
| Hold | Confirmed but then put on hold (customer issue, address problem) |
| Cancelled | Order cancelled |
| New | Not yet confirmed by vendor (no action taken) |
| Misc | Uncategorized edge cases |

### "Was Confirmed" Tracking
Orders that were once confirmed (had tags: "order confirmed", "confirmed on call ✅", "prepaid 💰") but ended up in hold/cancelled/new/misc are tracked separately. These represent confirmed-then-lost orders — a key ops metric. Shown as amber in the progress bar.

---

## 6. VENDOR WHATSAPP (WA) NUDGE SYSTEM

### Automatic Nudges
Every order stuck in `confirmed`/`partial`/`hold`/`new` stage for 24+ hours triggers a WhatsApp message to the vendor's registered mobile number.

### Nudge Message Format
```
⚠️ Action Required — Order #XXXX
Hi [Vendor Name],
Customer: [name] (+91XXXXXXXXXX)
Product: [product name]
Status: Not shipped for X days

Reply with:
1️⃣ — Order is delayed (share reason + ETA)
2️⃣ — Already shipped (share AWB + courier)
```

### Interactive Reply Flow
- Vendor replies **1** → Bot asks for delay reason + expected date (natural language)
- Vendor replies **2** → Bot asks for AWB + courier (natural language)
- LLM parses the vendor's free-text reply and extracts structured data
- Delay saved to `delay_remarks` collection (visible in admin order page)
- AWB/courier saved to `order_vendor_stage`, stage updated to `transit`

### Deduplication
- Nudges are deduped per order+vendor per 24 hours (won't spam same vendor)
- Session stored for 4 hours so vendor can reply at their pace

### Penalty WA Alerts
- At 48hr penalty trigger → vendor also gets WhatsApp: "🚨 Penalty Triggered"
- Can still reply 1/2 to update order even after penalty

---

## 7. VENDOR ONBOARDING & PROFILES

### Vendor Profile Fields
- Vendor name, email, phone (for WA nudges)
- Bank account details (for settlement payouts)
- Commission rate override (default 20%)
- Penalty amount
- Shopify vendor tag (must match line_item.vendor in orders)

### Vendor Panel
Vendors have their own login at `/vendor.html` (separate from admin). They can:
- See their orders and stages
- Enter AWB/tracking
- File delay remarks
- View settlements and invoices
- View their commission breakdown

### Vendor Onboarding Flow
1. Admin creates vendor account (Settings → Vendors)
2. System sends onboarding email with vendor panel login
3. Vendor connects courier account (Delhivery/Shiprocket) inside vendor panel
4. Orders start flowing to them

---

## 8. FULFILLMENT & TRACKING

### AWB Entry
- Vendor enters AWB + courier in vendor panel OR via WhatsApp reply "2"
- Admin can also enter AWB in order modal
- Stage auto-advances to `transit` when AWB is saved

### Courier Partners
- Delhivery
- Shiprocket (aggregator — covers 25+ couriers)
- BlueDart
- Others (manual tracking URL)

### Tracking URL Generation
System auto-generates tracking URLs from AWB + courier name (Delhivery: `delhivery.com/track/...`, BlueDart: `bluedart.com/...`, etc.)

### Delivery Confirmation
- Marked as `delivered` when tracking status confirms delivery OR admin manually updates
- RTO marked when courier reports failed delivery and return initiated

---

## 9. CUSTOMER WHATSAPP SUPPORT BOT

### What It Handles
- Order status queries ("where is my order?")
- Order tracking (looks up by phone number or order ID)
- Cancellation requests
- Return/exchange requests
- General product queries
- Escalation to human agent

### How It Works
1. Customer messages CROSCROW WA business number
2. Bot looks up customer's orders by phone number
3. Answers using live order data from Shopify + internal stage data
4. Complex queries escalated to admin support queue

### Support Chat Storage
All WA support chats stored in `support_chats` + `support_messages` — visible in Admin → Support section.

### Support Insights
AI periodically analyzes recent chats to identify:
- Repeated questions (product quality, delay complaints, etc.)
- Bot failure patterns (wrong answers, customer frustration)
- Anomalies (same message going to many customers = routing bug)

---

## 10. LIVE OPS MAP (SCENARIOS TAB)

### What It Shows
Real-time delivery performance across Indian cities. Each city shows order count, delivery rate, RTO rate.

### Scenarios Tab (Financial Simulator)
Lets admin simulate: "If I spend ₹X on marketing and achieve Y% delivery rate, what's my net profit?"

Key metrics:
- **CAC** (Cost to Acquire Customer) — marketing spend / paid orders
- **AOV** (Average Order Value) — from real delivered orders
- **Commission %** — CROSCROW's take rate
- **Delivery Rate** — % of orders successfully delivered (from completed orders only)

Formula:
```
paidOrders = marketingSpend / CAC
totalOrders = baseOrders (organic) + paidOrders
delivered = totalOrders × deliveryRate
commissionRevenue = delivered × AOV × commissionRate%
wastdCAC = paidOrders × (1 - deliveryRate) × CAC   ← CAC spent on RTO orders = wasted
net = commissionRevenue - marketingSpend
ROAS = commissionRevenue / marketingSpend
```

Note: CROSCROW does NOT pay logistics. Vendors ship at their own cost. RTO only wastes the CAC spent acquiring that customer.

---

## 11. RETURN REQUESTS (RTO/RETURNS)

### Customer-Initiated Returns
Customers can raise return requests via support chat or vendor panel. Tracked in `return_requests`.

### RTO (Return to Origin)
When courier fails delivery (wrong address, customer refused, not home 3 attempts):
- Shipment returns to vendor
- Stage marked `rto`
- COD amount is NOT collected (no revenue for that order)
- Commission is NOT charged on RTO orders

### CC (CROSCROW) Inventory
Some vendors drop-ship to CROSCROW's warehouse (CC Stock). These are tracked separately. Returns go to CC warehouse, not vendor.

---

## 12. SETTLEMENTS — DETAILED FLOW

### When Settlement Runs
- Monthly (admin initiates from Settlements page)
- Or on-demand for a specific vendor

### What's Included
Only `delivered` orders in the period (not transit, not RTO).

### Settlement Invoice Breakdown
```
Order #XXXX: ₹1,200 (myRevenue)
  Commission (20%): -₹240
  GST on commission (18%): -₹43.2
  Penalty (if any): -₹200
  Advance collected: -₹300 (already received from customer)
  ─────────────────────
  Net for this order: ₹416.8

Total net payout to vendor for period: ₹X
```

### Prepaid vs COD at Settlement
- Prepaid orders: CROSCROW already collected full payment from customer → owes vendor `myRevenue - commission - GST`
- COD orders: vendor collects cash at delivery → vendor owes CROSCROW commission+GST from that cash
- Settlement shows net position (positive = CC pays vendor, negative = vendor pays CC)

### Invoice Number Format
`CC-[VENDORCODE]-[YYYYMM]-[ORDERID]`

---

## 13. DISPATCH RATE & PERFORMANCE METRICS

### Dispatch Rate
```
dispatchRate = orders with AWB or in [ready/pickup/transit/delivered] 
               ÷ total active orders in [confirmed/partial/ready/pickup/transit]
```

### Delivery Rate
```
deliveryRate = delivered ÷ (delivered + rto)   ← completed orders only
```

### Key Vendor Performance Metrics
- Confirmation rate: confirmed / total new orders assigned
- Dispatch rate: dispatched / confirmed
- Delivery rate: delivered / dispatched
- RTO rate: rto / dispatched
- Penalty count: penalties triggered
- Avg dispatch time: hours between confirmed and AWB entry

---

## 14. COD OUTSTANDING

COD orders where vendor has collected cash but not yet remitted to CROSCROW (or offset in settlement):
- Tracked as "COD outstanding" per vendor
- Shown in vendor performance report
- Should be reconciled at settlement time

---

## 15. REPORTING & DAILY REPORTS

### Daily WA Report (sent to admin automatically)
- Total orders today / this week
- Pending confirmations
- Stuck orders (48hr+)
- Penalties triggered today
- Dispatch rate
- Top performing vendors

### Weekly Report
- Same metrics but 7-day window
- Vendor league table (best/worst dispatch rate)

---

## 16. ADMIN PANEL SECTIONS

| Section | What It Does |
|---|---|
| Dashboard | Live order stats, stage breakdown, pending actions |
| Orders | Full order list with filters, search, stage management |
| Vendors | Vendor profiles, performance, commission config |
| Settlements | Generate/view invoices, mark paid |
| Support | Customer WA chats + Vendor WA chats + AI insights |
| Returns | RTO and return request management |
| Live Ops Map | City-wise delivery heatmap + financial scenarios |
| Tech Brain | System health, cron jobs, WA bot status |
| Settings | Branding, commission rates, vendor onboarding |

---

## 17. BUSINESS MODEL SUMMARY

CROSCROW makes money from:
1. **Commission** — 20% of delivered order value (minus prepaid discount)
2. **Shipping margin** — if shipping charged to customer > actual courier cost

CROSCROW does NOT make money from:
- RTO orders (no delivery, no commission)
- Cancelled orders
- Vendor penalties (those are a deterrent, not profit)

Key unit economics:
- Average Order Value: ~₹1,200–₹1,500
- Commission per order: ~₹200–₹280 (before GST)
- Net commission after GST: ~₹168–₹235
- Target delivery rate: 65%+
- Current delivery rate: ~60–65% (varies by city)

---

## 18. FREQUENTLY ASKED QUESTIONS JARVIS SHOULD KNOW

**Q: How does penalty work?**
A: Order confirmed → 24hr warning email+WA → 48hr penalty auto-triggers (₹200–₹500 deducted from next settlement). Exception: if vendor files a delay with future ETA before 48hr, penalty holds until ETA date.

**Q: How is commission calculated on prepaid orders?**
A: Base = myRevenue × 90% (10% discount). Then commission% × base. Then +18% GST. So effective rate is lower on prepaid than COD.

**Q: Which vendor owes us the most?**
A: Call get_vendor_fulfillment tool — shows COD outstanding + unsettled commissions per vendor.

**Q: Why is delivery rate low?**
A: Usually driven by specific cities (tier-2/3 where courier fails) or specific vendors shipping low-quality products. get_rto_analysis shows breakdown.

**Q: How do I check pending penalties?**
A: Admin → Orders → Penalty tab. Or ask Jarvis "show pending penalties" — tool get_vendor_fulfillment returns penalty counts.

**Q: What happens when an order is RTO?**
A: Stage → rto. No commission charged. COD not collected. Vendor gets product back. CAC spent on that order is wasted.

**Q: How does the not-confirmed breakdown work?**
A: Shows orders in hold/cancelled/new/misc. Amber portion = orders that were once confirmed (had confirmed tag) but still ended up not fulfilled. This is the key metric — it means vendor confirmed but failed.

**Q: How does WA vendor nudge routing work?**
A: When vendor replies to a nudge, their JID is matched against wa_vendor_jids. If matched → vendor handler. If not → customer support. Vendor sessions stored for 4hr after nudge sent.

**Q: What is "my revenue" vs "order value"?**
A: Order value = total customer paid (including shipping + all vendors). My revenue = just the vendor's product price (no shipping). Commission is on my revenue only.

**Q: How does the advance/partial payment work?**
A: Customer pays partial upfront (advance). Rest COD at delivery. At settlement, advance already collected is shown as deduction from what CROSCROW owes the vendor (vendor gets less at settlement because they already got some via prepaid advance).
