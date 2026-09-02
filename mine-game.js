(function () {
  'use strict';

  const API      = 'https://dashboard.croscrow.com/mine-game/claim';
  const SHOWN_KEY = 'cc_mine_shown';
  const DELAY_MS  = 6000;

  // ── URL param override ──────────────────────────────────────────────────────
  // Share croscrow.com/?mine=1 with your group to open the game immediately
  const params     = new URLSearchParams(window.location.search);
  const forcedOpen = params.has('mine') && params.get('mine') !== '0';

  // Don't show if already claimed this session (unless forced via param)
  if (!forcedOpen && sessionStorage.getItem(SHOWN_KEY)) return;

  // Skip checkout / account / cart pages
  const path = window.location.pathname;
  if (path.includes('/checkout') || path.includes('/account') || path.includes('/cart')) return;

  /* ── Game constants ──────────────────────────────────────────────────────── */
  const TOTAL    = 16;
  const MINES    = 8;
  const SAFE_MAX = TOTAL - MINES; // 8 max safe picks

  // ₹ reward ladder (safe tile 1–8) — every tile pays more, max ₹1000
  const REWARDS = [100, 200, 300, 400, 500, 600, 800, 1000];

  /* ── Styles ──────────────────────────────────────────────────────────────── */
  const css = `
  #cc-mine-ov {
    position:fixed;inset:0;z-index:999999;
    display:flex;align-items:center;justify-content:center;
    background:rgba(0,0,0,.82);backdrop-filter:blur(10px);
    padding:12px;opacity:0;transition:opacity .4s ease;
    font-family:'Helvetica Neue',Arial,sans-serif;
  }
  #cc-mine-ov.vis { opacity:1; }

  #cc-mine-card {
    background:#0c0c0c;border:1px solid #1a1a1a;border-radius:16px;
    width:min(400px,100%);max-height:88vh;overflow:hidden;
    display:flex;flex-direction:column;position:relative;
    box-shadow:0 0 0 1px #141414,0 30px 60px rgba(0,0,0,.9);
    transform:translateY(28px) scale(.95);
    transition:transform .45s cubic-bezier(.34,1.4,.64,1);
  }
  #cc-mine-ov.vis #cc-mine-card { transform:translateY(0) scale(1); }

  .cc-x {
    position:absolute;top:12px;right:14px;
    background:none;border:none;color:#252525;font-size:16px;
    cursor:pointer;padding:4px 8px;border-radius:5px;line-height:1;
    font-family:monospace;transition:color .2s;
  }
  .cc-x:hover { color:#666; }

  .cc-head {
    padding:18px 20px 12px;border-bottom:1px solid #141414;flex-shrink:0;
  }
  .cc-brand {
    font-size:8px;letter-spacing:5px;text-transform:uppercase;
    color:#272727;margin-bottom:4px;
  }
  .cc-title {
    font-size:26px;font-weight:900;text-transform:uppercase;
    letter-spacing:.5px;color:#fff;line-height:1;
  }
  .cc-info {
    font-size:9px;letter-spacing:2px;color:#272727;
    text-transform:uppercase;margin-top:4px;
  }

  .cc-meter {
    padding:9px 20px;background:#090909;
    border-bottom:1px solid #141414;
    display:flex;align-items:center;justify-content:space-between;
    flex-shrink:0;
  }
  .cc-meter-lbl {
    font-size:8px;letter-spacing:3px;text-transform:uppercase;color:#272727;
  }
  .cc-meter-val {
    font-size:22px;font-weight:900;color:#fff;letter-spacing:1px;
    transition:color .3s,text-shadow .3s;
  }
  .cc-meter-val.hot { color:#22c55e;text-shadow:0 0 16px rgba(34,197,94,.4); }
  .cc-meter-tag {
    font-size:8px;letter-spacing:2px;text-transform:uppercase;
    color:#252525;padding:3px 8px;border:1px solid #1a1a1a;border-radius:3px;
    transition:all .3s;
  }
  .cc-meter-tag.alive { color:#22c55e;border-color:#1a3d24;background:rgba(34,197,94,.04); }

  .cc-odds {
    padding:6px 20px 0;display:flex;gap:16px;flex-shrink:0;
  }
  .cc-odds span {
    font-size:8px;letter-spacing:1.5px;text-transform:uppercase;color:#222;
  }

  .cc-grid-wrap { padding:12px 14px;flex-shrink:0; }

  .cc-grid {
    display:grid;grid-template-columns:repeat(4,1fr);gap:6px;
  }

  .cc-tile {
    aspect-ratio:1;border-radius:7px;
    background-color:#0e0e0e;
    background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12'%3E%3Cpath d='M0 6h12M6 0v12' stroke='%23ffffff' stroke-width='.3' opacity='.08'/%3E%3C/svg%3E");
    border:1px solid #1c1c1c;cursor:pointer;
    display:flex;align-items:center;justify-content:center;
    position:relative;overflow:hidden;user-select:none;
    transition:transform .12s,border-color .2s,background-color .2s;
  }
  .cc-tile::before {
    content:'';position:absolute;top:3px;left:3px;
    width:4px;height:4px;background:rgba(255,255,255,.07);border-radius:1px;
  }
  .cc-tile::after {
    content:'';position:absolute;inset:0;pointer-events:none;
    background:linear-gradient(135deg,rgba(255,255,255,.04) 0%,transparent 50%);
  }
  .cc-tile:not(.rev):not(.idle):hover {
    transform:scale(1.08) translateY(-2px);
    border-color:#333;background-color:#181818;
    box-shadow:0 6px 20px rgba(0,0,0,.7);
  }
  .cc-tile.idle { opacity:.15;cursor:not-allowed;transform:none!important; }
  .cc-tile.safe {
    background-color:#f5f5f5;background-image:none;
    border-color:#e0e0e0;cursor:default;
    animation:cc-sp .35s cubic-bezier(.34,1.5,.64,1) both;
  }
  .cc-tile.safe::before,.cc-tile.safe::after { display:none; }
  .cc-tile.mine {
    background-color:#180808;background-image:none;
    border-color:#5c1a1a;cursor:default;
    animation:cc-bl .4s ease both;
    box-shadow:0 0 24px rgba(220,38,38,.2);
  }
  .cc-tile.mine::before,.cc-tile.mine::after { display:none; }
  .cc-tile.rev { cursor:default; }

  @keyframes cc-sp {
    0%{transform:scale(.6);opacity:0}
    70%{transform:scale(1.1)}
    100%{transform:scale(1);opacity:1}
  }
  @keyframes cc-bl {
    0%{transform:scale(.5) rotate(-5deg);opacity:0}
    40%{transform:scale(1.15) rotate(2deg)}
    100%{transform:scale(1) rotate(0);opacity:1}
  }

  .cc-inner {
    display:flex;flex-direction:column;align-items:center;justify-content:center;
    gap:0;z-index:1;position:relative;
  }
  .cc-emoji { font-size:18px;line-height:1; }
  .cc-amt { font-size:11px;font-weight:900;color:#111;letter-spacing:.5px;margin-top:2px; }

  .cc-btns { padding:0 14px 14px;display:flex;gap:8px;flex-shrink:0; }
  .cc-btn {
    flex:1;border:none;border-radius:7px;
    font-size:11px;font-weight:900;letter-spacing:2.5px;
    text-transform:uppercase;padding:12px 6px;cursor:pointer;
    transition:transform .12s,opacity .2s,box-shadow .2s;
  }
  .cc-btn:hover { transform:translateY(-1px); }
  .cc-btn:active { transform:translateY(0); }
  .cc-cash { background:#fff;color:#000;display:none;box-shadow:0 2px 12px rgba(255,255,255,.12); }
  .cc-cash.show { display:block; }
  .cc-cash:hover { box-shadow:0 4px 20px rgba(255,255,255,.22); }
  .cc-skip { background:#111;color:#2a2a2a;border:1px solid #1c1c1c; }
  .cc-skip:hover { color:#555;border-color:#2e2e2e; }

  .cc-result {
    padding:20px 20px 16px;text-align:center;
    display:none;flex-direction:column;align-items:center;flex:1;
    animation:cc-fu .4s cubic-bezier(.34,1.2,.64,1) both;
  }
  .cc-result.show { display:flex; }
  @keyframes cc-fu {
    from{opacity:0;transform:translateY(12px)}
    to{opacity:1;transform:translateY(0)}
  }
  .cc-r-icon { font-size:44px;margin-bottom:10px; }
  .cc-r-title {
    font-size:26px;font-weight:900;text-transform:uppercase;
    letter-spacing:1px;color:#fff;margin-bottom:4px;
  }
  .cc-r-sub { font-size:10px;color:#888;line-height:1.8;margin-bottom:16px; }
  .cc-r-sub em { color:#bbb;font-style:normal; }
  .cc-code-box {
    width:100%;background:#090909;border:1px solid #e0e0e0;
    border-radius:8px;padding:12px 14px;
    display:flex;align-items:center;justify-content:space-between;
    gap:10px;margin-bottom:10px;
    box-shadow:0 0 24px rgba(255,255,255,.04);
  }
  .cc-code { font-size:15px;font-weight:900;color:#fff;letter-spacing:3px;font-family:monospace; }
  .cc-copy {
    font-size:8px;letter-spacing:2px;text-transform:uppercase;
    background:none;border:1px solid #1e1e1e;color:#363636;
    border-radius:4px;padding:5px 10px;cursor:pointer;
    transition:all .2s;white-space:nowrap;font-family:monospace;
  }
  .cc-copy:hover { border-color:#555;color:#888; }
  .cc-copy.cp { border-color:#22c55e;color:#22c55e; }
  .cc-shop {
    display:block;width:100%;background:#fff;color:#000;
    border:none;border-radius:7px;padding:13px;cursor:pointer;
    font-size:11px;font-weight:900;letter-spacing:3px;
    text-transform:uppercase;transition:opacity .2s,transform .12s;
    margin-bottom:10px;text-decoration:none;text-align:center;
  }
  .cc-shop:hover { opacity:.88; }
  .cc-exp { font-size:9px;color:#555;letter-spacing:1.5px;text-transform:uppercase;margin-bottom:8px; }
  .cc-min-order {
    width:100%;background:#111;border:1px solid #2a2a2a;border-radius:7px;
    padding:10px 14px;display:flex;align-items:center;justify-content:space-between;
    margin-bottom:10px;
  }
  .cc-min-order-lbl { font-size:8px;letter-spacing:2px;text-transform:uppercase;color:#444; }
  .cc-min-order-val { font-size:16px;font-weight:900;color:#fff;letter-spacing:1px; }
  .cc-rplay {
    margin-top:12px;font-size:8px;letter-spacing:2px;text-transform:uppercase;
    background:none;border:none;color:#555;cursor:pointer;
    transition:color .2s;font-family:monospace;
  }
  .cc-rplay:hover { color:#999; }
  `;

  /* ── State ───────────────────────────────────────────────────────────────── */
  let mineSet   = null;
  let safeCount = 0;
  let pickCount = 0;
  let done      = false;
  let safePicks = [];

  /* ── Mine placement (deferred) ───────────────────────────────────────────── */
  // First 5 picks are ALWAYS safe (guaranteed ₹100→₹500 zone, no bust)
  // Mines only become active from pick 5 onward (₹400→₹1000 danger zone)
  const SAFE_GUARANTEE = 4;

  function placeMines(excludedPicks) {
    // exclude all guaranteed-safe picks so far
    const excl = new Set(excludedPicks);
    const pool = Array.from({ length: TOTAL }, (_, i) => i).filter(i => !excl.has(i));
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    return new Set(pool.slice(0, MINES));
  }

  /* ── DOM injection ───────────────────────────────────────────────────────── */
  function inject() {
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);

    const ov = document.createElement('div');
    ov.id = 'cc-mine-ov';
    ov.innerHTML = `
      <div id="cc-mine-card">
        <button class="cc-x" id="cc-close">✕</button>

        <div class="cc-head">
          <div class="cc-brand">▪ C R O S C R O W ▪</div>
          <div class="cc-title">₹100 Mine Risk</div>
          <div class="cc-info">First ₹400 is safe · danger starts after</div>
        </div>

        <div class="cc-meter">
          <div>
            <div class="cc-meter-lbl">Cashout Value</div>
            <div class="cc-meter-val" id="cc-mv">₹0</div>
          </div>
          <div class="cc-meter-tag" id="cc-mt">WAITING</div>
        </div>

        <div id="cc-game">
          <div class="cc-grid-wrap">
            <div class="cc-grid" id="cc-grid"></div>
          </div>
          <div class="cc-btns" id="cc-btns">
            <button class="cc-btn cc-cash" id="cc-cash">Cash Out</button>
            <button class="cc-btn cc-skip" id="cc-skip">No Thanks</button>
          </div>
        </div>

        <div class="cc-result" id="cc-result"></div>
      </div>
    `;
    document.body.appendChild(ov);

    // Build grid
    const grid = ov.querySelector('#cc-grid');
    for (let i = 0; i < TOTAL; i++) {
      const t = document.createElement('div');
      t.className = 'cc-tile';
      t.dataset.i = i;
      t.addEventListener('click', () => onPick(t));
      grid.appendChild(t);
    }

    ov.querySelector('#cc-close').addEventListener('click', dismiss);
    ov.querySelector('#cc-skip').addEventListener('click', dismiss);
    ov.querySelector('#cc-cash').addEventListener('click', () => cashOut());

    requestAnimationFrame(() => requestAnimationFrame(() => ov.classList.add('vis')));
  }

  function allTiles()  { return Array.from(document.querySelectorAll('.cc-tile')); }
  function openTiles() { return allTiles().filter(t => !t.classList.contains('rev')); }

  /* ── Pick ────────────────────────────────────────────────────────────────── */
  function onPick(tile) {
    if (done || tile.classList.contains('rev') || tile.classList.contains('idle')) return;
    const idx = parseInt(tile.dataset.i);
    tile.classList.add('rev');
    pickCount++;

    // Place mines only after the 5th safe pick (guarantees ₹100→₹500 zone is always safe)
    if (pickCount === SAFE_GUARANTEE && !mineSet) {
      mineSet = placeMines(safePicks.concat(idx));
    }

    // No mine possible until after guaranteed safe zone
    const isMine = mineSet && mineSet.has(idx);

    if (isMine) {
      tile.classList.add('mine');
      tile.innerHTML = '<div class="cc-inner"><div class="cc-emoji">💣</div></div>';
      done = true;
      openTiles().forEach(t => t.classList.add('idle'));
      revealAllMines();
      setTimeout(() => showResult(true), 700);
    } else {
      safePicks.push(idx);
      safeCount++;
      const reward = REWARDS[safeCount - 1] || REWARDS[REWARDS.length - 1];

      tile.classList.add('safe');
      tile.innerHTML = `<div class="cc-inner"><div class="cc-emoji">💎</div><div class="cc-amt">₹${reward}</div></div>`;

      updateMeter(reward);

      const cashBtn = document.getElementById('cc-cash');
      cashBtn.textContent = `Cash Out ₹${reward}`;
      cashBtn.classList.add('show');

      if (safeCount >= SAFE_MAX) {
        done = true;
        openTiles().forEach(t => t.classList.add('idle'));
        setTimeout(() => showResult(false), 500);
      }
    }
  }

  function revealAllMines() {
    if (!mineSet) return;
    let delay = 100;
    openTiles().forEach(t => {
      if (mineSet.has(parseInt(t.dataset.i))) {
        setTimeout(() => {
          t.classList.add('rev', 'mine');
          t.innerHTML = '<div class="cc-inner"><div class="cc-emoji">💣</div></div>';
        }, delay);
        delay += 80;
      }
    });
  }

  function updateMeter(reward) {
    const mv = document.getElementById('cc-mv');
    const mt = document.getElementById('cc-mt');
    mv.textContent = '₹' + reward;
    mv.classList.add('hot');
    mt.textContent = 'IN PROFIT';
    mt.classList.add('alive');
  }


  /* ── Cash out ────────────────────────────────────────────────────────────── */
  function cashOut() {
    if (done || safeCount === 0) return;
    done = true;
    openTiles().forEach(t => t.classList.add('idle'));
    showResult(false);
  }

  /* ── Result ──────────────────────────────────────────────────────────────── */
  async function showResult(isBust) {
    document.getElementById('cc-btns').style.display = 'none';
    const grid = document.getElementById('cc-grid');
    grid.style.opacity = '.18';
    grid.style.transition = 'opacity .4s';

    const consolation = isBust && safeCount === 0;
    const pct         = consolation ? 5 : 0; // fallback % for consolation
    const reward      = consolation ? 50 : (REWARDS[safeCount - 1] || 50);

    setTimeout(async () => {
      document.getElementById('cc-game').style.display = 'none';
      const rs = document.getElementById('cc-result');

      // Show loading
      rs.innerHTML = '<div style="font-size:10px;color:#333;letter-spacing:2px;text-transform:uppercase;">Generating your code…</div>';
      rs.classList.add('show');

      // Fetch fixed code from server
      let code = null, minOrder = reward * 3;
      try {
        const resp = await fetch(API, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reward_inr: reward }),
        });
        const data = await resp.json();
        code = data.code;
        if (data.minOrder) minOrder = data.minOrder;
      } catch (_) {}

      const exits = ['', 'Smart exit.', 'Good read.', 'Solid nerve.', 'Ice cold.', 'You absolute monster.'];

      if (isBust) {
        const msg = consolation
          ? 'Hit a mine before collecting. <em>₹50 consolation</em> is yours.'
          : `Exploded with <em>₹${reward}</em> still on the table. Use it.`;
        rs.innerHTML = `
          <div class="cc-r-icon">💥</div>
          <div class="cc-r-title">Blown Up.</div>
          <div class="cc-r-sub">${msg}</div>
          ${codeBox(code, reward, minOrder)}
          <button class="cc-rplay" id="cc-rplay">↩ Play again</button>`;
      } else {
        rs.innerHTML = `
          <div class="cc-r-icon">💸</div>
          <div class="cc-r-title">${exits[Math.min(safeCount, exits.length - 1)]}</div>
          <div class="cc-r-sub">Cashed at <em>₹${reward}</em>. Use it now.</div>
          ${codeBox(code, reward, minOrder)}
          <button class="cc-rplay" id="cc-rplay">↩ Play again</button>`;
      }

      const copyBtn = rs.querySelector('.cc-copy');
      if (copyBtn && code) {
        copyBtn.addEventListener('click', () => {
          navigator.clipboard.writeText(code).catch(() => {});
          copyBtn.textContent = 'Copied!';
          copyBtn.classList.add('cp');
          setTimeout(() => { copyBtn.textContent = 'Copy'; copyBtn.classList.remove('cp'); }, 2000);
        });
      }

      document.getElementById('cc-rplay').addEventListener('click', resetGame);
      sessionStorage.setItem(SHOWN_KEY, '1');
    }, 380);
  }

  function codeBox(code, reward, minOrder) {
    if (!code) {
      return `<div style="color:#ef4444;font-size:10px;margin-bottom:14px;">Code error — try refreshing.</div>`;
    }
    return `
      <div class="cc-code-box">
        <span class="cc-code">${code}</span>
        <button class="cc-copy">Copy</button>
      </div>
      <a href="/collections/all" class="cc-shop">Shop Now — ₹${reward} Off</a>
      <div class="cc-min-order">
        <span class="cc-min-order-val">₹${minOrder}</span>
        <span class="cc-min-order-lbl">Min. Order Required</span>
      </div>
      <p class="cc-exp">· single use · apply at checkout</p>`;
  }

  /* ── Reset ───────────────────────────────────────────────────────────────── */
  function resetGame() {
    mineSet = null; safeCount = 0; pickCount = 0; done = false; safePicks = [];

    document.getElementById('cc-result').classList.remove('show');
    document.getElementById('cc-result').innerHTML = '';
    document.getElementById('cc-game').style.display = '';
    document.getElementById('cc-grid').style.opacity = '1';
    document.getElementById('cc-btns').style.display = '';
    const cash = document.getElementById('cc-cash');
    cash.classList.remove('show');
    cash.textContent = 'Cash Out';
    document.getElementById('cc-mv').textContent = '₹0';
    document.getElementById('cc-mv').classList.remove('hot');
    document.getElementById('cc-mt').textContent = 'WAITING';
    document.getElementById('cc-mt').classList.remove('alive');

    allTiles().forEach(t => { t.className = 'cc-tile'; t.innerHTML = ''; });
  }

  /* ── Dismiss ─────────────────────────────────────────────────────────────── */
  function dismiss() {
    const ov = document.getElementById('cc-mine-ov');
    if (!ov) return;
    ov.classList.remove('vis');
    setTimeout(() => ov.remove(), 400);
    sessionStorage.setItem(SHOWN_KEY, '1');
  }

  /* ── Boot ────────────────────────────────────────────────────────────────── */
  function boot() {
    const delay = forcedOpen ? 0 : DELAY_MS;
    setTimeout(inject, delay);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
