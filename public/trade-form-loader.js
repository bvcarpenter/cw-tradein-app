(function() {
  var root = document.getElementById('cw-trade-in-root') || document.currentScript.parentElement;
  var base = document.currentScript.src.replace(/trade-form-loader\.js.*$/, '');

  fetch(base + 'trade-form-embed.html')
    .then(function(r) { return r.text(); })
    .then(function(html) {
      var doc = new DOMParser().parseFromString(html, 'text/html');
      var body = doc.body;

      // Move <style> elements into document <head>
      body.querySelectorAll('style').forEach(function(s) {
        var ns = document.createElement('style');
        ns.textContent = s.textContent;
        document.head.appendChild(ns);
        s.remove();
      });

      // Collect <script> blocks, then remove them from parsed body
      var scripts = [];
      body.querySelectorAll('script').forEach(function(s) {
        scripts.push(s.textContent);
        s.remove();
      });

      // Insert HTML content
      root.innerHTML = body.innerHTML;

      // Execute scripts in order
      scripts.forEach(function(code) {
        var el = document.createElement('script');
        el.textContent = code;
        document.body.appendChild(el);
      });
    })
    .catch(function() {
      root.innerHTML = '<p style="color:red;text-align:center;padding:40px;">Unable to load trade-in form. Please refresh or contact us.</p>';
    });
})();
