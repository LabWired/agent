/**
 * LabWired Firmware Agent — product demo loop (draft → fail → fix → green).
 * Pure front-end; no network. ~30s full cycle.
 */
(function () {
  var host = document.getElementById('ag-term-lines');
  var steps = document.querySelectorAll('#ag-step-list [data-step]');
  if (!host) return;

  var script = [
    { step: 0, html: '<span class="prompt">you ›</span> Blink LED and print ready on UART' },
    { step: 0, html: '<span class="dim">agent ›</span> Drafting <span class="hl">main.c</span> for nucleo-l476rg…' },
    { step: 0, html: '<span class="dim">agent ›</span> Wrote firmware · compiling…' },
    { step: 1, html: '<span class="dim">check ›</span> Running on virtual board…' },
    { step: 1, html: '<span class="bad">failed</span> · expected serial <span class="hl">LABWIRED_OK</span>, saw <span class="hl">BOOT</span>' },
    { step: 2, html: '<span class="dim">agent ›</span> Patching UART marker…' },
    { step: 2, html: '<span class="dim">agent ›</span> Recompiling…' },
    { step: 3, html: '<span class="dim">check ›</span> Running on virtual board…' },
    { step: 3, html: '<span class="ok">green</span> · serial matches · ready to flash when you are' },
    { step: 3, html: '<span class="dim">— loop restarts —</span>' },
  ];

  var lineDelay = 2200;
  var restartPause = 2800;
  var i = 0;

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
    // force reflow for transition
    void div.offsetWidth;
    div.classList.add('show');
    // keep last ~10 lines visible
    while (host.children.length > 10) {
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
    i += 1;
    if (i >= script.length) {
      i = 0;
      setTimeout(tick, restartPause);
    } else {
      setTimeout(tick, lineDelay);
    }
  }

  // Prefer reduced motion: show final state only
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduce) {
    clearTerm();
    setStep(3);
    script.filter(function (s) { return s.step === 3 && s.html.indexOf('green') !== -1; })
      .forEach(function (s) { addLine(s.html); });
    return;
  }

  tick();
})();
