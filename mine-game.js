(function () {
  'use strict';

  const API = 'https://dashboard.croscrow.com/mine-game/claim';
  const SHOWN_KEY = 'cc_mine_shown';
  const DELAY_MS  = 6000; // show after 6s on page

  // Don't show if already claimed this session
  if (sessionStorage.getItem(SHOWN_KEY)) return;

  // Only show on homepage or collection pages, not checkout
  const path = window.location.pathname;
  if (path.includes('/checkout') || path.includes('/account') || path.includes('/cart')) return;

  /* ── Styles ─────────────────────────────────────────────────────────────── */
  const css = `
  #cc-mine-overlay {
    position:fixed;inset:0;background:rgba(0,0,0,0.85);z-index:999999;
    display:flex;align-items:center;justify-content:center;
    font-family:'Helvetica Neue',Arial,sans-serif;
    opacity:0;transition:opacity 0.4s ease;
    backdrop-filter:blur(6px);
  }
  #cc-mine-overlay.visible { opacity:1; }
  #cc-mine-box {
    background:#0a0a0a;border:1px solid #222;border-radius:16px;
    padding:32px 28px 28px;width:min(420px,92vw);position:relative;
    box-shadow:0 0 60px rgba(255,180,0,0.15),0 0 0 1px #1a1a1a;
    transform:translateY(30px) scale(0.96);transition:transform 0.4s cubic-bezier(.34,1.56,.64,1);
  }
  #cc-mine-overlay.visible #cc-mine-box { transform:translateY(0) scale(1); }
  #cc-mine-close {
    position:absolute;top:14px;right:16px;background:none;border:none;
    color:#555;font-size:20px;cursor:pointer;line-height:1;padding:4px 8px;
    transition:color 0.2s;
  }
  #cc-mine-close:hover { color:#fff; }
  .cc-mine-eyebrow {
    font-size:9px;letter-spacing:4px;text-transform:uppercase;color:#f59e0b;
    margin-bottom:8px;font-weight:700;
  }
  .cc-mine-title {
    font-size:26px;font-weight:900;color:#fff;line-height:1.15;margin-bottom:4px;
    text-transform:uppercase;letter-spacing:1px;
  }
  .cc-mine-title span { color:#f59e0b; }
  .cc-mine-sub {
    font-size:12px;color:#666;margin-bottom:22px;line-height:1.6;
  }
  .cc-mine-sub strong { color:#aaa; }
  /* progress bar */
  .cc-mine-progress {
    display:flex;gap:6px;margin-bottom:20px;align-items:center;
  }
  .cc-mine-step {
    flex:1;height:4px;background:#1a1a1a;border-radius:2px;
    transition:background 0.4s;
  }
  .cc-mine-step.active { background:#f59e0b; }
  .cc-mine-step.bust { background:#ef4444; }
  .cc-mine-pct-label {
    font-size:11px;color:#f59e0b;font-weight:700;min-width:36px;text-align:right;
    letter-spacing:1px;
  }
  /* grid */
  .cc-mine-grid {
    display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:20px;
  }
  .cc-mine-tile {
    aspect-ratio:1;border-radius:10px;background:#111;border:1px solid #222;
    cursor:pointer;display:flex;align-items:center;justify-content:center;
    font-size:28px;transition:transform 0.15s,border-color 0.2s,background 0.2s;
    user-select:none;position:relative;overflow:hidden;
  }
  .cc-mine-tile:not(.revealed):hover {
    transform:scale(1.05);border-color:#333;background:#161616;
  }
  .cc-mine-tile::before {
    content:'?';font-size:22px;font-weight:900;color:#333;
    position:absolute;inset:0;display:flex;align-items:center;justify-content:center;
  }
  .cc-mine-tile.revealed::before { display:none; }
  .cc-mine-tile.revealed { cursor:default; }
  .cc-mine-tile.safe {
    background:#0d1f0d;border-color:#22c55e;
    animation:cc-safe-pop 0.35s cubic-bezier(.34,1.56,.64,1);
  }
  .cc-mine-tile.mine {
    background:#1f0d0d;border-color:#ef4444;
    animation:cc-shake 0.4s ease;
  }
  .cc-mine-tile.idle { opacity:0.3;cursor:not-allowed; }
  @keyframes cc-safe-pop {
    0%{transform:scale(0.5);opacity:0}
    100%{transform:scale(1);opacity:1}
  }
  @keyframes cc-shake {
    0%,100%{transform:translateX(0)}
    20%{transform:translateX(-6px)}
    40%{transform:translateX(6px)}
    60%{transform:translateX(-4px)}
    80%{transform:translateX(4px)}
  }
  /* buttons */
  .cc-mine-btns { display:flex;gap:10px; }
  .cc-mine-btn {
    flex:1;padding:13px;border-radius:8px;font-size:12px;font-weight:800;
    letter-spacing:2px;text-transform:uppercase;border:none;cursor:pointer;
    transition:transform 0.15s,opacity 0.2s;
  }
  .cc-mine-btn:hover { transform:translateY(-1px); }
  .cc-mine-btn:active { transform:translateY(0); }
  .cc-mine-btn-cashout {
    background:#f59e0b;color:#000;
    display:none;
  }
  .cc-mine-btn-cashout.show { display:block; }
  .cc-mine-btn-keep {
    background:#111;color:#666;border:1px solid #222;
  }
  /* result screen */
  .cc-mine-result {
    text-align:center;display:none;
  }
  .cc-mine-result.show { display:block; }
  .cc-mine-result-icon { font-size:52px;margin-bottom:12px;display:block; }
  .cc-mine-result-title {
    font-size:22px;font-weight:900;color:#fff;text-transform:uppercase;
    letter-spacing:1px;margin-bottom:6px;
  }
  .cc-mine-result-sub { font-size:13px;color:#666;margin-bottom:20px;line-height:1.6; }
  .cc-mine-code-box {
    background:#111;border:1px solid #f59e0b;border-radius:8px;
    padding:14px 18px;display:flex;align-items:center;justify-content:space-between;
    margin-bottom:18px;gap:12px;
  }
  .cc-mine-code {
    font-size:18px;font-weight:900;color:#f59e0b;letter-spacing:3px;
    font-family:monospace;
  }
  .cc-mine-copy {
    font-size:10px;letter-spacing:2px;text-transform:uppercase;
    background:none;border:1px solid #333;color:#888;border-radius:5px;
    padding:6px 12px;cursor:pointer;transition:all 0.2s;white-space:nowrap;
  }
  .cc-mine-copy:hover { border-color:#f59e0b;color:#f59e0b; }
  .cc-mine-copy.copied { border-color:#22c55e;color:#22c55e; }
  .cc-mine-shop-btn {
    display:block;width:100%;padding:14px;background:#fff;color:#000;
    border-radius:8px;text-align:center;text-decoration:none;
    font-size:11px;font-weight:900;letter-spacing:3px;text-transform:uppercase;
    transition:opacity 0.2s;box-sizing:border-box;
  }
  .cc-mine-shop-btn:hover { opacity:0.88; }
  .cc-mine-expires {
    font-size:10px;color:#444;text-align:center;margin-top:12px;letter-spacing:1px;
  }
  `;

  /* ── Game state ─────────────────────────────────────────────────────────── */
  // 6 tiles: positions 0-5
  // First 3 tiles the player picks are ALWAYS safe (rigged)
  // 4th pick is ALWAYS mine
  let safeCount = 0;
  let busted    = false;
  let done      = false;
  let tilesPicked = 0;
  const SAFE_EMOJIS  = ['💎','💎','💎'];
  const MINE_EMOJI   = '💣';
  const PCT_PER_SAFE = 5;

  function currentPct() { return safeCount * PCT_PER_SAFE; }

  /* ── DOM ────────────────────────────────────────────────────────────────── */
  function inject() {
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);

    const overlay = document.createElement('div');
    overlay.id = 'cc-mine-overlay';
    overlay.innerHTML = `
      <div id="cc-mine-box">
        <button id="cc-mine-close">✕</button>
        <div class="cc-mine-eyebrow">▪ C R O S C R O W ▪</div>
        <div class="cc-mine-title">Open At Your <span>Risk</span></div>
        <div class="cc-mine-sub">
          Each safe tile = <strong>+5% off</strong>. Hit a mine and it's all gone —
          unless you cash out first. <strong>The 4th tile always explodes.</strong>
        </div>
        <div class="cc-mine-progress">
          <div class="cc-mine-step" id="cc-step-0"></div>
          <div class="cc-mine-step" id="cc-step-1"></div>
          <div class="cc-mine-step" id="cc-step-2"></div>
          <div class="cc-mine-pct-label" id="cc-pct-lbl">0%</div>
        </div>
        <div class="cc-mine-grid" id="cc-grid"></div>
        <div class="cc-mine-btns">
          <button class="cc-mine-btn cc-mine-btn-cashout" id="cc-cashout">💰 Cash Out — ${currentPct()}%</button>
          <button class="cc-mine-btn cc-mine-btn-keep" id="cc-keep">No thanks</button>
        </div>
        <div class="cc-mine-result" id="cc-result"></div>
      </div>
    `;
    document.body.appendChild(overlay);

    // Build tiles
    const grid = overlay.querySelector('#cc-grid');
    for (let i = 0; i < 6; i++) {
      const tile = document.createElement('div');
      tile.className = 'cc-mine-tile';
      tile.dataset.idx = i;
      tile.addEventListener('click', () => onTile(tile));
      grid.appendChild(tile);
    }

    // Buttons
    overlay.querySelector('#cc-mine-close').addEventListener('click', dismiss);
    overlay.querySelector('#cc-keep').addEventListener('click', dismiss);
    overlay.querySelector('#cc-cashout').addEventListener('click', () => cashOut(overlay));

    // Animate in
    requestAnimationFrame(() => requestAnimationFrame(() => overlay.classList.add('visible')));
  }

  function onTile(tile) {
    if (done || tile.classList.contains('revealed')) return;
    tile.classList.add('revealed');
    tilesPicked++;

    // 4th pick = always mine; first 3 = always safe
    const isMine = tilesPicked >= 4;

    if (isMine) {
      tile.classList.add('mine');
      tile.textContent = MINE_EMOJI;
      busted = true;
      done = true;
      // Disable remaining tiles
      document.querySelectorAll('.cc-mine-tile:not(.revealed)').forEach(t => t.classList.add('idle'));
      // Small delay then show consolation result
      setTimeout(() => showResult(true), 600);
    } else {
      tile.classList.add('safe');
      tile.textContent = SAFE_EMOJIS[safeCount];
      safeCount++;
      updateProgress();
      // Show cash out button
      const co = document.getElementById('cc-cashout');
      co.textContent = `💰 Cash Out — ${currentPct()}%`;
      co.classList.add('show');
      // If 3 safes done, auto-trigger cashout flow
      if (safeCount === 3) {
        done = true;
        document.querySelectorAll('.cc-mine-tile:not(.revealed)').forEach(t => t.classList.add('idle'));
        setTimeout(() => cashOut(document.getElementById('cc-mine-overlay')), 500);
      }
    }
  }

  function updateProgress() {
    for (let i = 0; i < 3; i++) {
      const step = document.getElementById(`cc-step-${i}`);
      if (i < safeCount) step.classList.add('active');
    }
    document.getElementById('cc-pct-lbl').textContent = currentPct() + '%';
  }

  async function cashOut(overlay) {
    if (busted) return; // busted flow goes through showResult
    done = true;
    document.querySelectorAll('.cc-mine-tile:not(.revealed)').forEach(t => t.classList.add('idle'));
    document.querySelector('.cc-mine-btns').style.display = 'none';
    showResult(false, overlay);
  }

  async function showResult(isBust) {
    const overlay = document.getElementById('cc-mine-overlay');
    const resultEl = document.getElementById('cc-result');
    const pct = isBust ? 15 : currentPct(); // busted = consolation 15%

    // Hide grid + btns
    document.getElementById('cc-grid').style.opacity = '0.3';
    document.querySelector('.cc-mine-btns').style.display = 'none';

    resultEl.innerHTML = `<div style="font-size:13px;color:#555;letter-spacing:2px;text-transform:uppercase;">Generating your code…</div>`;
    resultEl.classList.add('show');

    let code = null;
    try {
      const resp = await fetch(API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pct }),
      });
      const data = await resp.json();
      code = data.code;
    } catch (e) {
      code = null;
    }

    if (isBust) {
      resultEl.innerHTML = `
        <span class="cc-mine-result-icon">💥</span>
        <div class="cc-mine-result-title">You hit a mine!</div>
        <div class="cc-mine-result-sub">
          Rough luck — but we've got you.<br>
          You still walk away with <strong style="color:#f59e0b;">15% off</strong>.
        </div>
        ${codeBox(code, pct)}
      `;
    } else {
      const icons = ['','🏃','💎','👑'];
      resultEl.innerHTML = `
        <span class="cc-mine-result-icon">${icons[safeCount] || '💎'}</span>
        <div class="cc-mine-result-title">Smart move — ${pct}% off!</div>
        <div class="cc-mine-result-sub">
          You cashed out at the right time.<br>Your code is valid for <strong style="color:#f59e0b;">24 hours</strong>.
        </div>
        ${codeBox(code, pct)}
      `;
    }

    // Wire up copy button
    const copyBtn = resultEl.querySelector('.cc-mine-copy');
    if (copyBtn && code) {
      copyBtn.addEventListener('click', () => {
        navigator.clipboard.writeText(code).then(() => {
          copyBtn.textContent = 'Copied!';
          copyBtn.classList.add('copied');
        });
      });
    }

    sessionStorage.setItem(SHOWN_KEY, '1');
  }

  function codeBox(code, pct) {
    if (!code) return `<div style="color:#ef4444;font-size:12px;margin-bottom:16px;">Couldn't generate code — try refreshing.</div>`;
    return `
      <div class="cc-mine-code-box">
        <span class="cc-mine-code">${code}</span>
        <button class="cc-mine-copy">Copy</button>
      </div>
      <a href="/collections/all" class="cc-mine-shop-btn">Shop Now — ${pct}% Off</a>
      <div class="cc-mine-expires">⏳ Expires in 24 hours · Single use</div>
    `;
  }

  function dismiss() {
    const overlay = document.getElementById('cc-mine-overlay');
    if (!overlay) return;
    overlay.classList.remove('visible');
    setTimeout(() => overlay.remove(), 400);
    sessionStorage.setItem(SHOWN_KEY, '1');
  }

  /* ── Boot ───────────────────────────────────────────────────────────────── */
  function boot() {
    setTimeout(() => {
      inject();
    }, DELAY_MS);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
