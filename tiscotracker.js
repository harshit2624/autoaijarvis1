// ==============================
// PIXEL TRACKER – CLEAN VERSION
// ==============================

const STORE_CODE = 'cccc';
const BRAND_NAME = 'CROSCROW';
const YOUR_SERVER_URL = 'https://dashboard.croscrow.com';

const firedEvents = {};

/* =============================== */
/* CORE TRACK FUNCTION */
/* =============================== */
async function trackEvent(eventData) {
  // Keyed by event type + product, not just event type — otherwise a second
  // AddToCart/ViewContent for a DIFFERENT product on the same page (e.g. a
  // quick-add on a collection page, no full reload) gets silently dropped.
  const key = `${eventData.eventName}_${eventData.productName || ''}`;

  if (firedEvents[key]) {
    console.log('⚠️ Already fired:', key);
    return;
  }

  firedEvents[key] = true;

  const payload = {
    storeCode: STORE_CODE,
    brandName: BRAND_NAME,
    timestamp: new Date().toISOString(),
    ...eventData
  };

  console.log('✅ Tracking:', payload);

  try {
    const response = await fetch(`${YOUR_SERVER_URL}/track-event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    console.log('📡 Server response:', response.status);
  } catch (e) {
    console.error('❌ PixelTracker error:', e);
  }
}

/* =============================== */
/* 🔥 FACEBOOK PIXEL HOOK */
/* =============================== */
(function hookFbq() {
  const originalFbq = window.fbq;

  window.fbq = function () {
    const args = Array.from(arguments);

    if (args[0] === 'track' || args[0] === 'trackShopify') {
      const eventName =
        args[0] === 'trackShopify' ? args[2] : args[1];
      const payload =
        args[0] === 'trackShopify' ? args[3] : args[2] || {};

      /* ===== INITIATE CHECKOUT ===== */
      if (eventName === 'InitiateCheckout') {
        console.log('🛒 InitiateCheckout detected');

        setTimeout(async () => {
          try {
            const res = await fetch('/cart.js');
            const cart = await res.json();
            const item = cart.items?.[0];

            trackEvent({
              eventName: 'InitiateCheckout',
              value: payload.value,
              currency: payload.currency,
              productName: item?.product_title || 'N/A',
              productImage: item?.image || 'N/A'
            });

          } catch (err) {
            console.error('❌ InitiateCheckout error:', err);

            trackEvent({
              eventName: 'InitiateCheckout',
              value: payload.value,
              currency: payload.currency,
              productName: payload.content_name || 'N/A',
              productImage: 'N/A'
            });
          }
        }, 200);
      }

      /* ===== PURCHASE ===== */
      if (eventName === 'Purchase') {
        trackEvent({
          eventName: 'Purchase',
          value: payload.value,
          currency: payload.currency
        });
      }
    }

    if (originalFbq && originalFbq.callMethod) {
      return originalFbq.callMethod.apply(originalFbq, args);
    } else if (originalFbq) {
      return originalFbq.apply(this, args);
    }
  };

  if (originalFbq) {
    window.fbq.queue = originalFbq.queue || [];
    window.fbq.loaded = originalFbq.loaded;
    window.fbq.version = originalFbq.version;
    window.fbq.push = originalFbq.push;
  }

  console.log('✅ Facebook Pixel hook installed');
})();

/* =============================== */
/* VIEW CONTENT */
/* =============================== */
document.addEventListener('DOMContentLoaded', () => {
  if (!location.pathname.includes('/products/')) return;

  const handle = location.pathname
    .split('/products/')[1]
    ?.split('?')[0];

  if (!handle) return;

  fetch(`/products/${handle}.js`)
    .then(r => r.json())
    .then(product => {
      trackEvent({
        eventName: 'ViewContent',
        productName: product.title,
        productImage:
          product.featured_image ||
          product.images?.[0] ||
          'N/A'
      });
    })
    .catch(err => {
      console.error('❌ ViewContent error:', err);
    });
});

/* =============================== */
/* ADD TO CART (RELIABLE) */
/* =============================== */
document.addEventListener('submit', async (e) => {
  const form = e.target.closest('form[action*="/cart/add"]');
  if (!form) return;

  setTimeout(async () => {
    try {
      const res = await fetch('/cart.js');
      const cart = await res.json();
      const item = cart.items?.[cart.items.length - 1];

      if (!item) return;

      trackEvent({
        eventName: 'AddToCart',
        productName: item.product_title,
        productImage: item.image || 'N/A'
      });

    } catch (err) {
      console.error('❌ AddToCart error:', err);
    }
  }, 300);
});

/* =============================== */
/* 🚀 SHIPROCKET FASTR BUY NOW */
/* =============================== */
document.addEventListener('click', async (e) => {
  const btn = e.target.closest('.sr-headless-checkout');
  if (!btn) return;

  console.log('🚀 FASTR Checkout Clicked');

  try {
    const res = await fetch('/cart.js');
    const cart = await res.json();
    const item = cart.items?.[0];

    await trackEvent({
      eventName: 'InitiateCheckout',
      productName: item?.product_title || 'N/A',
      productImage: item?.image || 'N/A'
    });

  } catch (err) {
    console.error('❌ FASTR tracking error:', err);
  }
});

/* =============================== */
/* REGULAR CHECKOUT (FALLBACK) */
/* =============================== */
document.addEventListener('click', (e) => {
  const btn = e.target.closest(
    '[name="checkout"], .checkout-button, [href*="/checkout"]'
  );

  if (!btn) return;

  setTimeout(async () => {
    if (firedEvents['InitiateCheckout']) return;

    try {
      const res = await fetch('/cart.js');
      const cart = await res.json();
      const item = cart.items?.[0];

      trackEvent({
        eventName: 'InitiateCheckout',
        productName: item?.product_title || 'N/A',
        productImage: item?.image || 'N/A'
      });

    } catch (err) {
      console.error('❌ Regular checkout error:', err);
    }
  }, 150);
});

console.log('🎯 PixelTracker initialized and ready!');
