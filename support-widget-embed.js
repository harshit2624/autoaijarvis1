/* CrosCrow Support Widget — floating launcher + iframe.
   Embed via: <script src="https://dashboard.croscrow.com/support-widget-embed.js" async></script>
   Drop this one line into any Shopify theme (theme.liquid before </body>, or
   a Custom HTML / Additional Scripts section) to add the support bubble. */
(function () {
  if (window.__croscrowSupportLoaded) return;
  window.__croscrowSupportLoaded = true;

  var WIDGET_ORIGIN = 'https://dashboard.croscrow.com';

  var launcher = document.createElement('button');
  launcher.id = 'croscrow-support-launcher';
  launcher.innerHTML = '💬';
  launcher.setAttribute('aria-label', 'Open support chat');
  Object.assign(launcher.style, {
    position: 'fixed', bottom: '22px', right: '22px', zIndex: 999999,
    width: '58px', height: '58px', borderRadius: '50%', border: 'none',
    background: 'linear-gradient(135deg,#6366f1,#4f46e5)', color: '#fff',
    fontSize: '24px', cursor: 'pointer',
    boxShadow: '0 6px 24px rgba(99,102,241,0.45)',
    transition: 'transform 0.2s ease',
  });
  launcher.onmouseenter = function () { launcher.style.transform = 'scale(1.08)'; };
  launcher.onmouseleave = function () { launcher.style.transform = 'scale(1)'; };

  var frame = document.createElement('iframe');
  frame.src = WIDGET_ORIGIN + '/support-widget.html';
  frame.title = 'CrosCrow Support';
  Object.assign(frame.style, {
    position: 'fixed', bottom: '92px', right: '22px', zIndex: 999999,
    width: '380px', height: '560px', maxHeight: '75vh', border: 'none',
    borderRadius: '16px', boxShadow: '0 12px 48px rgba(0,0,0,0.35)',
    display: 'none', colorScheme: 'dark',
  });

  var mq = window.matchMedia('(max-width: 480px)');
  function applyResponsive() {
    if (mq.matches) {
      Object.assign(frame.style, { width: '92vw', height: '70vh', right: '4vw', bottom: '88px' });
    } else {
      Object.assign(frame.style, { width: '380px', height: '560px', right: '22px', bottom: '92px' });
    }
  }
  applyResponsive();
  mq.addEventListener ? mq.addEventListener('change', applyResponsive) : mq.addListener(applyResponsive);

  var open = false;
  function toggle() {
    open = !open;
    frame.style.display = open ? 'block' : 'none';
    launcher.innerHTML = open ? '✕' : '💬';
  }
  launcher.onclick = toggle;

  window.addEventListener('message', function (e) {
    if (e.data && e.data.croscrowSupport === 'close') toggle();
  });

  document.body.appendChild(frame);
  document.body.appendChild(launcher);
})();
