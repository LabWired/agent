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
exports.CatalogViewProvider = void 0;
const vscode = __importStar(require("vscode"));
const theme_1 = require("../webview/theme");
/** Embedder-style platform/peripheral catalog (local LabWired facts + PDFs). */
class CatalogViewProvider {
    extUri;
    catalog;
    static viewType = "labwired.catalog";
    view;
    constructor(extUri, catalog) {
        this.extUri = extUri;
        this.catalog = catalog;
    }
    resolveWebviewView(webviewView, _c, _t) {
        this.view = webviewView;
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this.extUri],
        };
        webviewView.webview.html = this.html();
        webviewView.webview.onDidReceiveMessage((m) => void this.onMessage(m));
    }
    async onMessage(msg) {
        if (msg.type === "ready" || msg.type === "stats") {
            const s = this.catalog.stats();
            const sheets = this.catalog.listProjectDatasheets();
            this.post({
                type: "stats",
                ...s,
                datasheets: sheets.map((p) => p.split(/[/\\]/).pop()),
            });
        }
        if (msg.type === "search") {
            const hits = this.catalog.search(String(msg.q || ""), 40);
            this.post({ type: "hits", hits, q: msg.q });
        }
        if (msg.type === "openDatasheets") {
            const dir = this.catalog.ensureDatasheetDir();
            if (dir) {
                await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(dir));
            }
            else {
                void vscode.window.showWarningMessage("Open a workspace folder first.");
            }
        }
        if (msg.type === "detail" && msg.id) {
            const part = this.catalog.getPart(msg.id);
            this.post({
                type: "detail",
                text: part
                    ? JSON.stringify(part, null, 2)
                    : this.catalog.buildContext(msg.id, 5),
            });
        }
    }
    post(p) {
        void this.view?.webview.postMessage(p);
    }
    html() {
        const nonce = getNonce();
        return (0, theme_1.shellHtml)({
            nonce,
            title: "Catalog",
            body: `
<div class="app">
  <div class="header">
    <h1>Catalog</h1>
    <span class="badge brand" id="stats">…</span>
    <span class="grow"></span>
    <button class="ghost" id="pdfs" type="button">Datasheets folder</button>
  </div>
  <div class="toolbar">
    <input id="q" type="text" class="grow" placeholder="Search chips, parts, peripherals (bme280, esp32, ssd1306)…" />
    <button class="primary" id="go" type="button">Search</button>
  </div>
  <div class="status-strip muted xs" id="hint">Local LabWired catalog · drop PDFs in .labwired/datasheets</div>
  <div class="scroll" id="list"></div>
  <div class="scroll mono" id="detail" style="max-height:40%;border-top:1px solid var(--border);padding:8px;display:none"></div>
</div>`,
            script: `
const list = document.getElementById('list');
const detail = document.getElementById('detail');
const stats = document.getElementById('stats');
const q = document.getElementById('q');
document.getElementById('go').onclick = () => vscode.postMessage({ type: 'search', q: q.value });
q.addEventListener('keydown', e => { if (e.key === 'Enter') vscode.postMessage({ type: 'search', q: q.value }); });
document.getElementById('pdfs').onclick = () => vscode.postMessage({ type: 'openDatasheets' });

window.addEventListener('message', e => {
  const m = e.data;
  if (m.type === 'stats') {
    stats.textContent = m.parts + ' parts · ' + m.peripherals + ' peripherals · ' + m.chips + ' chips';
    if (m.datasheets && m.datasheets.length) {
      document.getElementById('hint').textContent = 'Datasheets: ' + m.datasheets.join(', ');
    }
  }
  if (m.type === 'hits') {
    list.innerHTML = '';
    (m.hits || []).forEach(h => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'ghost';
      b.style.cssText = 'display:block;width:100%;text-align:left;border:none;border-bottom:1px solid var(--border);border-radius:0;padding:8px 10px';
      b.innerHTML = '<div style="font-weight:500"></div><div class="muted xs"></div>';
      b.querySelector('div').textContent = '[' + h.kind + '] ' + h.label;
      b.querySelector('.muted').textContent = h.id + ' · ' + h.detail;
      b.onclick = () => vscode.postMessage({ type: 'detail', id: h.id });
      list.appendChild(b);
    });
    if (!(m.hits || []).length) {
      list.innerHTML = '<div class="muted small" style="padding:12px">No hits for \"' + (m.q||'') + '\"</div>';
    }
  }
  if (m.type === 'detail') {
    detail.style.display = 'block';
    detail.textContent = m.text || '';
  }
});
vscode.postMessage({ type: 'ready' });
vscode.postMessage({ type: 'search', q: 'esp32' });
`,
        });
    }
}
exports.CatalogViewProvider = CatalogViewProvider;
function getNonce() {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let s = "";
    for (let i = 0; i < 32; i++)
        s += chars.charAt(Math.floor(Math.random() * chars.length));
    return s;
}
//# sourceMappingURL=catalogProvider.js.map