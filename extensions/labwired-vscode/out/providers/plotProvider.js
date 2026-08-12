"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.PlotViewProvider = void 0;
const vscode = __importStar(require("vscode"));
const theme_1 = require("../webview/theme");
/**
 * Plot surface — live serial numbers + composed.json from `labwired compose job`.
 * Observation glass only — never mints model_verified / hardware_observed.
 */
class PlotViewProvider {
    extUri;
    static viewType = "labwired.plot";
    view;
    samples = [];
    composed = null;
    maxSamples = 500;
    constructor(extUri) {
        this.extUri = extUri;
    }
    resolveWebviewView(webviewView, _c, _t) {
        this.view = webviewView;
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this.extUri],
        };
        webviewView.webview.html = this.html();
        webviewView.webview.onDidReceiveMessage((msg) => {
            if (msg?.type === "ready") {
                this.repaint();
            }
            if (msg?.type === "clear") {
                this.samples = [];
                this.composed = null;
                this.repaint();
            }
        });
    }
    /** Feed text from serial monitor — extract numbers. */
    ingestSerialText(text) {
        const parts = text.split(/[\s,;]+/);
        let added = false;
        for (const p of parts) {
            const n = Number(p);
            if (!Number.isNaN(n) && Number.isFinite(n) && /^-?\d/.test(p.trim())) {
                this.samples.push(n);
                added = true;
            }
        }
        const re = /[=:]\s*(-?\d+(?:\.\d+)?)/g;
        let m;
        while ((m = re.exec(text))) {
            const n = Number(m[1]);
            if (!Number.isNaN(n)) {
                this.samples.push(n);
                added = true;
            }
        }
        if (this.samples.length > this.maxSamples) {
            this.samples = this.samples.slice(-this.maxSamples);
        }
        if (added) {
            this.composed = null; // live stream takes over
            this.repaint();
        }
    }
    pushSample(n) {
        this.samples.push(n);
        if (this.samples.length > this.maxSamples) {
            this.samples = this.samples.slice(-this.maxSamples);
        }
        this.composed = null;
        this.repaint();
    }
    /** Load output of `labwired compose job` / compose uart. */
    loadComposed(doc) {
        this.composed = doc;
        this.samples = [];
        this.repaint();
        const n = (doc.series?.length || 0) + (doc.markers?.length ? 1 : 0);
        void vscode.window.showInformationMessage(`LabWired Plot: loaded ${n} series/marker track(s)` +
            (doc.recipe_id ? ` · ${doc.recipe_id}` : "") +
            " (observation only)");
    }
    async loadComposedFile(uri) {
        const raw = await vscode.workspace.fs.readFile(uri);
        const text = Buffer.from(raw).toString("utf8");
        let doc;
        try {
            doc = JSON.parse(text);
        }
        catch {
            void vscode.window.showErrorMessage("Not valid composed JSON");
            return;
        }
        if (!doc.series?.length && !doc.markers?.length) {
            void vscode.window.showWarningMessage("Composed JSON has no series/markers (empty — nothing to invent)");
        }
        this.loadComposed(doc);
        await vscode.commands.executeCommand("labwired.plot.focus");
    }
    repaint() {
        if (this.composed) {
            void this.view?.webview.postMessage({
                type: "composed",
                doc: this.composed,
            });
            return;
        }
        void this.view?.webview.postMessage({
            type: "samples",
            values: this.samples.slice(),
        });
    }
    html() {
        const nonce = getNonce();
        return (0, theme_1.shellHtml)({
            nonce,
            title: "Plot",
            body: `
<div class="app">
  <div class="header">
    <h1>Plot</h1>
    <span class="badge neutral" id="badge">series</span>
    <span class="grow"></span>
    <button class="ghost" id="clear" type="button">Clear</button>
    <button class="ghost" id="demo" type="button">Demo</button>
    <button id="draw" type="button">Plot paste</button>
  </div>
  <div class="toolbar col" style="gap:8px">
    <div class="muted xs" id="hint">Live serial · or <b>Open Composed Plot JSON</b> from compose job</div>
    <textarea id="data" rows="2" placeholder="1.2&#10;temp=23.4"></textarea>
  </div>
  <div class="scroll" style="padding:10px">
    <canvas id="c" width="640" height="240" style="width:100%;background:var(--bg-element);border:1px solid var(--border);border-radius:6px"></canvas>
    <div class="muted xs" id="legend" style="margin-top:6px"></div>
  </div>
</div>`,
            script: `
const canvas = document.getElementById('c');
const ctx = canvas.getContext('2d');
const dataEl = document.getElementById('data');
const badge = document.getElementById('badge');
const legend = document.getElementById('legend');
const hint = document.getElementById('hint');
const COLORS = ['#0056b3','#c45c26','#2a9d8f','#6d28d9','#b45309'];
let live = [];
let composed = null;

function parse(text) {
  const out = [];
  text.split(/[\\n,;]+/).forEach(line => {
    const t = line.trim();
    if (!t) return;
    const m = t.match(/(?:^|[=:\\\\s])(-?\\\\d+(?:\\\\.\\\\d+)?)$/);
    if (m) out.push(Number(m[1]));
    else {
      const n = Number(t);
      if (!Number.isNaN(n)) out.push(n);
    }
  });
  return out;
}

function seriesValues(s) {
  if (Array.isArray(s.values) && s.values.length) return s.values.map(Number);
  const pts = s.points || [];
  return pts.map(p => {
    if (typeof p.level === 'number') return p.level;
    if (typeof p.y === 'number') return p.y;
    if (typeof p.value === 'number') return p.value;
    return 0;
  });
}

function drawFlat(vals, color, label) {
  const w = canvas.width, h = canvas.height;
  if (!vals.length) return;
  const min = Math.min(...vals), max = Math.max(...vals);
  const span = max - min || 1;
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.75;
  ctx.beginPath();
  vals.forEach((v,i) => {
    const x = (i / Math.max(vals.length-1,1)) * (w-24) + 12;
    const y = h - 12 - ((v - min) / span) * (h-24);
    if (i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
  });
  ctx.stroke();
}

function draw() {
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0,0,w,h);
  ctx.strokeStyle = 'rgba(128,128,128,0.15)';
  ctx.lineWidth = 1;
  for (let g = 0; g < 4; g++) {
    const gy = 12 + g * ((h-24)/3);
    ctx.beginPath(); ctx.moveTo(12, gy); ctx.lineTo(w-12, gy); ctx.stroke();
  }
  legend.textContent = '';
  if (composed && (composed.series || composed.markers)) {
    const series = composed.series || [];
    const legs = [];
    series.forEach((s, i) => {
      const vals = seriesValues(s);
      const color = COLORS[i % COLORS.length];
      drawFlat(vals, color, s.id || ('s'+i));
      legs.push((s.id || ('s'+i)) + ' n=' + vals.length);
    });
    // markers as ticks on top
    const marks = composed.markers || [];
    if (marks.length) {
      ctx.fillStyle = '#c45c26';
      const maxT = Math.max(...marks.map(m => Number(m.t)||0), 1);
      marks.forEach(m => {
        const t = Number(m.t) || 0;
        const x = (t / maxT) * (w-24) + 12;
        ctx.fillRect(x-1, 8, 2, h-16);
      });
      legs.push('markers=' + marks.length);
    }
    badge.textContent = (composed.recipe_id || 'composed') + ' · ' + series.length + 's';
    hint.textContent = (composed.ask || composed.title || 'composed view') +
      ' · observation only (not twin/desk green)';
    legend.textContent = legs.join(' · ');
    return;
  }
  badge.textContent = 'n=' + live.length;
  hint.textContent = 'Live serial · or Open Composed Plot JSON from compose job';
  if (!live.length) return;
  drawFlat(live, '#0056b3', 'live');
  const min = Math.min(...live), max = Math.max(...live);
  legend.textContent = 'min=' + min.toFixed(3) + ' max=' + max.toFixed(3);
}

document.getElementById('draw').onclick = () => {
  composed = null;
  live = parse(dataEl.value);
  draw();
};
document.getElementById('demo').onclick = () => {
  composed = null;
  live = Array.from({length:80}, (_,i) => Math.sin(i/6) + 0.1*Math.random());
  dataEl.value = live.map(v => v.toFixed(4)).join('\\\\n');
  draw();
};
document.getElementById('clear').onclick = () => {
  live = [];
  composed = null;
  dataEl.value = '';
  draw();
  vscode.postMessage({ type: 'clear' });
};
window.addEventListener('message', (e) => {
  const m = e.data;
  if (m.type === 'samples' && Array.isArray(m.values)) {
    composed = null;
    live = m.values;
    draw();
  }
  if (m.type === 'composed' && m.doc) {
    composed = m.doc;
    live = [];
    draw();
  }
});
vscode.postMessage({ type: 'ready' });
`,
        });
    }
}
exports.PlotViewProvider = PlotViewProvider;
function getNonce() {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let s = "";
    for (let i = 0; i < 32; i++)
        s += chars.charAt(Math.floor(Math.random() * chars.length));
    return s;
}
//# sourceMappingURL=plotProvider.js.map