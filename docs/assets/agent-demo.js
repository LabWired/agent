/**
 * LabWired Firmware Agent — product demo loop.
 * Write → Check → Fix → Green. ~28s cycle, holds the green beat longer.
 */
(function () {
  var host = document.getElementById('ag-term-lines');
  var steps = document.querySelectorAll('#ag-step-list [data-step]');
  if (!host) return;

  // delayMs: time to wait *after* showing this line (before the next)
  var script = [
    { step: 0, delayMs: 1600, html: '<span class="prompt">you ›</span> Make the board print ready on serial' },
    { step: 0, delayMs: 1400, html: '<span class="dim">agent ›</span> Writing <span class="hl">main.c</span>…' },
    { step: 0, delayMs: 1200, html: '<span class="dim">agent ›</span> Compiling…' },
    { step: 1, delayMs: 1600, html: '<span class="dim">check ›</span> Running on virtual board…' },
    { step: 1, delayMs: 2600, html: '<span class="bad">failed</span> · wanted <span class="hl">READY</span>, got <span class="hl">BOOT</span>' },
    { step: 2, delayMs: 1500, html: '<span class="dim">agent ›</span> Fixing the serial message…' },
    { step: 2, delayMs: 1200, html: '<span class="dim">agent ›</span> Compiling again…' },
    { step: 3, delayMs: 1500, html: '<span class="dim">check ›</span> Running on virtual board…' },
    { step: 3, delayMs: 3200, html: '<span class="ok">green</span> · it matches · ready when you are' },
  ];

  var restartPause = 1800;
  var i = 0;
  var timer = null;

  function setStep(n) {
    steps.forEach(function (el) {
      el.classList.toggle('active', String(el.getAttribute('data-step')) === String(n));
    });
  }

  function addLine(html) {
    var div = document.createElement('div');
    div.className = 'line';
    div.innerHTML = html;
    host.appendChild(div);
    void div.offsetWidth;
    div.classList.add('show');
    while (host.children.length > 9) {
      host.removeChild(host.firstChild);
    }
  }

  function clearTerm() {
    host.innerHTML = '';
  }

  function tick() {
    if (i === 0) clearTerm();
    var item = script[i];
    setStep(item.step);
    addLine(item.html);
    var wait = item.delayMs || 1500;
    i += 1;
    if (i >= script.length) {
      i = 0;
      timer = setTimeout(tick, restartPause);
    } else {
      timer = setTimeout(tick, wait);
    }
  }

  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduce) {
    clearTerm();
    setStep(3);
    addLine('<span class="prompt">you ›</span> Make the board print ready on serial');
    addLine('<span class="ok">green</span> · it matches · ready when you are');
    return;
  }

  tick();
})();
