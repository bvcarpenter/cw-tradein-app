(function() {
  /* Capture base URL synchronously (document.currentScript is only
     available during the initial synchronous execution of the script) */
  var scriptEl = document.currentScript;
  var base = scriptEl ? scriptEl.src.replace(/trade-form-modal\.js.*$/, '')
                      : 'https://cw-tradein-app.ben-d91.workers.dev/';
  var tradePageUrl = '/pages/trade-in'; // fallback link for mobile

  function isMobile() { return window.innerWidth < 768; }

  /* ── Bind trigger button ── */
  function init() {
    var btn = document.getElementById('cw-trade-trigger');
    if (!btn) return;

    btn.addEventListener('click', function(e) {
      e.preventDefault();
      if (isMobile()) { window.location.href = tradePageUrl; return; }
      openModal();
    });
  }

  /* Run init now if DOM is ready, otherwise wait */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  /* ── Modal overlay ── */
  var overlay, modalWrap, iframe;

  function buildModal() {
    overlay = document.createElement('div');
    overlay.id = 'cw-modal-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;opacity:0;transition:opacity .25s ease;';

    modalWrap = document.createElement('div');
    modalWrap.style.cssText = 'position:relative;width:94vw;max-width:960px;height:90vh;background:#fff;box-shadow:0 20px 60px rgba(0,0,0,.3);overflow:hidden;display:flex;flex-direction:column;';

    /* header bar */
    var header = document.createElement('div');
    header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:14px 20px;border-bottom:1px solid #e0ddd8;flex-shrink:0;background:#fff;';

    var title = document.createElement('span');
    title.textContent = 'Trade-In / Sell Your Gear';
    title.style.cssText = "font-family:'Roboto Condensed',sans-serif;font-size:13px;font-weight:700;letter-spacing:0.15em;text-transform:uppercase;color:#333;";

    var closeBtn = document.createElement('button');
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
    closeBtn.style.cssText = 'background:none;border:none;cursor:pointer;color:#888;padding:4px;display:flex;align-items:center;justify-content:center;transition:color .15s;';
    closeBtn.onmouseover = function() { this.style.color = '#111'; };
    closeBtn.onmouseout = function() { this.style.color = '#888'; };
    closeBtn.addEventListener('click', closeModal);

    header.appendChild(title);
    header.appendChild(closeBtn);

    iframe = document.createElement('iframe');
    iframe.src = base + 'trade-form-embed';
    iframe.style.cssText = 'display:block;width:100%;flex:1;border:none;';
    iframe.setAttribute('title', 'Camera West Trade-In / Sell');

    modalWrap.appendChild(header);
    modalWrap.appendChild(iframe);
    overlay.appendChild(modalWrap);
    document.body.appendChild(overlay);

    overlay.addEventListener('click', function(e) {
      if (e.target === overlay) closeModal();
    });

    /* pass customer data once loaded */
    if (window.__cwCustomer) {
      iframe.addEventListener('load', function() {
        iframe.contentWindow.postMessage({ cwCustomer: window.__cwCustomer }, '*');
      });
    }
  }

  function openModal() {
    if (!overlay) buildModal();
    overlay.style.display = 'flex';
    requestAnimationFrame(function() {
      requestAnimationFrame(function() { overlay.style.opacity = '1'; });
    });
    document.body.style.overflow = 'hidden';
    document.addEventListener('keydown', escHandler);
  }

  function closeModal() {
    overlay.style.opacity = '0';
    document.body.style.overflow = '';
    document.removeEventListener('keydown', escHandler);
    setTimeout(function() { overlay.style.display = 'none'; }, 250);
  }

  function escHandler(e) { if (e.key === 'Escape') closeModal(); }
})();
