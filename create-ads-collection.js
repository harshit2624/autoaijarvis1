#!/usr/bin/env node
// One-shot script: fetch pixel leaderboard data, rank products, match to Shopify
// product IDs via fuzzy title match, create a manual collection, and add them.
//
// Run: node create-ads-collection.js
// Requires the same .env as server.js (SHOP_NAME, SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET, MONGODB_URI)

require('dotenv').config();
const { MongoClient } = require('mongodb');

const SHOP = process.env.SHOP_NAME || 'croscrowofficial';
const CLIENT_ID = process.env.SHOPIFY_CLIENT_ID || process.env.SHOPIFY_API_KEY;
const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET || process.env.SHOPIFY_API_SECRET;
const MONGO_URI = process.env.MONGODB_URI || process.env.MONGO_URI;
const API_VERSION = '2025-01';

// ── Auth ──────────────────────────────────────────────────────────────────
let tokenCache = { token: null, expiresAt: 0 };
async function getAccessToken() {
  if (tokenCache.token && Date.now() < tokenCache.expiresAt - 60000) return tokenCache.token;
  const res = await fetch(`https://${SHOP}.myshopify.com/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: CLIENT_ID, client_secret: CLIENT_SECRET }),
  });
  if (!res.ok) throw new Error(`OAuth error: ${await res.text()}`);
  const data = await res.json();
  tokenCache = { token: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
  console.log(`✅ Token obtained (scopes: ${data.scope})`);
  return tokenCache.token;
}

async function shopifyGET(path) {
  const token = await getAccessToken();
  const res = await fetch(`https://${SHOP}.myshopify.com/admin/api/${API_VERSION}${path}`, {
    headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
  });
  if (!res.ok) throw new Error(`Shopify GET ${path} → ${res.status}: ${await res.text()}`);
  return { data: await res.json(), link: res.headers.get('link') || '' };
}

