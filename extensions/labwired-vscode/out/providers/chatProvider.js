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
exports.ChatViewProvider = void 0;
const vscode = __importStar(require("vscode"));
const registry_1 = require("../tools/registry");
const theme_1 = require("../webview/theme");
const MODE_LABEL = {
    act: "Act",
    plan: "Plan",
    debug: "Debug",
    verify: "Verify",
};
/**
 * Embedder-clone chat + real LabWired tools in-panel.
 */
class ChatViewProvider {
    extUri;
    bridge;
    store;
    session;
    tools;
    agent;
    rpc;
    evidence;
    static viewType = "labwired.chat";
    view;
    constructor(extUri, bridge, store, session, tools, agent, rpc, evidence) {
        this.extUri = extUri;
        this.bridge = bridge;
        this.store = store;
        this.session = session;
        this.tools = tools;
        this.agent = agent;
        this.rpc = rpc;
        this.evidence = evidence;
        store.onChange(() => this.pushState());
        session.onChange(() => this.pushState());
        rpc?.on("notification", (method, params) => {
            void this.onRpcNotification(method, params);
        });
    }
    rpcAssistant = "";
    rpcAsstMsg = null;
    onRpcNotification(method, params) {
        if (method === "chat/textDelta") {
            const delta = String(params.delta || "");
            this.rpcAssistant += delta;
            if (this.rpcAsstMsg) {
                this.rpcAsstMsg.text = this.rpcAssistant;
                this.pushState();
            }
        }
        else if (method === "chat/toolCall") {
            this.store.append("tool", `⚙ ${params.toolName || "tool"}\n${JSON.stringify(params.args || {}).slice(0, 800)}`);
        }
        else if (method === "chat/toolResult") {
            const r = params.result;
            this.store.append("tool", `${r?.success === false ? "✗" : "✓"} ${params.toolName || "tool"}\n${r?.summary || ""}`);
        }
        else if (method === "chat/done") {
            if (this.rpcAsstMsg && !this.rpcAssistant) {
                this.rpcAsstMsg.text = "(done)";
            }
            this.rpcAsstMsg = null;
            this.pushState();
        }
    }
    resolveWebviewView(webviewView, _ctx, _token) {
        this.view = webviewView;
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this.extUri],
        };
        webviewView.webview.html = this.html();
        webviewView.webview.onDidReceiveMessage((msg) => void this.onMessage(msg));
    }
    refresh() {
        this.pushState();
    }
    /** Run a named tool and append Embedder-style tool row to chat. */
    async invokeTool(name, params = {}) {
        this.store.append("system", `⚙ ${name}…`);
        const ev = await this.tools.runNamed(name, params);
        this.appendToolEvent(ev);
    }
    appendToolEvent(ev) {
        const head = `$ labwired ${ev.argv.join(" ")}`;
        const status = ev.status === "ok" ? "✓" : ev.status === "error" ? "✗" : "…";
        this.store.append("tool", `${status} ${ev.title}\n${head}\nexit ${ev.code ?? "?"}\n\n${ev.output}`);
    }
    async onMessage(msg) {
        switch (msg.type) {
            case "ready":
                this.pushState();
                break;
            case "cycleMode":
                this.session.cycleMode();
                break;
            case "setMode":
                this.session.setMode(msg.mode || "act");
                break;
            case "newTab":
                this.store.newTab();
                break;
            case "closeTab":
                this.store.closeActive();
                break;
            case "selectTab":
                this.store.setActive(String(msg.id));
                break;
            case "clear":
                this.store.clearActive();
                break;
            case "compress":
                this.store.compressActive();
                break;
            case "undo":
                this.store.undoLast();
                break;
            case "runTool":
                await this.invokeTool(String(msg.name || ""), msg.params || {});
                break;
            case "listTools":
                this.store.append("tool", this.tools.listCatalog());
                break;
            case "startAgent":
                await this.bridge.startAgentTerminal(this.session.getMode());
                this.store.append("system", `Agent terminal started (${MODE_LABEL[this.session.getMode()]}).`);
                break;
            case "stop":
                this.agent.stop();
                this.bridge.stopGeneration();
                this.store.append("system", "Stopped.");
                break;
            case "openEvidence":
                await vscode.commands.executeCommand("labwired.openEvidence");
                break;
            case "runTwin": {
                this.store.append("system", "⚙ twin/run (smoke)…");
                const r = await this.evidence?.runTwin("smoke");
                if (r) {
                    this.store.append("tool", `${r.ok || r.twin_verified ? "✓" : "✗"} twin/run\n` +
                        `runId=${r.runId} twin_verified=${!!(r.ok || r.twin_verified)} model_verified=false\n` +
                        `${(r.summary || "").slice(0, 1200)}`);
                    await vscode.commands.executeCommand("labwired.openEvidence");
                }
                else {
                    this.store.append("system", "twin/run failed — is labwired server running?");
                }
                break;
            }
            case "openSerial":
                await vscode.commands.executeCommand("labwired.openSerial");
                break;
            case "openPlan":
                await vscode.commands.executeCommand("labwired.openPlan");
                break;
            case "pickAndRun":
                await this.pickToolFromPalette();
                break;
            case "send": {
                let text = String(msg.text || "").trim();
                if (!text)
                    return;
                text = await expandAtMentions(text);
                this.store.append("user", text);
                // Real tools first (slash + NL shortcuts)
                if (text === "/tools" || text === "/help") {
                    this.store.append("tool", this.tools.listCatalog());
                    break;
                }
                const routed = await this.tools.tryRoute(text);
                if (routed) {
                    this.appendToolEvent(routed);
                    break;
                }
                // Freeform → Embedder-style server first, else local AgentSession
                const mode = this.session.getMode();
                this.store.append("assistant", "…");
                const tab = this.store.getActive();
                const asstMsg = tab.messages[tab.messages.length - 1];
                // Verify mode: always run twin first and attach evidence (product wedge)
                if (mode === "verify") {
                    this.store.append("system", "Verify mode → twin/run before answer…");
                    const twin = await this.evidence?.runTwin("smoke");
                    if (twin) {
                        this.store.append("tool", `${twin.ok || twin.twin_verified ? "✓" : "✗"} twin/run\n` +
                            `twin_verified=${!!(twin.ok || twin.twin_verified)} model_verified=false\n` +
                            `evidence=${twin.evidencePath || twin.runId}\n` +
                            `${(twin.summary || "").slice(0, 800)}`);
                        text =
                            `${text}\n\n[Host twin evidence]\n` +
                                `twin_verified=${!!(twin.ok || twin.twin_verified)}\n` +
                                `model_verified=false\n` +
                                `runId=${twin.runId}\n` +
                                `summary:\n${(twin.summary || "").slice(0, 1500)}`;
                    }
                    else {
                        this.store.append("system", "twin/run unavailable — answer must not claim verified.");
                        text +=
                            "\n\n[Host] twin/run failed; do not claim model_verified or twin_verified.";
                    }
                }
                if (this.rpc?.isRunning()) {
                    this.rpcAssistant = "";
                    this.rpcAsstMsg = asstMsg;
                    try {
                        await this.rpc.request("mode/set", { mode });
                        // Prefer hosted when Pro; server hard-fails ProjectRequired
                        const result = (await this.rpc.request("chat/send", {
                            content: text,
                            mode,
                        }));
                        if (result?.modelRoute) {
                            this.store.append("system", `model: ${result.modelRoute} · ${result.model || "?"}` +
                                (result.projectId ? ` · project ${result.projectId}` : ""));
                        }
                    }
                    catch (e) {
                        const msg = String(e);
                        if (msg.includes("Project required") || msg.includes("-32001")) {
                            if (asstMsg) {
                                asstMsg.text =
                                    "Pro hosted model needs a project. Run **LabWired: Select Pro Project** (or Log in → Dev Pro). Free local twin still works without a project.";
                            }
                            this.pushState();
                            const pick = await vscode.window.showInformationMessage("Hosted model requires a Pro project.", "Select project", "Use local model");
                            if (pick === "Select project") {
                                await vscode.commands.executeCommand("labwired.selectProject");
                            }
                            else if (pick === "Use local model") {
                                try {
                                    await this.rpc.request("chat/send", {
                                        content: text,
                                        mode,
                                        forceLocal: true,
                                    });
                                }
                                catch (e2) {
                                    await this.runLocalAgent(text, mode, asstMsg);
                                }
                            }
                            break;
                        }
                        if (asstMsg)
                            asstMsg.text = `RPC error: ${e}`;
                        this.pushState();
                        await this.runLocalAgent(text, mode, asstMsg);
                    }
                    break;
                }
                await this.runLocalAgent(text, mode, asstMsg);
                break;
            }
        }
    }
    async runLocalAgent(text, mode, asstMsg) {
        let assistant = "";
        await this.agent.run(text, mode, (ev) => {
            if (ev.type === "text") {
                assistant += ev.text;
                asstMsg.text = assistant || "…";
                this.pushState();
            }
            else if (ev.type === "tool") {
                this.store.append("tool", `⚙ ${ev.name}\n${ev.detail}`);
            }
            else if (ev.type === "error") {
                if (asstMsg.text === "…")
                    asstMsg.text = `Error: ${ev.message}`;
                else
                    this.store.append("system", `Agent error: ${ev.message}`);
                this.pushState();
            }
            else if (ev.type === "done") {
                if (asstMsg.text === "…" || !asstMsg.text) {
                    asstMsg.text = `(done via ${ev.source})`;
                }
                this.pushState();
            }
        });
    }
    async pickToolFromPalette() {
        const items = registry_1.TOOLS.map((t) => ({
            label: `$(tools) ${t.title}`,
            description: t.group,
            detail: t.description,
            name: t.name,
            tool: t,
        }));
        const pick = await vscode.window.showQuickPick(items, {
            title: "Run LabWired tool",
            matchOnDetail: true,
            matchOnDescription: true,
        });
        if (!pick)
            return;
        const params = {};
        for (const p of pick.tool.params || []) {
            const v = await vscode.window.showInputBox({
                prompt: p.description,
                value: p.default || "",
                placeHolder: p.name,
                ignoreFocusOut: true,
            });
            if (v === undefined)
                return;
            if (!v && p.required) {
                void vscode.window.showErrorMessage(`Required: ${p.name}`);
                return;
            }
            if (v)
                params[p.name] = v;
        }
        await this.invokeTool(pick.name, params);
    }
    pushState() {
        if (!this.view)
            return;
        const cli = this.bridge.getCli();
        const tab = this.store.getActive();
        const snap = this.session.snapshot();
        void this.view.webview.postMessage({
            type: "state",
            cliPath: cli.path || "",
            cliVersion: cli.version || "",
            mode: snap.mode,
            model: snap.model,
            project: snap.project,
            tabs: this.store.listTabs().map((t) => ({
                id: t.id,
                title: t.title,
                active: t.id === tab.id,
            })),
            messages: tab.messages,
            workspace: vscode.workspace.workspaceFolders?.[0]?.name || "",
            toolCount: registry_1.TOOLS.length,
        });
    }
    html() {
        const nonce = getNonce();
        return (0, theme_1.shellHtml)({
            nonce,
            title: "LabWired",
            body: `
<div class="app">
  <div class="tab-bar" id="tabs"></div>
  <div class="message-list" id="log" style="display:none"></div>
  <div class="empty-state" id="empty">
    <div class="empty-logo-mark">${theme_1.LW_MARK_SVG_LG}</div>
    <h2>LabWired</h2>
    <p>In-panel agent · live serial · local catalog. Tools: /doctor /probe /catalog bme280</p>
    <div class="quick-actions">
      <button class="quick-action" data-action="runTool" data-tool="doctor" type="button">Doctor</button>
      <button class="quick-action" data-action="runTool" data-tool="smoke" type="button">Smoke</button>
      <button class="quick-action" data-action="runTool" data-tool="probe_list" type="button">Probes</button>
      <button class="quick-action" data-action="listTools" type="button">/tools</button>
      <button class="quick-action" data-action="pickAndRun" type="button">All tools…</button>
      <button class="quick-action" data-action="openSerial" type="button">Monitor</button>
      <button class="quick-action" data-action="openEvidence" type="button">Evidence</button>
      <button class="quick-action" data-action="runTwin" type="button">Twin</button>
    </div>
  </div>
  <div class="composer">
    <div class="composer-shell mode-act" id="shell">
      <textarea class="composer-input" id="input" rows="3" placeholder="Message agent…  /doctor  /catalog esp32  /probe list"></textarea>
      <div class="composer-footer">
        <button type="button" class="composer-mode-pill" id="modePill" title="Cycle mode">Act</button>
        <button type="button" class="composer-icon-btn" data-action="pickAndRun" title="Tools">⚙</button>
        <span class="composer-spacer"></span>
        <button type="button" class="composer-icon-btn" data-action="undo" title="Undo">↶</button>
        <button type="button" class="composer-icon-btn" data-action="stop" title="Stop">■</button>
        <button type="button" class="composer-send" id="send">Send</button>
      </div>
    </div>
  </div>
</div>`,
            script: `
const log = document.getElementById('log');
const empty = document.getElementById('empty');
const input = document.getElementById('input');
const shell = document.getElementById('shell');
const modePill = document.getElementById('modePill');
const tabsEl = document.getElementById('tabs');
const labels = { act: 'Act', plan: 'Plan', debug: 'Debug', verify: 'Verify' };

function setModeUi(m) {
  modePill.textContent = labels[m] || m;
  shell.className = 'composer-shell mode-' + m;
}

function renderMessages(messages) {
  const list = messages || [];
  const has = list.length > 0;
  empty.style.display = has ? 'none' : 'flex';
  log.style.display = has ? 'block' : 'none';
  log.innerHTML = '';
  list.forEach(m => {
    const turn = document.createElement('div');
    turn.className = 'turn';
    const msg = document.createElement('div');
    msg.className = 'message ' + m.role;
    if (m.role === 'tool') {
      msg.innerHTML = '<div class="message-prefix">tool</div><div class="tool-container"><div class="tool-call"></div></div>';
      msg.querySelector('.tool-call').textContent = m.text;
    } else {
      msg.innerHTML = '<div class="message-prefix"></div><div class="message-content"></div>';
      msg.querySelector('.message-prefix').textContent = m.role;
      msg.querySelector('.message-content').textContent = m.text;
    }
    turn.appendChild(msg);
    log.appendChild(turn);
  });
  log.scrollTop = log.scrollHeight;
}

function renderTabs(tabs) {
  tabsEl.innerHTML = '';
  (tabs || []).forEach(t => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tab' + (t.active ? ' active' : '');
    b.textContent = t.title || 'Chat';
    b.onclick = () => vscode.postMessage({ type: 'selectTab', id: t.id });
    tabsEl.appendChild(b);
  });
  const actions = document.createElement('div');
  actions.className = 'tab-actions';
  const plus = document.createElement('button');
  plus.type = 'button'; plus.className = 'composer-icon-btn'; plus.textContent = '+';
  plus.onclick = () => vscode.postMessage({ type: 'newTab' });
  const close = document.createElement('button');
  close.type = 'button'; close.className = 'composer-icon-btn'; close.textContent = '×';
  close.onclick = () => vscode.postMessage({ type: 'closeTab' });
  actions.append(plus, close);
  tabsEl.appendChild(actions);
}

modePill.addEventListener('click', () => vscode.postMessage({ type: 'cycleMode' }));

document.querySelectorAll('[data-action]').forEach(el => {
  el.addEventListener('click', () => {
    const action = el.dataset.action;
    if (action === 'runTool' && el.dataset.tool) {
      vscode.postMessage({ type: 'runTool', name: el.dataset.tool });
      return;
    }
    vscode.postMessage({ type: action });
  });
});

function send() {
  const text = input.value.trim();
  if (!text) return;
  vscode.postMessage({ type: 'send', text });
  input.value = '';
  input.style.height = 'auto';
  shell.classList.remove('input-mode-bash', 'input-mode-serial');
}
document.getElementById('send').addEventListener('click', send);
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && (e.metaKey || e.ctrlKey)) {
    e.preventDefault(); send();
  }
});
input.addEventListener('input', () => {
  const v = input.value;
  shell.classList.remove('input-mode-bash', 'input-mode-serial');
  if (v.startsWith('!')) shell.classList.add('input-mode-bash');
  else if (v.startsWith('~')) shell.classList.add('input-mode-serial');
  else if (v.startsWith('/')) shell.classList.add('input-mode-bash'); // tool slash
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 160) + 'px';
});

window.addEventListener('message', (event) => {
  const m = event.data;
  if (m.type !== 'state') return;
  setModeUi(m.mode || 'act');
  renderTabs(m.tabs);
  renderMessages(m.messages);
});
vscode.postMessage({ type: 'ready' });
`,
        });
    }
}
exports.ChatViewProvider = ChatViewProvider;
async function expandAtMentions(text) {
    const re = /@([^\s]+)/g;
    let out = text;
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!root)
        return out;
    for (const m of text.matchAll(re)) {
        const rel = m[1];
        try {
            const uri = vscode.Uri.joinPath(root, rel);
            const data = await vscode.workspace.fs.readFile(uri);
            const content = Buffer.from(data).toString("utf8").slice(0, 12000);
            out = out.replace(m[0], `\n--- file: ${rel} ---\n${content}\n--- end ${rel} ---\n`);
        }
        catch {
            /* leave */
        }
    }
    return out;
}
function getNonce() {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let s = "";
    for (let i = 0; i < 32; i++)
        s += chars.charAt(Math.floor(Math.random() * chars.length));
    return s;
}
//# sourceMappingURL=chatProvider.js.map