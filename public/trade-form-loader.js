(function() {
  var root = document.getElementById('cw-trade-in-root') || document.currentScript.parentElement;
  var base = document.currentScript.src.replace(/trade-form-loader\.js.*$/, '');

  var iframe = document.createElement('iframe');
  iframe.src = base + 'trade-form-embed';
  iframe.style.cssText = 'width:100%;border:none;overflow:hidden;min-height:800px;';
  iframe.setAttribute('scrolling', 'no');
  iframe.setAttribute('title', 'Camera West Trade-In / Sell');
  root.appendChild(iframe);

  // Auto-resize: the embed posts its scrollHeight via postMessage
  window.addEventListener('message', function(e) {
    if (e.data && e.data.cwTradeInHeight) {
      iframe.style.height = e.data.cwTradeInHeight + 'px';
    }
  });
})();
