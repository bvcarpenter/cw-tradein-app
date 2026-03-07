(function() {
  var base = document.currentScript.src.replace(/trade-form-modal\.js.*$/, '');
  var tradePageUrl = '/pages/trade-in'; // fallback link for mobile

  /* ── Trigger button (inserted by Custom Liquid) ── */
  var btn = document.getElementById('cw-trade-trigger');
  if (!btn) return;

  /* ── Mobile: just navigate ── */
  function isMobile() { return window.innerWidth < 768; }

  btn.addEventListener('click', function(e) {
    e.preventDefault();
    if (isMobile()) { window.location.href = tradePageUrl; return; }
    openModal();
  });

  /* ── Modal overlay ── */
  var overlay, modal, iframe;

  function buildModal() {
    overlay = document.createElement('div');
    overlay.id = 'cw-modal-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;opacity:0;transition:opacity .2s ease;';

    modal = document.createElement('div');
    modal.style.cssText = 'position:relative;width:94vw;max-width:960px;height:90vh;background:#fff;box-shadow:0 12px 40px rgba(0,0,0,.25);overflow:hidden;border-radius:2px;';

    /* close button */
    var close = document.createElement('button');
    close.innerHTML = '&times;';
    close.setAttribute('aria-label', 'Close');
    close.style.cssText = 'position:absolute;top:10px;right:14px;z-index:2;background:none;border:none;font-size:28px;line-height:1;cursor:pointer;color:#444;font-family:sans-serif;';
    close.addEventListener('click', closeModal);

    iframe = document.createElement('iframe');
    iframe.src = base + 'trade-form-embed';
    iframe.style.cssText = 'display:block;width:100%;height:100%;border:none;';
    iframe.setAttribute('title', 'Camera West Trade-In / Sell');

    modal.appendChild(close);
    modal.appendChild(iframe);
    overlay.appendChild(modal);
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

    /* auto-resize isn't needed in modal (fixed height), but listen anyway */
    window.addEventListener('message', function(e) {
      if (e.data && e.data.cwTradeInHeight) {
        /* no-op inside modal */
      }
    });
  }

  function openModal() {
    if (!overlay) buildModal();
    overlay.style.display = 'flex';
    requestAnimationFrame(function() { overlay.style.opacity = '1'; });
    document.body.style.overflow = 'hidden';
    document.addEventListener('keydown', escHandler);
  }

  function closeModal() {
    overlay.style.opacity = '0';
    document.body.style.overflow = '';
    document.removeEventListener('keydown', escHandler);
    setTimeout(function() { overlay.style.display = 'none'; }, 200);
  }

  function escHandler(e) { if (e.key === 'Escape') closeModal(); }
})();
