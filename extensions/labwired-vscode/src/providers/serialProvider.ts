import * as vscode from "vscode";
import type { LabWiredBridge } from "../cli/bridge";
import type { RpcClient } from "../cli/rpcClient";
import type { PlotViewProvider } from "./plotProvider";
import type { OverviewViewProvider } from "./overviewProvider";
import { LiveSerial } from "../serial/live";
import { shellHtml } from "../webview/theme";

type SerialTab = {
  id: string;
  port: string;
  baud: number;
  log: string;
};

/**
 * Embedder Monitor: multi-tab + live UART stream + capture tool.
 */
export class SerialViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "labwired.serial";
  private view?: vscode.WebviewView;
  private editorWebview?: vscode.Webview;
  private tabs: SerialTab[] = [{ id: "t1", port: "", baud: 115200, log: "" }];
  private activeId = "t1";
  private live = new LiveSerial();

  private useRpc = false;

  constructor(
    private readonly extUri: vscode.Uri,
    private readonly bridge: LabWiredBridge,
    private readonly plot?: PlotViewProvider,
    private readonly rpc?: RpcClient,
    private readonly overview?: OverviewViewProvider
  ) {
    this.live.on("data", (s: string) => {
      if (this.useRpc) return; // RPC path owns stream
      this.appendLive(s);
    });
    this.live.on("error", (err: Error) => {
      const line = `\n[serial error] ${err.message}\n`;
      this.active().log += line;
      this.broadcast({ type: "log", text: line, tabId: this.activeId });
    });
    this.live.on("open", () => {
      this.broadcast({ type: "liveState", ...this.live.getState() });
    });
    this.live.on("close", () => {
      this.broadcast({ type: "liveState", open: false });
    });

    rpc?.on("notification", (method: string, params: Record<string, unknown>) => {
      if (method === "serial/data") {
        this.useRpc = true;
        this.appendLive(String(params.data || ""));
      } else if (method === "serial/connectionState") {
        this.broadcast({
          type: "liveState",
          open: !!params.connected,
          port: params.port,
          baud: params.baud,
        });
      } else if (method === "serial/portsChanged") {
        this.broadcast({
          type: "state",
          ports: params.ports || this.bridge.listSerialPorts(),
          baud: this.active().baud,
          tabs: this.tabs,
          activeId: this.activeId,
        });
      } else if (method === "plot/data") {
        const vals = params.values as number[] | undefined;
        if (vals?.length) {
          for (const v of vals) this.plot?.pushSample(v);
        }
      }
    });
  }

  private appendLive(s: string) {
    this.active().log += s;
    if (this.active().log.length > 200_000) {
      this.active().log = this.active().log.slice(-150_000);
    }
    this.broadcast({ type: "live", text: s, tabId: this.activeId });
    this.plot?.ingestSerialText(s);
    this.overview?.ingestSerialText(s);
  }

  dispose() {
    void this.live.close();
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
    webviewView.webview.onDidReceiveMessage((msg) => void this.onMessage(msg));
  }

  openInEditor() {
    const panel = vscode.window.createWebviewPanel(
      "labwired.serial.editor",
      "LabWired Monitor",
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    this.editorWebview = panel.webview;
    panel.webview.html = this.html();
    panel.webview.onDidReceiveMessage((msg) => void this.onMessage(msg));
    panel.onDidDispose(() => {
      if (this.editorWebview === panel.webview) this.editorWebview = undefined;
    });
  }

  private active(): SerialTab {
    return this.tabs.find((t) => t.id === this.activeId) || this.tabs[0];
  }

  private broadcast(p: unknown) {
    void this.view?.webview.postMessage(p);
    void this.editorWebview?.postMessage(p);
  }

  private async onMessage(msg: { type: string; [k: string]: unknown }) {
    const post = (p: unknown) => this.broadcast(p);

    switch (msg.type) {
      case "ready":
      case "refreshPorts": {
        let ports = this.bridge.listSerialPorts();
        let live: Record<string, unknown> = this.live.getState();
        if (this.rpc?.isRunning()) {
          try {
            const st = (await this.rpc.request("serial/getState", {})) as {
              ports?: string[];
              open?: boolean;
              port?: string;
              baud?: number;
            };
            if (st.ports?.length) ports = st.ports;
            live = {
              open: !!st.open,
              port: st.port,
              baud: st.baud,
            };
          } catch {
            /* */
          }
        }
        post({
          type: "state",
          ports,
          baud:
            vscode.workspace
              .getConfiguration("labwired")
              .get<number>("defaultBaud") || 115200,
          tabs: this.tabs,
          activeId: this.activeId,
          live,
          viaRpc: this.rpc?.isRunning() || false,
        });
        break;
      }
      case "selectTab":
        this.activeId = String(msg.id);
        post({
          type: "state",
          tabs: this.tabs,
          activeId: this.activeId,
          ports: this.bridge.listSerialPorts(),
          live: this.live.getState(),
        });
        break;
      case "addTab": {
        const id = `t${Date.now()}`;
        this.tabs.push({ id, port: "", baud: 115200, log: "" });
        this.activeId = id;
        post({
          type: "state",
          tabs: this.tabs,
          activeId: this.activeId,
          ports: this.bridge.listSerialPorts(),
          live: this.live.getState(),
        });
        break;
      }
      case "closeTab": {
        if (this.tabs.length > 1) {
          this.tabs = this.tabs.filter((t) => t.id !== this.activeId);
          this.activeId = this.tabs[0].id;
        }
        post({
          type: "state",
          tabs: this.tabs,
          activeId: this.activeId,
          ports: this.bridge.listSerialPorts(),
          live: this.live.getState(),
        });
        break;
      }
      case "setPort": {
        this.active().port = String(msg.port || "");
        this.active().baud = Number(msg.baud) || 115200;
        break;
      }
      case "connect": {
        const port = String(msg.port || this.active().port);
        const baud = Number(msg.baud) || this.active().baud || 115200;
        this.active().port = port;
        this.active().baud = baud;
        try {
          if (this.rpc?.isRunning()) {
            this.useRpc = true;
            await this.rpc.request("serial/connect", {
              port,
              baud,
              plot: true,
            });
            try {
              await this.rpc.request("plot/start", {
                source: "serial",
                clear: false,
              });
            } catch {
              /* */
            }
            const line = `[rpc] connected ${port} @ ${baud} (plot on)\n`;
            this.active().log += line;
            post({ type: "log", text: line, tabId: this.activeId });
          } else {
            this.useRpc = false;
            await this.live.open(port, baud);
            const line = `[live] connected ${port} @ ${baud}\n`;
            this.active().log += line;
            post({ type: "log", text: line, tabId: this.activeId });
          }
        } catch (e) {
          const line = `[live] open failed: ${String(e)}\n`;
          this.active().log += line;
          post({ type: "log", text: line, tabId: this.activeId });
        }
        break;
      }
      case "disconnect": {
        try {
          if (this.useRpc && this.rpc?.isRunning()) {
            await this.rpc.request("serial/disconnect", {});
          } else {
            await this.live.close();
          }
        } catch {
          await this.live.close();
        }
        this.useRpc = false;
        const line = `[live] disconnected\n`;
        this.active().log += line;
        post({ type: "log", text: line, tabId: this.activeId });
        break;
      }
      case "probeList": {
        await this.bridge.ensureCli();
        const r = await this.bridge.probeList();
        const line = `$ labwired probe list\n${(r.stdout || r.stderr || "").trim()}\n`;
        this.active().log += line;
        post({ type: "log", text: line, tabId: this.activeId });
        break;
      }
      case "send": {
        const text = String(msg.text || "");
        try {
          if (this.useRpc && this.rpc?.isRunning()) {
            await this.rpc.request("serial/send", { text });
          } else {
            if (!this.live.getState().open) {
              const port = this.active().port;
              const baud = this.active().baud;
              if (port) await this.live.open(port, baud);
            }
            this.live.write(text);
          }
          const line = `→ ${text}\n`;
          this.active().log += line;
          post({ type: "log", text: line, tabId: this.activeId });
        } catch (e) {
          post({
            type: "log",
            text: `[send failed] ${String(e)}\n`,
            tabId: this.activeId,
          });
        }
        break;
      }
      case "capture": {
        const port = String(msg.port || this.active().port);
        const baud = Number(msg.baud) || this.active().baud || 115200;
        const marker = String(msg.marker || "LABWIRED_OK");
        const timeout = Number(msg.timeout) || 10;
        this.active().port = port;
        this.active().baud = baud;
        if (!port) {
          post({
            type: "log",
            text: "Select a serial port first.\n",
            tabId: this.activeId,
          });
          return;
        }
        const head = `[capture] ${port} @ ${baud} marker="${marker}" (${timeout}s)…\n`;
        this.active().log += head;
        post({ type: "log", text: head, tabId: this.activeId });
        await this.bridge.ensureCli();
        const r = await this.bridge.serialCapture(port, baud, marker, timeout);
        const body = `exit ${r.code ?? "?"}\n${(r.stdout || r.stderr || "").trim()}\n`;
        this.active().log += body;
        post({ type: "log", text: body, tabId: this.activeId });
        break;
      }
      case "clear":
        this.active().log = "";
        post({
          type: "log",
          text: "",
          tabId: this.activeId,
          replace: true,
        });
        break;
    }
  }

  private html(): string {
    const nonce = getNonce();
    return shellHtml({
      nonce,
      title: "Monitor",
      body: `
<div class="app">
  <div class="header">
    <h1>Monitor</h1>
    <span class="badge neutral" id="liveBadge">offline</span>
    <span class="grow"></span>
    <button class="ghost" id="addTab" type="button">+</button>
    <button class="ghost" id="refresh" type="button">Ports</button>
    <button class="ghost" id="probes" type="button">Probes</button>
  </div>
  <div class="tab-bar" id="tabs"></div>
  <div class="toolbar col" style="gap:6px">
    <div class="field">
      <label>Port</label>
      <select id="port" class="grow"></select>
      <label>Baud</label>
      <input id="baud" type="number" value="115200" style="width:88px" />
      <button class="primary" id="connect" type="button">Connect</button>
      <button class="ghost" id="disconnect" type="button">Stop</button>
    </div>
    <div class="field">
      <label>Marker</label>
      <input id="marker" type="text" class="grow" value="LABWIRED_OK" />
      <label>Sec</label>
      <input id="timeout" type="number" value="10" style="width:56px" />
      <button class="ghost" id="capture" type="button">Capture</button>
      <button class="ghost" id="clear" type="button">Clear</button>
    </div>
    <div class="field">
      <input id="sendText" type="text" class="grow" placeholder="Send line to device…" />
      <button class="ghost" id="send" type="button">Send</button>
    </div>
  </div>
  <div class="scroll mono" id="out" style="padding:10px 12px;color:var(--text-muted)"></div>
</div>`,
      script: `
const out = document.getElementById('out');
const port = document.getElementById('port');
const baud = document.getElementById('baud');
const tabsEl = document.getElementById('tabs');
const liveBadge = document.getElementById('liveBadge');
let logs = {};
let activeId = 't1';

function renderTabs(tabs, active) {
  tabsEl.innerHTML = '';
  (tabs||[]).forEach(t => {
    const b = document.createElement('button');
    b.type='button'; b.className='tab' + (t.id === active ? ' active' : '');
    b.textContent = t.port || t.id;
    b.onclick = () => vscode.postMessage({ type: 'selectTab', id: t.id });
    tabsEl.appendChild(b);
  });
}

document.getElementById('refresh').onclick = () => vscode.postMessage({ type: 'refreshPorts' });
document.getElementById('probes').onclick = () => vscode.postMessage({ type: 'probeList' });
document.getElementById('addTab').onclick = () => vscode.postMessage({ type: 'addTab' });
document.getElementById('clear').onclick = () => vscode.postMessage({ type: 'clear' });
document.getElementById('connect').onclick = () => {
  vscode.postMessage({ type: 'setPort', port: port.value, baud: Number(baud.value) });
  vscode.postMessage({ type: 'connect', port: port.value, baud: Number(baud.value) });
};
document.getElementById('disconnect').onclick = () => vscode.postMessage({ type: 'disconnect' });
document.getElementById('capture').onclick = () => {
  vscode.postMessage({
    type: 'capture', port: port.value, baud: Number(baud.value),
    marker: document.getElementById('marker').value,
    timeout: Number(document.getElementById('timeout').value),
  });
};
document.getElementById('send').onclick = () => {
  const t = document.getElementById('sendText').value;
  vscode.postMessage({ type: 'send', text: t });
};

window.addEventListener('message', (e) => {
  const m = e.data;
  if (m.type === 'state') {
    activeId = m.activeId || activeId;
    renderTabs(m.tabs, activeId);
    port.innerHTML = '';
    (m.ports||[]).forEach(p => {
      const o = document.createElement('option');
      o.value = p; o.textContent = p; port.appendChild(o);
    });
    if (!(m.ports||[]).length) {
      const o = document.createElement('option'); o.value=''; o.textContent='(no ports)'; port.appendChild(o);
    }
    const cur = (m.tabs||[]).find(t => t.id === activeId);
    if (cur && cur.port) port.value = cur.port;
    if (cur && cur.baud) baud.value = cur.baud;
    else if (m.baud) baud.value = m.baud;
    if (cur) { logs[activeId] = cur.log || logs[activeId] || ''; out.textContent = logs[activeId]; }
    if (m.live) {
      liveBadge.textContent = m.live.open ? 'LIVE' : 'offline';
      liveBadge.className = 'badge ' + (m.live.open ? 'ok' : 'neutral');
    }
  }
  if (m.type === 'live') {
    logs[m.tabId || activeId] = (logs[m.tabId || activeId] || '') + (m.text || '');
    if ((m.tabId || activeId) === activeId) {
      out.textContent = logs[activeId];
      out.scrollTop = out.scrollHeight;
    }
  }
  if (m.type === 'liveState') {
    liveBadge.textContent = m.open ? 'LIVE' : 'offline';
    liveBadge.className = 'badge ' + (m.open ? 'ok' : 'neutral');
  }
  if (m.type === 'log') {
    if (m.replace) logs[m.tabId || activeId] = m.text || '';
    else logs[m.tabId || activeId] = (logs[m.tabId || activeId] || '') + (m.text || '');
    if ((m.tabId || activeId) === activeId) {
      out.textContent = logs[activeId] || '';
      out.scrollTop = out.scrollHeight;
    }
  }
});
vscode.postMessage({ type: 'ready' });
`,
    });
  }
}

function getNonce(): string {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let s = "";
  for (let i = 0; i < 32; i++)
    s += chars.charAt(Math.floor(Math.random() * chars.length));
  return s;
}
