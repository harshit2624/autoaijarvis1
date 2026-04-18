# JARVIS × Shopify — Render Deploy Guide

## What's in this folder

| File | Purpose |
|------|---------|
| `server.js` | Express proxy — keeps your Shopify secrets server-side |
| `package.json` | Node dependencies |
| `render.yaml` | Render blueprint — auto-configures the service |
| `.env.example` | Copy → `.env` for local dev |
| `keep-alive.js` | Pings server every 10min (free tier) |
| `.github/workflows/keep-alive.yml` | GitHub Actions version of keep-alive |
| `jarvis-shopify.jsx` | The JARVIS React frontend (in parent folder) |

---

## Step 1 — Create your Shopify App

1. Go to [partners.shopify.com](https://partners.shopify.com) → **Dev Dashboard**
2. Click **Create app** → give it a name (e.g. "JARVIS Agent")
3. Under **Configuration**, set these access scopes:
   - `read_orders`
   - `read_customers`
   - `read_fulfillments`
4. Click **Save**
5. Go to **Settings** tab → copy:
   - ✅ **Client ID**
   - ✅ **Client Secret**
6. Install the app on your store:
   - Go to **Test your app** → select your store → Install

---

## Step 2 — Push to GitHub

```bash
git init
git add .
git commit -m "JARVIS Shopify server"
git remote add origin https://github.com/YOUR_USERNAME/jarvis-shopify.git
git push -u origin main
```

---

## Step 3 — Deploy to Render

1. Go to [render.com](https://render.com) → **New +** → **Web Service**
2. Connect your GitHub account → select your repo
3. Render will auto-detect `render.yaml` — click **Apply**
4. Fill in **Environment Variables** in the Render dashboard:

| Key | Value |
|-----|-------|
| `SHOP_NAME` | Your store name (before `.myshopify.com`) |
| `SHOPIFY_CLIENT_ID` | From Shopify Dev Dashboard |
| `SHOPIFY_CLIENT_SECRET` | From Shopify Dev Dashboard |
| `ALLOWED_ORIGINS` | `*` for now (restrict later) |

5. Click **Create Web Service**
6. Wait ~2 minutes for build to complete
7. Your server is live at: `https://jarvis-shopify.onrender.com`

---

## Step 4 — Connect the Frontend

In `jarvis-shopify.jsx`, change line 8:

```js
// Before
const PROXY_URL = "http://localhost:3001";

// After
const PROXY_URL = "https://jarvis-shopify.onrender.com";
```

Then deploy your frontend to **Netlify** or **GitHub Pages**:

### Netlify (easiest):
1. Drag your React build folder to [netlify.com/drop](https://app.netlify.com/drop)
2. Or connect GitHub repo for auto-deploy

---

## Step 5 — Set up Shopify Webhooks (real-time updates)

1. In Shopify Admin → **Settings** → **Notifications** → **Webhooks**
2. Add webhooks for:
   - **Order creation** → `https://jarvis-shopify.onrender.com/webhooks/orders`
   - **Order fulfillment** → `https://jarvis-shopify.onrender.com/webhooks/orders`
   - **Order cancellation** → `https://jarvis-shopify.onrender.com/webhooks/orders`
3. Format: **JSON**
4. Click **Save**

Now JARVIS gets notified instantly when any order changes.

---

## Step 6 — Keep the Free Tier Awake

Render's free tier sleeps after 15 minutes of no traffic. To prevent this:

### Option A — GitHub Actions (recommended, free):
1. In your GitHub repo → **Settings** → **Secrets** → **Actions**
2. Add secret: `RENDER_URL` = `https://jarvis-shopify.onrender.com`
3. The `.github/workflows/keep-alive.yml` file does the rest automatically

### Option B — Upgrade to Render Starter ($7/mo):
No sleep, faster cold starts, custom domains.

---

## Testing your deployment

```bash
# Health check
curl https://jarvis-shopify.onrender.com/health

# Orders
curl https://jarvis-shopify.onrender.com/orders

# Stats
curl https://jarvis-shopify.onrender.com/orders/stats

# Export CSV (opens download)
open https://jarvis-shopify.onrender.com/orders/export
```

---

## Full Architecture

```
Shopify Store
     │
     ├── REST API ──────────────────────────────────────────────────────┐
     │                                                                   ▼
     └── Webhooks (order events) ──► Render Server (server.js)  ◄── JARVIS UI
                                          │    (jarvis-shopify.jsx)
                                          │    hosted on Netlify
                                          │
                                     Token Cache
                                  (refreshes every 24h)
```

---

## Security Notes

- ✅ Client Secret lives **only** on Render — never in frontend code
- ✅ Webhook HMAC verification rejects fake Shopify events
- ✅ CORS restricted to your frontend URL in production
- ⚠️  Change `ALLOWED_ORIGINS` from `*` to your actual frontend URL once deployed
