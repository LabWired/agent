import * as vscode from "vscode";
import type { ConversationStore } from "../services/conversationStore";
import { shellHtml } from "../webview/theme";

export class HistoryViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "labwired.history";
  private view?: vscode.WebviewView;

  constructor(
    private readonly extUri: vscode.Uri,
    private readonly store: ConversationStore
  ) {
    store.onChange(() => this.refresh());
  }

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
      if (msg.type === "open") {
        this.store.setActive(String(msg.id));
        void vscode.commands.executeCommand("labwired.openChat");
      }
      if (msg.type === "refresh" || msg.type === "ready") this.refresh();
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

  private html(): string {
    const nonce = getNonce();
    return shellHtml({
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

function getNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let s = "";
  for (let i = 0; i < 32; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
  return s;
}
