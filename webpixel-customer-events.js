// ==============================================================
// CROSCROW — Shopify Customer Events (Web Pixel)
// Paste this exact code into:
//   Shopify Admin → Settings → Customer events → Add custom pixel
// This runs in Shopify's own sandboxed pixel context and fires
// correctly regardless of theme, app, AJAX add-to-cart, or
// accelerated/Shop Pay checkout — it's driven by Shopify's platform
// events, not by watching DOM buttons.
// ==============================================================

const SERVER_URL  = 'https://dashboard.croscrow.com';
const STORE_CODE   = 'cccc';
const BRAND_NAME   = 'CROSCROW';

function send(eventName, { productName, productImage, value, currency }) {
  fetch(`${SERVER_URL}/track-event`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      storeCode: STORE_CODE,
      brandName: BRAND_NAME,
      eventName,
      productName: productName || 'N/A',
      productImage: productImage || '',
      value: value != null ? value : null,
      currency: currency || '',
      timestamp: new Date().toISOString(),
    }),
  }).catch(() => {}); // pixel context can't usefully log errors — fail silently
}

// ── Product viewed ──────────────────────────────────────────────────────
analytics.subscribe('product_viewed', (event) => {
  const v = event.data?.productVariant;
  send('ViewContent', {
    productName: v?.product?.title,
    productImage: v?.image?.src,
    value: v?.price?.amount,
    currency: v?.price?.currencyCode,
  });
});

// ── Added to cart ────────────────────────────────────────────────────────
analytics.subscribe('product_added_to_cart', (event) => {
  const line = event.data?.cartLine;
  send('AddToCart', {
    productName: line?.merchandise?.product?.title,
    productImage: line?.merchandise?.image?.src,
    value: line?.cost?.totalAmount?.amount,
    currency: line?.cost?.totalAmount?.currencyCode,
  });
});

// ── Checkout started ─────────────────────────────────────────────────────
// A checkout can have multiple line items (multiple products in cart) — fire
// one InitiateCheckout per product, not just the first line item.
analytics.subscribe('checkout_started', (event) => {
  const checkout = event.data?.checkout;
  const currency = checkout?.totalPrice?.currencyCode;
  (checkout?.lineItems || []).forEach((item) => {
    const unitPrice = item?.variant?.price?.amount;
    const qty = item?.quantity || 1;
    send('InitiateCheckout', {
      productName: item?.title,
      productImage: item?.variant?.image?.src,
      value: unitPrice != null ? unitPrice * qty : null,
      currency,
    });
  });
});

// ── Checkout completed (purchase) ────────────────────────────────────────
// Same fix — one Purchase event per product actually purchased.
analytics.subscribe('checkout_completed', (event) => {
  const checkout = event.data?.checkout;
  const currency = checkout?.totalPrice?.currencyCode;
  (checkout?.lineItems || []).forEach((item) => {
    const unitPrice = item?.variant?.price?.amount;
    const qty = item?.quantity || 1;
    send('Purchase', {
      productName: item?.title,
      productImage: item?.variant?.image?.src,
      value: unitPrice != null ? unitPrice * qty : null,
      currency,
    });
  });
});
