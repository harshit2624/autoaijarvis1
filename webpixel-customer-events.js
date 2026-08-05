// ==============================================================
// CROSCROW — Shopify Customer Events (Web Pixel)
// Paste into: Shopify Admin → Settings → Customer events → Add custom pixel
//
// Confirmed payload shape (from GoKwik debugger):
//   GoKwik fires everything through "gokwik_events"
//   event.customData = {
//     name: "Started_Checkout_GK",   ← step name
//     data: {                         ← actual data
//       Products: [{ "Product Name", "Product Price", "Product Quantity", "Image Url" }],
//       total_price, currency, "Coupon Code", ...
//     }
//   }
// ==============================================================

const SERVER_URL = 'https://dashboard.croscrow.com';
const STORE_CODE  = 'cccc';
const BRAND_NAME  = 'CROSCROW';

function send(eventName, payload) {
  fetch(`${SERVER_URL}/track-event`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      storeCode:    STORE_CODE,
      brandName:    BRAND_NAME,
      eventName,
      productName:  payload.productName  || 'N/A',
      productImage: payload.productImage || '',
      value:        payload.value != null ? Number(payload.value) : null,
      currency:     payload.currency     || 'INR',
      orderId:      payload.orderId      || null,
      orderName:    payload.orderName    || null,
      paymentMode:  payload.paymentMode  || null,
      couponCode:   payload.couponCode   || null,
      city:         payload.city         || null,
      state:        payload.state        || null,
      source:       payload.source       || null,
      timestamp:    new Date().toISOString(),
    }),
  }).catch(() => {});
}

// ── 1. Native Shopify: ViewContent ───────────────────────────────────────────
analytics.subscribe('product_viewed', (event) => {
  const v = event.data && event.data.productVariant;
  send('ViewContent', {
    productName:  v && v.product && v.product.title,
    productImage: v && v.image && v.image.src,
    value:        v && v.price && v.price.amount,
    currency:     v && v.price && v.price.currencyCode,
  });
});

// ── 2. Native Shopify: AddToCart ─────────────────────────────────────────────
analytics.subscribe('product_added_to_cart', (event) => {
  const line = event.data && event.data.cartLine;
  send('AddToCart', {
    productName:  line && line.merchandise && line.merchandise.product && line.merchandise.product.title,
    productImage: line && line.merchandise && line.merchandise.image && line.merchandise.image.src,
    value:        line && line.cost && line.cost.totalAmount && line.cost.totalAmount.amount,
    currency:     line && line.cost && line.cost.totalAmount && line.cost.totalAmount.currencyCode,
  });
});

// ── 3. GoKwik: all funnel events come through gokwik_events ─────────────────
// event.customData.name = step name (e.g. "Started_Checkout_GK")
// event.customData.data = payload with Products[], total_price, currency, etc.
analytics.subscribe('gokwik_events', (event) => {
  var cd = event && event.customData;
  if (!cd) return;

  var gkName = cd.name || cd.event || '';
  // GoKwik nests data as customData.data.data (confirmed from real payload)
  var d = (cd.data && cd.data.data) || cd.data || cd.event_data || {};
  var products = d.Products || d.product_details || [];
  var currency = d.currency || d.Currency || 'INR';

  var shared = {
    currency:    currency,
    couponCode:  d['Coupon Code'] || d.coupon_code || null,
    orderId:     d.order_id       || null,
    orderName:   d.order_number   || null,
    paymentMode: d.payment_method || d.payment_mode_selected || null,
    city:        d.city           || null,
    state:       d.state          || null,
    source:      'gokwik',
  };

  // Map GoKwik step name → CROSCROW tracker eventName
  var eventName;
  if (gkName === 'Started_Checkout_GK')       { eventName = 'InitiateCheckout'; }
  else if (gkName === 'Order_Placed_GK')       { eventName = 'Purchase'; }
  else if (gkName === 'Mobile_Added_GK')       { eventName = 'GK_MobileAdded'; }
  else if (gkName === 'Address_Step_Reached_GK') { eventName = 'GK_AddressReached'; }
  else if (gkName === 'Address_Added_GK')      { eventName = 'GK_AddressAdded'; }
  else if (gkName === 'Payment_Step_Reached_GK') { eventName = 'GK_PaymentReached'; }
  else if (gkName === 'Payment_Method_Selected_GK') { eventName = 'GK_PaymentSelected'; }
  else if (gkName === 'Coupon_Applied_Success_GK') { eventName = 'GK_CouponApplied'; }
  else if (gkName === 'Coupon_Applied_Failed_GK')  { eventName = 'GK_CouponFailed'; }
  else { eventName = 'GK_' + gkName; } // catch unknown future steps

  if (products.length > 0) {
    products.forEach(function(item) {
      var price = item['Product Price'] || item.product_price || null;
      var qty   = item['Product Quantity'] || item.product_quantity || 1;
      send(eventName, {
        productName:  item['Product Name'] || item.product_name || 'N/A',
        productImage: item['Image Url']    || item.product_image_url || '',
        value:        price != null ? price * qty : null,
        currency:     item.Currency || currency,
        couponCode:   shared.couponCode,
        orderId:      shared.orderId,
        orderName:    shared.orderName,
        paymentMode:  shared.paymentMode,
        city:         shared.city,
        state:        shared.state,
        source:       shared.source,
      });
    });
  } else {
    send(eventName, { productName: 'N/A', value: d.total_price || null, currency: currency, source: 'gokwik' });
  }
});

// ── 4. GoKwik purchase backup (separate event, different payload shape) ───────
analytics.subscribe('gokwik_purchase_event', (event) => {
  var data = event && event.customData;
  if (!data) return;
  var cart  = data.cart  || {};
  var items = cart.items || [];
  var shared = {
    currency:    cart.currency   || 'INR',
    orderId:     data.moid       || null,
    orderName:   data.order_name || null,
    paymentMode: data.order_type || null,
    couponCode:  data.discount && data.discount.title ? data.discount.title : null,
    source:      'gokwik_purchase_event',
  };
  if (items.length === 0) {
    send('Purchase', { productName: 'GoKwik Order', value: data.total_price || cart.total_price || null, currency: shared.currency, orderId: shared.orderId, orderName: shared.orderName, paymentMode: shared.paymentMode, source: shared.source });
    return;
  }
  items.forEach(function(item) {
    send('Purchase', {
      productName:  item.product_title || item.title || 'N/A',
      productImage: item.product_image || item.image_url || '',
      value:        item.presentment_price != null ? item.presentment_price * (item.quantity || 1) : null,
      currency:     shared.currency,
      orderId:      shared.orderId,
      orderName:    shared.orderName,
      paymentMode:  shared.paymentMode,
      couponCode:   shared.couponCode,
      source:       shared.source,
    });
  });
});
