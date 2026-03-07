(function() {
  var root = document.getElementById('cw-trade-in-root') || document.currentScript.parentElement;
  var base = document.currentScript.src.replace(/trade-form-loader\.js.*$/, '');

  // Ensure root container is full-width and centered
  root.style.cssText = 'width:100%;max-width:100%;margin:0 auto;padding:0;box-sizing:border-box;';

  var iframe = document.createElement('iframe');
  iframe.src = base + 'trade-form-embed';
  iframe.style.cssText = 'display:block;width:100%;border:none;overflow:hidden;min-height:800px;margin:0 auto;';
  iframe.setAttribute('scrolling', 'no');
  iframe.setAttribute('title', 'Camera West Trade-In / Sell');
  root.appendChild(iframe);

  // Once iframe is ready, pass Shopify customer data if available
  if (window.__cwCustomer) {
    iframe.addEventListener('load', function() {
      iframe.contentWindow.postMessage({ cwCustomer: window.__cwCustomer }, '*');
    });
  }

  // Auto-resize: the embed posts its scrollHeight via postMessage
  window.addEventListener('message', function(e) {
    if (e.data && e.data.cwTradeInHeight) {
      iframe.style.height = e.data.cwTradeInHeight + 'px';
    }
  });
})();
