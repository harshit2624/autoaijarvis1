/**
 * keep-alive.js
 * Render's free tier sleeps after 15 min of inactivity.
 * Run this script on any always-on machine (your PC, a cron job, GitHub Actions)
 * to ping your server every 10 minutes and keep it awake.
 *
 * HOW TO USE (choose one):
 *
 * Option A — Run locally while you work:
 *   node keep-alive.js
 *
 * Option B — GitHub Actions cron (free, fully automatic):
 *   See keep-alive-action.yml in this folder
 *
 * Option C — Upgrade to Render Starter plan ($7/mo) and skip this entirely
 */

const RENDER_URL = process.env.RENDER_URL || "https://autoaijarvis1.onrender.com/";
const INTERVAL_MS = 10 * 60 * 1000; // 10 minutes

async function ping() {
  try {
    const fetch = (...a) => import("node-fetch").then(({ default: f }) => f(...a));
    const f = await fetch;
    const res = await f(`${RENDER_URL}/health`);
    const data = await res.json();
    console.log(`[${new Date().toISOString()}] ✅ Ping OK — uptime: ${Math.round(data.uptime)}s`);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] ❌ Ping failed:`, err.message);
  }
}

console.log(`🏓 Keep-alive pinging ${RENDER_URL} every 10 minutes`);
ping();
setInterval(ping, INTERVAL_MS);