async function shopifyPOST(path, body) {
  const token = await getAccessToken();
  const res = await fetch(`https://${SHOP}.myshopify.com/admin/api/${API_VERSION}${path}`, {
    method: 'POST',
    headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Shopify POST ${path} → ${res.status}: ${await res.text()}`);
  return res.json();
}

// ── Fetch ALL Shopify products ─────────────────────────────────────────────
async function fetchAllProducts() {
  const products = [];
  let url = `/products.json?limit=250&fields=id,title,status`;
  while (url) {
    const { data, link } = await shopifyGET(url);
    if (data.products) products.push(...data.products);
    const next = link.match(/<([^>]+)>;\s*rel="next"/);
    if (next) {
      // Extract page_info from next URL
      const pi = next[1].match(/page_info=([^&>]+)/);
      url = pi ? `/products.json?limit=250&fields=id,title,status&page_info=${pi[1]}` : null;
    } else {
      url = null;
    }
  }
  console.log(`📦 Fetched ${products.length} Shopify products`);
  return products;
}

// ── Fuzzy match ────────────────────────────────────────────────────────────
function normalise(s) {
  return s.toLowerCase().replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim();
}

function score(pixelName, shopifyTitle) {
  const a = normalise(pixelName);
  const b = normalise(shopifyTitle);
  if (a === b) return 1.0;
  if (b.includes(a) || a.includes(b)) return 0.9;
  // Word overlap
  const wa = new Set(a.split(' '));
  const wb = new Set(b.split(' '));
  const intersection = [...wa].filter(w => wb.has(w) && w.length > 2).length;
  const union = new Set([...wa, ...wb]).size;
  return intersection / union;
}

function bestMatch(pixelName, products) {
  let best = null, bestScore = 0;
  for (const p of products) {
    const s = score(pixelName, p.title);
    if (s > bestScore) { bestScore = s; best = p; }
  }
  return bestScore >= 0.35 ? { product: best, score: bestScore } : null;
}

// ── Main ───────────────────────────────────────────────────────────────────
async function main() {
  // Pixel top products (from composite scoring done in previous session)
  // Format: [name, views, atc, checkout, purchases, compositeScore]
  const pixelRanked = [
    ['SICOS NYC - 001 CORE', 706, 51, 24, 12, 143.8],
    ['SICKBLUE - CORE 002', 981, 48, 24, 11, 129.6],
    ['HEAVEN MADE BOXY FIT - 001 CORE', 279, 27, 11, 4, 88.7],
    ['DOUBLE FACE - 001 CORE', 346, 22, 11, 4, 83.8],
    ['TFC BLUE BOXY STRIPPED SHIRT', 365, 19, 8, 5, 82.6],
    ['WITNESS - CORE 002', 289, 18, 6, 5, 80.5],
    ['Black Boxer Track Pant', 374, 22, 15, 4, 79.4],
    ['BLACK CURRENT - CORE 002', 252, 19, 10, 4, 78.7],
    ['Ananya Tee', 341, 21, 12, 4, 78.6],
    ['FOURMEN - 001 CORE', 288, 17, 9, 4, 75.4],
    ['PVT Grey Tracks', 319, 17, 10, 4, 75.2],
    ['Sinister Shirt (60/60)', 308, 17, 11, 4, 75.1],
    ['REALITY RESET', 245, 16, 8, 4, 72.3],
    ['REGULAR CROPPED TEE - DRIP SURF', 257, 15, 7, 4, 71.6],
    ['Darkcore Leather Pant', 224, 14, 6, 4, 70.3],
    ['KISS ME GRAPHIC TEE - BLACK', 318, 15, 9, 3, 68.9],
    ['Need Hug Oversized T-Shirt', 298, 14, 8, 3, 67.2],
    ['HIGH ON FASHION', 412, 14, 9, 3, 66.4],
    ['Frozen Flames Crew Socks', 287, 13, 7, 3, 63.8],
    ['Stardust Checkered Shirt (60/60)', 176, 1, 5, 2, 62.1],
    ['Second Sight Tee', 263, 12, 6, 3, 61.4],
    ['Fuck Off Crew Socks', 271, 11, 6, 3, 60.9],
    ['VOID GRAPHIC TEE - VINTAGE WASH', 231, 11, 5, 3, 60.1],
    ['RAGLAN CROPPED TEE - WINE', 244, 11, 5, 3, 59.8],
    ['Y2K HUSTLE RUGBY JERSEY', 198, 10, 5, 3, 58.4],
    ['Record Baggy Black Sweatpants', 215, 10, 5, 3, 57.9],
    ['Stealth Black Cropped Tee', 187, 10, 5, 3, 57.1],
    ["Don't Give Oversized T-Shirt", 201, 9, 5, 3, 56.3],
    ['CACTUS JACK FAKE LONG SLEEVES BOXY TEE', 176, 9, 4, 3, 55.7],
    ['FLY AWAY T-SHIRT', 193, 9, 4, 3, 54.9],
    ['Above Ordinary', 168, 8, 4, 3, 54.1],
    ['MIDNIGHT FADE DENIM (EOSS)', 227, 8, 4, 2, 51.3],
    ['TIGER KILLER T-SHIRT', 196, 8, 4, 2, 50.8],
    ['FOREST GREEN CLASP SHIRT', 184, 7, 4, 2, 49.6],
    ['RAGLAN CROPPED TEE - NAVY', 172, 7, 3, 2, 48.9],
    ['BULLY 2.0 GRAPHIC TEE - VINTAGE WASH', 163, 6, 3, 2, 47.4],
    ['Starlight 18 Jersey', 211, 7, 3, 2, 46.8],
    ['Rise Waffle Full Sleeve', 178, 6, 3, 2, 46.1],
    ['ASH CAMO CARGOS', 156, 6, 3, 2, 45.7],
    ['SOLIRA T-SHIRT IN BLACK [UNISEX]', 143, 6, 3, 2, 45.2],
    ['WHITE BRUTAL SHIRT', 168, 5, 3, 2, 44.8],
    ['NEW MONEY BOXY STRIPPED SHIRT', 159, 5, 3, 2, 44.3],
    ['Aqua Blaze Crew Socks', 134, 5, 2, 2, 43.9],
    ['Blaze Away Crew Socks', 128, 5, 2, 2, 43.4],
    ['No Permission Oversized T-Shirt', 147, 5, 2, 2, 42.8],
    ['MIAMI - Red Suade Trucker Cap', 139, 4, 2, 2, 42.1],
    ['DOECHII RUNWAY GAZE GRAPHIC TEE', 118, 4, 2, 2, 41.6],
    ['FROZEN NOCTURNAL GRAPHIC TEE', 126, 4, 2, 2, 41.1],
  ];

  console.log(`\n🚀 CrosCrow Ads Collection Creator`);
  console.log(`   Products to match: ${pixelRanked.length}`);

  const products = await fetchAllProducts();

  // Match each pixel name to a Shopify product
  const matched = [];
  const unmatched = [];
  for (const [name, views, atc, checkout, purchases, compScore] of pixelRanked) {
    const m = bestMatch(name, products);
    if (m) {
      matched.push({ name, shopifyId: m.product.id, title: m.product.title, matchScore: m.score, compScore });
      console.log(`  ✓ "${name}" → "${m.product.title}" (id:${m.product.id}, match:${(m.score*100).toFixed(0)}%)`);
    } else {
      unmatched.push(name);
      console.log(`  ✗ NO MATCH: "${name}"`);
    }
  }

  // Deduplicate by shopifyId (some pixel names may map to same product)
  const seen = new Set();
  const uniqueMatched = matched.filter(m => {
    if (seen.has(m.shopifyId)) return false;
    seen.add(m.shopifyId);
    return true;
  });

  console.log(`\n📊 Results: ${uniqueMatched.length} matched, ${unmatched.length} unmatched`);

  if (uniqueMatched.length === 0) {
    console.error('❌ No products matched — aborting collection creation');
    process.exit(1);
  }

  // Create the manual collection
  console.log(`\n🏗️  Creating Shopify collection...`);
  const collRes = await shopifyPOST('/custom_collections.json', {
    custom_collection: {
      title: 'CrosCrow Ads Collection',
      body_html: 'Top-performing products selected by CrosCrow pixel tracker analytics for paid advertising.',
      published: true,
    }
  });
  const collectionId = collRes.custom_collection.id;
  console.log(`✅ Collection created: id=${collectionId} — "${collRes.custom_collection.title}"`);

  // Add products to collection via collects
  console.log(`\n➕ Adding ${uniqueMatched.length} products to collection...`);
  let added = 0, failed = 0;
  for (const m of uniqueMatched) {
    try {
      await shopifyPOST('/collects.json', {
        collect: { collection_id: collectionId, product_id: m.shopifyId }
      });
      added++;
      console.log(`  ✓ [${added}/${uniqueMatched.length}] ${m.title}`);
    } catch (e) {
      failed++;
      console.error(`  ✗ FAILED adding ${m.title}: ${e.message}`);
    }
    // Small delay to avoid rate limiting
    await new Promise(r => setTimeout(r, 250));
  }

  console.log(`\n🎉 Done! Added ${added} products (${failed} failed)`);
  if (unmatched.length > 0) {
    console.log(`\n⚠️  Unmatched pixel products (add manually if needed):`);
    unmatched.forEach(n => console.log(`   - ${n}`));
  }
  console.log(`\n🔗 View collection: https://${SHOP}.myshopify.com/admin/collections/${collectionId}`);
}

main().catch(err => { console.error('❌ Fatal:', err.message); process.exit(1); });
