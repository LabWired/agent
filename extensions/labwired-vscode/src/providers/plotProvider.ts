import * as vscode from "vscode";
import { shellHtml } from "../webview/theme";

/**
 * Plot surface — live samples from serial (numeric lines) + paste/demo.
 * Future: plot/* RPC from labwired server.
 */
export class PlotViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "labwired.plot";
  private view?: vscode.WebviewView;
  private samples: number[] = [];
  private maxSamples = 500;

  constructor(private readonly extUri: vscode.Uri) {}

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _c: vscode.WebviewViewResolveContext,
    _t: vscode.CancellationToken
  ): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extUri],
    };
    webviewView.webview.html = this.html();
    webviewView.webview.onDidReceiveMessage((msg) => {
      if (msg?.type === "ready") {
        this.pushSamples();
      }
      if (msg?.type === "clear") {
        this.samples = [];
        this.pushSamples();
      }
    });
  }

  /** Feed text from serial monitor — extract numbers. */
  ingestSerialText(text: string): void {
    const parts = text.split(/[\s,;]+/);
    let added = false;
    for (const p of parts) {
      const n = Number(p);
      if (!Number.isNaN(n) && Number.isFinite(n) && /^-?\d/.test(p.trim())) {
        this.samples.push(n);
        added = true;
      }
    }
    // Also match patterns like "temp=23.5"
    const re = /[=:]\s*(-?\d+(?:\.\d+)?)/g;
    let m: RegExpExecArray | null;
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
    if (added) this.pushSamples();
  }

  pushSample(n: number): void {
    this.samples.push(n);
    if (this.samples.length > this.maxSamples) {
      this.samples = this.samples.slice(-this.maxSamples);
    }
    this.pushSamples();
  }

  private pushSamples() {
    void this.view?.webview.postMessage({
      type: "samples",
      values: this.samples.slice(),
    });
  }

  private html(): string {
    const nonce = getNonce();
    return shellHtml({
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
    <div class="muted xs">Live: numeric serial lines → series. Or paste numbers below.</div>
    <textarea id="data" rows="3" placeholder="1.2&#10;1.5&#10;temp=23.4"></textarea>
  </div>
  <div class="scroll" style="padding:10px">
    <canvas id="c" width="640" height="220" style="width:100%;background:var(--bg-element);border:1px solid var(--border);border-radius:6px"></canvas>
  </div>
</div>`,
      script: `
const canvas = document.getElementById('c');
const ctx = canvas.getContext('2d');
const dataEl = document.getElementById('data');
const badge = document.getElementById('badge');
let live = [];

function parse(text) {
  const out = [];
  text.split(/[\\n,;]+/).forEach(line => {
    const t = line.trim();
    if (!t) return;
    const m = t.match(/(?:^|[=:\\s])(-?\\d+(?:\\.\\d+)?)$/);
    if (m) out.push(Number(m[1]));
    else {
      const n = Number(t);
      if (!Number.isNaN(n)) out.push(n);
    }
  });
  return out;
}
function draw(vals) {
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0,0,w,h);
  badge.textContent = 'n=' + vals.length;
  if (!vals.length) return;
  const min = Math.min(...vals), max = Math.max(...vals);
  const span = max - min || 1;
  ctx.strokeStyle = 'rgba(128,128,128,0.15)';
  ctx.lineWidth = 1;
  for (let g = 0; g < 4; g++) {
    const gy = 12 + g * ((h-24)/3);
    ctx.beginPath(); ctx.moveTo(12, gy); ctx.lineTo(w-12, gy); ctx.stroke();
  }
  ctx.strokeStyle = '#0056b3';
  ctx.lineWidth = 1.75;
  ctx.beginPath();
  vals.forEach((v,i) => {
    const x = (i / Math.max(vals.length-1,1)) * (w-24) + 12;
    const y = h - 12 - ((v - min) / span) * (h-24);
    if (i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
  });
  ctx.stroke();
  ctx.fillStyle = 'rgba(128,128,128,0.75)';
  ctx.font = '11px var(--vscode-font-family, system-ui)';
  ctx.fillText('n=' + vals.length + '  min=' + min.toFixed(3) + '  max=' + max.toFixed(3), 14, 18);
}
document.getElementById('draw').onclick = () => {
  live = parse(dataEl.value);
  draw(live);
};
document.getElementById('demo').onclick = () => {
  live = Array.from({length:80}, (_,i) => Math.sin(i/6) + 0.1*Math.random());
  dataEl.value = live.map(v => v.toFixed(4)).join('\\n');
  draw(live);
};
document.getElementById('clear').onclick = () => {
  live = [];
  dataEl.value = '';
  draw([]);
  vscode.postMessage({ type: 'clear' });
};
window.addEventListener('message', (e) => {
  const m = e.data;
  if (m.type === 'samples' && Array.isArray(m.values)) {
    live = m.values;
    draw(live);
  }
});
vscode.postMessage({ type: 'ready' });
`,
    });
  }
}

function getNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let s = "";
  for (let i = 0; i < 32; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
  return s;
}
