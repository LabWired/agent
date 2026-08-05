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
exports.HistoryViewProvider = void 0;
const vscode = __importStar(require("vscode"));
const theme_1 = require("../webview/theme");
class HistoryViewProvider {
    extUri;
    store;
    static viewType = "labwired.history";
    view;
    constructor(extUri, store) {
        this.extUri = extUri;
        this.store = store;
        store.onChange(() => this.refresh());
    }
    resolveWebviewView(webviewView, _c, _t) {
        this.view = webviewView;
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this.extUri],
        };
        webviewView.webview.html = this.html();
        webviewView.webview.onDidReceiveMessage((msg) => {
            if (msg.type === "open") {
                this.store.setActive(String(msg.id));
                void vscode.commands.executeCommand("labwired.openChat");
            }
            if (msg.type === "refresh" || msg.type === "ready")
                this.refresh();
            if (msg.type === "new") {
                this.store.newTab();
                void vscode.commands.executeCommand("labwired.openChat");
            }
        });
    }
    refresh() {
        const list = this.store.historyList();
        void this.view?.webview.postMessage({ type: "list", items: list });
    }
    html() {
        const nonce = getNonce();
        return (0, theme_1.shellHtml)({
            nonce,
            title: "History",
            body: `
<div class="app">
  <div class="header">
    <h1>History</h1>
    <span class="grow"></span>
    <button class="ghost" id="new" type="button">New</button>
    <button class="ghost" id="refresh" type="button">Refresh</button>
  </div>
  <div class="scroll" id="list"></div>
</div>`,
            script: `
const list = document.getElementById('list');
document.getElementById('refresh').onclick = () => vscode.postMessage({ type: 'refresh' });
document.getElementById('new').onclick = () => vscode.postMessage({ type: 'new' });
window.addEventListener('message', (e) => {
  const m = e.data;
  if (m.type !== 'list') return;
  list.innerHTML = '';
  (m.items || []).forEach(it => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ghost';
    b.style.cssText = 'display:flex;flex-direction:column;align-items:flex-start;width:100%;text-align:left;margin:0;padding:10px 12px;border:none;border-bottom:1px solid var(--border);border-radius:0;box-shadow:none';
    b.innerHTML = '<div style="font-weight:500"></div><div class="muted xs"></div>';
    b.querySelector('div').textContent = it.title;
    b.querySelector('.muted').textContent = new Date(it.updatedAt).toLocaleString() + ' · ' + it.count + ' msgs';
    b.onclick = () => vscode.postMessage({ type: 'open', id: it.id });
    list.appendChild(b);
  });
  if (!(m.items || []).length) {
    list.innerHTML = '<div class="empty"><p>No conversations yet</p></div>';
  }
});
vscode.postMessage({ type: 'ready' });
`,
        });
    }
}
exports.HistoryViewProvider = HistoryViewProvider;
function getNonce() {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let s = "";
    for (let i = 0; i < 32; i++)
        s += chars.charAt(Math.floor(Math.random() * chars.length));
    return s;
}
//# sourceMappingURL=historyProvider.js.map