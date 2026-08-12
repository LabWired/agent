import * as vscode from "vscode";
import { shellHtml } from "../webview/theme";

/** Series point from compose-job / compose-elements output. */
export type ComposedSeries = {
  id?: string;
  kind?: string;
  provenance?: string;
  points?: Array<{ t?: number; level?: number; y?: number; value?: number }>;
  values?: number[];
};

export type ComposedDoc = {
  title?: string;
  ask?: string;
  recipe_id?: string;
  note?: string;
  series?: ComposedSeries[];
  markers?: Array<{ t?: number; label?: string }>;
  ok?: boolean;
};

/**
 * Plot surface — live serial numbers + composed.json from `labwired compose job`.
 * Observation glass only — never mints model_verified / hardware_observed.
 */
export class PlotViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "labwired.plot";
  private view?: vscode.WebviewView;
  private samples: number[] = [];
  private composed: ComposedDoc | null = null;
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
    if (added) {
      this.composed = null; // live stream takes over
      this.repaint();
    }
  }

  pushSample(n: number): void {
    this.samples.push(n);
    if (this.samples.length > this.maxSamples) {
      this.samples = this.samples.slice(-this.maxSamples);
    }
    this.composed = null;
    this.repaint();
  }

  /** Accept a server-fed series map (plot/update) and re-render. */
  updateSeries(series: Record<string, number[]>): void {
    this.composed = {
      title: "live",
      series: Object.entries(series).map(([id, values]) => ({ id, values })),
    };
    this.samples = [];
    this.repaint();
  }

  /** Load output of `labwired compose job` / compose uart. */
  loadComposed(doc: ComposedDoc): void {
    this.composed = doc;
    this.samples = [];
    this.repaint();
    const n =
      (doc.series?.length || 0) + (doc.markers?.length ? 1 : 0);
    void vscode.window.showInformationMessage(
      `LabWired Plot: loaded ${n} series/marker track(s)` +
        (doc.recipe_id ? ` · ${doc.recipe_id}` : "") +
        " (observation only)"
    );
  }

  async loadComposedFile(uri: vscode.Uri): Promise<void> {
    const raw = await vscode.workspace.fs.readFile(uri);
    const text = Buffer.from(raw).toString("utf8");
    let doc: ComposedDoc;
    try {
      doc = JSON.parse(text) as ComposedDoc;
    } catch {
      void vscode.window.showErrorMessage("Not valid composed JSON");
      return;
    }
    if (!doc.series?.length && !doc.markers?.length) {
      void vscode.window.showWarningMessage(
        "Composed JSON has no series/markers (empty — nothing to invent)"
      );
    }
    this.loadComposed(doc);
    await vscode.commands.executeCommand("labwired.plot.focus");
  }

  private repaint() {
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

function getNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let s = "";
  for (let i = 0; i < 32; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
  return s;
}
