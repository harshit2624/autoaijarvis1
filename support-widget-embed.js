/* CrosCrow Support Widget embed script.
   Two ways to use it:

   1. Plain drop-in (own floating button + iframe):
      <script src="https://dashboard.croscrow.com/support-widget-embed.js" async></script>

   2. Manual integration (your own button/container, e.g. a theme block) —
      call window.initSupportWidget({ container, customerEmail, customerName, shopDomain })
      once the script has loaded. If this is called, the script's own
      default floating button is skipped automatically. */
(function () {
  if (window.__croscrowSupportEmbedLoaded) return;
  window.__croscrowSupportEmbedLoaded = true;

  var WIDGET_ORIGIN = 'https://dashboard.croscrow.com';
  var manualMode = false;
  var autoInjected = null;

  // The widget iframe is cross-origin (dashboard.croscrow.com inside
  // croscrow.com) — browsers restrict/wipe localStorage written INSIDE
  // third-party iframes, so the iframe can't reliably remember its own
  // chat ID across page loads. Persist it here instead, in the parent
  // page's own (same-origin, unrestricted) localStorage, and pass it
  // into the iframe via a query param.
  var CHAT_ID_KEY = 'cc_support_chat_id';

  // Applies to both integration modes (auto-injected button AND manual
  // theme-block integration) — whichever iframe is showing, save the chat
  // ID it reports back so the NEXT page load can resume the same chat.
  window.addEventListener('message', function (e) {
    if (e.data && e.data.croscrowSupport === 'chatId' && e.data.chatId) {
      try { localStorage.setItem(CHAT_ID_KEY, e.data.chatId); } catch (err) {}
    }
  });

  function buildIframe(opts) {
    opts = opts || {};
    var src = WIDGET_ORIGIN + '/support-widget.html';
    var params = [];
    if (opts.customerEmail) params.push('email=' + encodeURIComponent(opts.customerEmail));
    if (opts.customerName)  params.push('name=' + encodeURIComponent(opts.customerName));
    if (opts.shopDomain)    params.push('shop=' + encodeURIComponent(opts.shopDomain));
    var savedChatId = null;
    try { savedChatId = localStorage.getItem(CHAT_ID_KEY); } catch (e) {}
    if (savedChatId) params.push('chatId=' + encodeURIComponent(savedChatId));
    if (params.length) src += '?' + params.join('&');
    var frame = document.createElement('iframe');
    frame.src = src;
    frame.title = 'CrosCrow Support';
    frame.style.width = '100%';
    frame.style.height = '100%';
    frame.style.border = 'none';
    frame.style.colorScheme = 'dark';
    return frame;
  }

  // ── Manual integration API — for a custom button/container (theme block,
  // custom Liquid section, etc) that wants the chat iframe rendered inside
  // a div it controls, instead of the script's own floating button.
  window.initSupportWidget = function (opts) {
    manualMode = true;
    if (autoInjected) {
      autoInjected.frame.remove();
      autoInjected.launcher.remove();
      autoInjected = null;
    }
    var container = opts && opts.container;
    if (!container) return null;
    container.innerHTML = '';
    var frame = buildIframe(opts);
    container.appendChild(frame);
    return frame;
  };

  // ── Default standalone floating button — only runs if nothing called
  // initSupportWidget() shortly after the script loaded.
  setTimeout(function () {
    if (manualMode) return;
    autoInjectDefault();
  }, 300);

  function autoInjectDefault() {
    // Stacked above a typical WhatsApp chat widget (usually ~22px from the
    // bottom, ~56-60px tall) plus, on mobile, above the storefront's own
    // bottom tab bar (Account/Shop/Home/Wishlist/Cart) too — both of which
    // this button was previously overlapping.
    var LAUNCHER_BOTTOM_DESKTOP = '94px';
    var LAUNCHER_BOTTOM_MOBILE  = '125px'; // sits between the scroll-to-top button (above) and WhatsApp (below)
    var LAUNCHER_RIGHT = '22px';
    var LAUNCHER_RIGHT_MOBILE = '15px'; // shifted slightly right of the scroll-to-top button's 17px offset, per feedback

    var launcher = document.createElement('button');
    launcher.id = 'croscrow-support-launcher';
    launcher.setAttribute('aria-label', 'Open support chat');
    Object.assign(launcher.style, {
      position: 'fixed', bottom: LAUNCHER_BOTTOM_DESKTOP, right: LAUNCHER_RIGHT, zIndex: 999999,
      width: '56px', height: '56px', borderRadius: '50%', border: 'none',
      background: '#0a0a0a', color: '#fff', padding: 0, overflow: 'hidden',
      fontSize: '24px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
      boxShadow: '0 6px 24px rgba(0,0,0,0.35)',
      transition: 'transform 0.2s ease, bottom 0.2s ease',
    });
    launcher.onmouseenter = function () { launcher.style.transform = 'scale(1.08)'; };
    launcher.onmouseleave = function () { launcher.style.transform = 'scale(1)'; };

    // Crow icon on the launcher itself — falls back to the chat emoji if
    // crowicon.png is missing/fails to load.
    var closeLabel = document.createElement('span');
    closeLabel.textContent = '✕';
    closeLabel.style.fontSize = '22px';
    var fallbackEmoji = document.createElement('span');
    fallbackEmoji.textContent = '💬';
    fallbackEmoji.style.fontSize = '24px';
    var crowEl = document.createElement('img');
    crowEl.src = WIDGET_ORIGIN + '/crowicon.png';
    crowEl.alt = 'Support';
    crowEl.style.width = '100%';
    crowEl.style.height = '100%';
    crowEl.style.objectFit = 'cover';
    crowEl.style.borderRadius = '50%';
    crowEl.style.pointerEvents = 'none';
    var crowFailed = false;

    function updateIcon(isOpen) {
      closeLabel.style.display = isOpen ? 'block' : 'none';
      var showCrow = !isOpen && !crowFailed;
      crowEl.style.display = showCrow ? 'block' : 'none';
      fallbackEmoji.style.display = (!isOpen && !showCrow) ? 'block' : 'none';
    }
    crowEl.addEventListener('error', function () { crowFailed = true; updateIcon(open); });

    launcher.appendChild(crowEl);
    launcher.appendChild(fallbackEmoji);
    launcher.appendChild(closeLabel);

    var frame = buildIframe();
    Object.assign(frame.style, {
      position: 'fixed', zIndex: 999999,
      width: '380px', height: '560px', maxHeight: '75vh',
      borderRadius: '16px', boxShadow: '0 12px 48px rgba(0,0,0,0.35)',
      display: 'none',
    });

    var mq = window.matchMedia('(max-width: 480px)');
    function applyResponsive() {
      if (mq.matches) {
        launcher.style.bottom = LAUNCHER_BOTTOM_MOBILE;
        launcher.style.right = LAUNCHER_RIGHT_MOBILE;
        Object.assign(frame.style, { width: '92vw', height: '65vh', right: '4vw', bottom: 'calc(' + LAUNCHER_BOTTOM_MOBILE + ' + 66px)' });
      } else {
        launcher.style.bottom = LAUNCHER_BOTTOM_DESKTOP;
        launcher.style.right = LAUNCHER_RIGHT;
        Object.assign(frame.style, { width: '380px', height: '560px', right: LAUNCHER_RIGHT, bottom: 'calc(' + LAUNCHER_BOTTOM_DESKTOP + ' + 66px)' });
      }
    }
    applyResponsive();
    mq.addEventListener ? mq.addEventListener('change', applyResponsive) : mq.addListener(applyResponsive);

    var open = false;
    updateIcon(open);
    function toggle() {
      open = !open;
      frame.style.display = open ? 'block' : 'none';
      updateIcon(open);
      if (open && frame.contentWindow) {
        frame.contentWindow.postMessage({ croscrowSupport: 'opened' }, '*');
      }
    }
    launcher.onclick = toggle;

    window.addEventListener('message', function (e) {
      if (e.data && e.data.croscrowSupport === 'close') toggle();
    });

    document.body.appendChild(frame);
    document.body.appendChild(launcher);
    autoInjected = { frame: frame, launcher: launcher };
  }
})();
