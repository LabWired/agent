import * as vscode from "vscode";
import type { LabWiredBridge } from "../cli/bridge";
import type { ConversationStore } from "../services/conversationStore";
import type { SessionState, AgentMode } from "../services/sessionState";
import type { ToolRunner } from "../tools/runner";
import type { ToolRunEvent } from "../tools/runner";
import type { AgentSession } from "../agent/session";
import type { RpcClient } from "../cli/rpcClient";
import type { EvidenceViewProvider } from "./evidenceProvider";
import { loadCloudSession } from "../cli/cloudSession";
import { loadBoardMeta } from "../board/boardMint";
import {
  buildWorkspaceContext,
  contextHandoffBlock,
} from "../board/workspaceContext";
import { TOOLS } from "../tools/registry";
import { shellHtml, LW_MARK_SVG_LG } from "../webview/theme";

const MODE_LABEL: Record<AgentMode, string> = {
  act: "Act",
  plan: "Plan",
  debug: "Debug",
  verify: "Verify",
};

const PROVE_EXAMPLE = "Blink the LED and prove it on the twin.";

/**
 * Embedder-class chat chrome + LabWired twin wedge.
 * Default freeform path = CLI agent terminal (single brain).
 */
export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "labwired.chat";
  private view?: vscode.WebviewView;

  constructor(
    private readonly extUri: vscode.Uri,
    private readonly bridge: LabWiredBridge,
    private readonly store: ConversationStore,
    private readonly session: SessionState,
    private readonly tools: ToolRunner,
    private readonly agent: AgentSession,
    private readonly rpc?: RpcClient,
    private readonly evidence?: EvidenceViewProvider
  ) {
    store.onChange(() => this.pushState());
    session.onChange(() => this.pushState());
    rpc?.on("notification", (method: string, params: Record<string, unknown>) => {
      void this.onRpcNotification(method, params);
    });
  }

  private rpcAssistant = "";
  private rpcAsstMsg: { text: string; role: string } | null = null;

  private onRpcNotification(method: string, params: Record<string, unknown>) {
    if (method === "chat/textDelta") {
      const delta = String(params.delta || "");
      this.rpcAssistant += delta;
      if (this.rpcAsstMsg) {
        this.rpcAsstMsg.text = this.rpcAssistant;
        this.pushState();
      }
    } else if (method === "chat/toolCall") {
      this.store.append(
        "tool",
        `⚙ ${params.toolName || "tool"}\n${JSON.stringify(params.args || {}).slice(0, 800)}`
      );
    } else if (method === "chat/toolResult") {
      const r = params.result as { summary?: string; success?: boolean } | undefined;
      this.store.append(
        "tool",
        `${r?.success === false ? "✗" : "✓"} ${params.toolName || "tool"}\n${r?.summary || ""}`
      );
    } else if (method === "chat/done") {
      if (this.rpcAsstMsg && !this.rpcAssistant) {
        this.rpcAsstMsg.text = "(done)";
      }
      this.rpcAsstMsg = null;
      this.pushState();
    }
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _ctx: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
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
  async invokeTool(
    name: string,
    params: Record<string, string> = {}
  ): Promise<void> {
    this.store.append("system", `⚙ ${name}…`);
    this.pushState();
    try {
      const ev = await this.tools.runNamed(name, params);
      this.appendToolEvent(ev);
      if (name === "doctor" || name === "doctor_strict") {
        const ok = ev.status === "ok";
        void vscode.window.showInformationMessage(
          ok
            ? `LabWired doctor OK`
            : `LabWired doctor failed (exit ${ev.code ?? "?"}) — see Agent chat / Output`
        );
      }
    } catch (e) {
      this.store.append("system", `Tool ${name} crashed: ${e}`);
      void vscode.window.showErrorMessage(`LabWired ${name}: ${e}`);
    }
    this.pushState();
  }

  private appendToolEvent(ev: ToolRunEvent) {
    const head = `$ labwired ${ev.argv.join(" ")}`;
    const status =
      ev.status === "ok" ? "✓" : ev.status === "error" ? "✗" : "…";
    this.store.append(
      "tool",
      `${status} ${ev.title}\n${head}\nexit ${ev.code ?? "?"}\n\n${ev.output}`
    );
  }

  private async onMessage(msg: { type: string; [k: string]: unknown }) {
    switch (msg.type) {
      case "ready":
        this.pushState();
        break;
      case "cycleMode":
        this.session.cycleMode();
        break;
      case "setMode":
        this.session.setMode((msg.mode as AgentMode) || "act");
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
        await this.invokeTool(String(msg.name || ""), (msg.params as Record<string, string>) || {});
        break;
      case "listTools":
        this.store.append("tool", this.tools.listCatalog());
        break;
      case "startAgent": {
        const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        const ctx = buildWorkspaceContext(wsRoot);
        this.store.append(
          "system",
          `labwired_context · ${ctx.summary}\nnext: ${ctx.next.join(" → ")}`
        );
        await this.bridge.startAgentTerminal(this.session.getMode());
        this.store.append(
          "system",
          `Agent started (${MODE_LABEL[this.session.getMode()]}) — CLI terminal. ` +
            (ctx.twin_buildable
              ? "Twin ready — prefer prove path."
              : ctx.design_context_ok
                ? "Design context ok — twin optional; do not invent pins."
                : "No context yet — New board or Import first.")
        );
        this.pushState();
        break;
      }
      case "login":
        await vscode.commands.executeCommand("labwired.login");
        this.pushState();
        break;
      case "doctor":
        await this.invokeTool("doctor");
        this.pushState();
        break;
      case "openBoard":
      case "newBoard":
        await vscode.commands.executeCommand("labwired.newBoard");
        this.pushState();
        break;
      case "importPdf":
      case "importCircuit":
        await vscode.commands.executeCommand("labwired.importCircuit");
        this.pushState();
        break;
      case "statusClick": {
        const target = String(msg.target || "");
        if (target === "cli") {
          const cli = this.bridge.getCli();
          if (!cli.path) await vscode.commands.executeCommand("labwired.installCli");
          else await vscode.commands.executeCommand("labwired.showBuildInfo");
        } else if (target === "session") {
          await vscode.commands.executeCommand("labwired.login");
        } else if (target === "mode") {
          this.session.cycleMode();
        } else if (target === "twin" || target === "board") {
          await vscode.commands.executeCommand("labwired.newBoard");
        } else if (target === "ctx") {
          const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
          const ctx = buildWorkspaceContext(root);
          this.store.append("tool", contextHandoffBlock(ctx));
          if (ctx.mode === "empty") {
            await vscode.commands.executeCommand("labwired.newBoard");
          }
        }
        this.pushState();
        break;
      }
      case "fillExample": {
        // Webview fills composer; optional auto-send handled client-side
        break;
      }
      case "proveExample": {
        const text = PROVE_EXAMPLE;
        this.store.append("user", text);
        await this.handleFreeform(text);
        break;
      }
      case "stop":
        this.agent.stop();
        this.bridge.stopGeneration();
        this.store.append("system", "Stopped.");
        break;
      case "openEvidence":
        await vscode.commands.executeCommand("labwired.openEvidence");
        break;
      case "runTwin": {
        this.store.append("system", "⚙ run on digital twin…");
        try {
          const { runOnTwin, formatTwinResultForChat } = await import(
            "../twin/twinSession"
          );
          const r = await runOnTwin();
          this.store.append("tool", formatTwinResultForChat(r));
        } catch (e) {
          this.store.append("system", `Twin run failed: ${e}`);
        }
        this.pushState();
        break;
      }
      case "proveTwin": {
        this.store.append("system", "⚙ prove on digital twin…");
        try {
          const { proveOnTwin, formatTwinResultForChat } = await import(
            "../twin/twinSession"
          );
          const r = await proveOnTwin();
          this.store.append("tool", formatTwinResultForChat(r));
        } catch (e) {
          this.store.append("system", `Twin prove failed: ${e}`);
        }
        this.pushState();
        break;
      }
      case "debugTwin": {
        this.store.append("system", "⚙ debug on digital twin…");
        try {
          const { debugOnTwin, formatTwinResultForChat } = await import(
            "../twin/twinSession"
          );
          const r = await debugOnTwin();
          this.store.append("tool", formatTwinResultForChat(r));
        } catch (e) {
          this.store.append("system", `Twin debug failed: ${e}`);
        }
        this.pushState();
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
        if (!text) return;
        text = await expandAtMentions(text);
        this.store.append("user", text);

        if (text === "/tools" || text === "/help") {
          this.store.append("tool", this.tools.listCatalog());
          break;
        }
        const routed = await this.tools.tryRoute(text);
        if (routed) {
          this.appendToolEvent(routed);
          this.pushState();
          break;
        }

        await this.handleFreeform(text);
        break;
      }
    }
  }

  /** Single brain: terminal CLI agent by default; optional in-panel LLM. */
  private async handleFreeform(text: string): Promise<void> {
    const mode = this.session.getMode();
    const inPanel = vscode.workspace
      .getConfiguration("labwired")
      .get<boolean>("inPanelLlm");

    // Verify mode: prove on digital twin first (wedge) — results always land in chat
    if (mode === "verify") {
      this.store.append("system", "Verify → labwired_verify on digital twin…");
      try {
        const { proveOnTwin, formatTwinResultForChat } = await import(
          "../twin/twinSession"
        );
        const twin = await proveOnTwin();
        this.store.append("tool", formatTwinResultForChat(twin));
        text =
          `${text}\n\n[Host twin prove]\n` +
          `model_verified=${twin.model_verified}\n` +
          `status=${twin.status || "—"}\n` +
          `summary:\n${twin.summary.slice(0, 1500)}`;
        if (!twin.model_verified) {
          this.store.append(
            "system",
            "Twin not model_verified — do not claim verified until prove is green."
          );
        }
      } catch (e) {
        this.store.append("system", `Twin prove failed: ${e}`);
      }
    }

    // Debug mode: twin debug probe (observational)
    if (mode === "debug") {
      this.store.append("system", "Debug → digital twin probe…");
      try {
        const { debugOnTwin, formatTwinResultForChat } = await import(
          "../twin/twinSession"
        );
        const twin = await debugOnTwin();
        this.store.append("tool", formatTwinResultForChat(twin));
      } catch (e) {
        this.store.append("system", `Twin debug failed: ${e}`);
      }
    }

    if (!inPanel) {
      const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      const ctx = buildWorkspaceContext(wsRoot, text);
      const prompt =
        ctx.mode === "empty"
          ? text
          : `${text}\n\n${contextHandoffBlock(ctx)}`;
      this.store.append(
        "system",
        `Starting CLI agent (${MODE_LABEL[mode]})… · ${ctx.summary}`
      );
      await this.bridge.sendPromptViaTerminal(prompt, mode);
      this.store.append(
        "assistant",
        "→ Agent terminal (Embedder-class CLI + labwired_context). Reply there; twin/prove tools run inside the agent."
      );
      this.pushState();
      return;
    }

    this.store.append("assistant", "…");
    const tab = this.store.getActive();
    const asstMsg = tab.messages[tab.messages.length - 1];

    if (this.rpc?.isRunning()) {
      this.rpcAssistant = "";
      this.rpcAsstMsg = asstMsg;
      try {
        await this.rpc.request("mode/set", { mode });
        await this.rpc.request("chat/send", { content: text, mode });
      } catch (e) {
        if (asstMsg) asstMsg.text = `RPC error: ${e}`;
        this.pushState();
        await this.runLocalAgent(text, mode, asstMsg);
      }
      return;
    }

    await this.runLocalAgent(text, mode, asstMsg);
  }

  private async runLocalAgent(
    text: string,
    mode: AgentMode,
    asstMsg: { text: string }
  ) {
    let assistant = "";
    await this.agent.run(text, mode, (ev) => {
      if (ev.type === "text") {
        assistant += ev.text;
        asstMsg.text = assistant || "…";
        this.pushState();
      } else if (ev.type === "tool") {
        this.store.append("tool", `⚙ ${ev.name}\n${ev.detail}`);
      } else if (ev.type === "error") {
        if (asstMsg.text === "…") asstMsg.text = `Error: ${ev.message}`;
        else this.store.append("system", `Agent error: ${ev.message}`);
        this.pushState();
      } else if (ev.type === "done") {
        if (asstMsg.text === "…" || !asstMsg.text) {
          asstMsg.text = `(done via ${ev.source})`;
        }
        this.pushState();
      }
    });
  }

  private async pickToolFromPalette() {
    const items = TOOLS.map((t) => ({
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
    if (!pick) return;

    const params: Record<string, string> = {};
    for (const p of pick.tool.params || []) {
      const v = await vscode.window.showInputBox({
        prompt: p.description,
        value: p.default || "",
        placeHolder: p.name,
        ignoreFocusOut: true,
      });
      if (v === undefined) return;
      if (!v && p.required) {
        void vscode.window.showErrorMessage(`Required: ${p.name}`);
        return;
      }
      if (v) params[p.name] = v;
    }
    await this.invokeTool(pick.name, params);
  }

  private pushState() {
    if (!this.view) return;
    const cli = this.bridge.getCli();
    const tab = this.store.getActive();
    const snap = this.session.snapshot();
    const cloud = loadCloudSession();
    const signedIn = !!(cloud?.accessToken);
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const boardMeta = ws ? loadBoardMeta(ws) : undefined;
    const ctx = buildWorkspaceContext(ws);
    void this.view.webview.postMessage({
      type: "state",
      cliPath: cli.path || "",
      cliVersion: cli.version || "",
      cliFlavor: cli.flavor || "",
      mode: snap.mode,
      model: snap.model,
      project: snap.project || cloud?.projectId || "",
      signedIn,
      email: cloud?.email || "",
      board: boardMeta?.board || ctx.board || "",
      mcu: boardMeta?.mcu || ctx.mcu || "",
      designContextOk: ctx.design_context_ok,
      twinBuildable: ctx.twin_buildable,
      contextMode: ctx.mode,
      contextSummary: ctx.summary,
      tabs: this.store.listTabs().map((t) => ({
        id: t.id,
        title: t.title,
        active: t.id === tab.id,
      })),
      messages: tab.messages,
      workspace: vscode.workspace.workspaceFolders?.[0]?.name || "",
      toolCount: TOOLS.length,
      proveExample: PROVE_EXAMPLE,
    });
  }

  private html(): string {
    const nonce = getNonce();
    return shellHtml({
      nonce,
      title: "LabWired",
      body: `
<div class="app">
  <div class="status-strip" id="status">
    <button type="button" class="status-chip" data-status="cli" id="stCli" title="CLI">CLI …</button>
    <button type="button" class="status-chip" data-status="session" id="stSession" title="Session">Session …</button>
    <button type="button" class="status-chip" data-status="mode" id="stMode" title="Mode">Mode …</button>
    <button type="button" class="status-chip" data-status="ctx" id="stCtx" title="labwired_context — design always">Ctx · —</button>
    <button type="button" class="status-chip" data-status="board" id="stBoard" title="Board">Board · —</button>
    <button type="button" class="status-chip" data-status="twin" id="stTwin" title="Twin when buildable">Twin · —</button>
  </div>
  <div class="tab-bar" id="tabs"></div>
  <div class="message-list" id="log" style="display:none"></div>
  <div class="empty-state" id="empty">
    <div class="empty-logo-mark">${LW_MARK_SVG_LG}</div>
    <h2>LabWired</h2>
    <p class="empty-tagline">Design context always · twin prove when ready</p>
    <div class="quick-actions">
      <button class="quick-action primary" data-action="newBoard" type="button">New board…</button>
      <button class="quick-action" data-action="importCircuit" type="button">Import…</button>
      <button class="quick-action" data-action="startAgent" type="button">Start agent</button>
      <button class="quick-action" data-action="login" type="button">Log in</button>
      <button class="quick-action" data-action="doctor" type="button">Doctor</button>
    </div>
    <button type="button" class="example-prompt" data-action="proveExample" id="exampleBtn">
      “Blink the LED and prove it on the twin.”
    </button>
    <p class="empty-hint">New board / Import → Run · Prove · Debug on digital twin (login required for hosted twin)</p>
    <div class="quick-actions" style="margin-top:8px">
      <button class="quick-action" data-action="runTwin" type="button">Run twin</button>
      <button class="quick-action" data-action="proveTwin" type="button">Prove twin</button>
      <button class="quick-action" data-action="debugTwin" type="button">Debug twin</button>
    </div>
  </div>
  <div class="composer">
    <div class="composer-shell mode-act" id="shell">
      <textarea class="composer-input" id="input" rows="3" placeholder="Ask the agent…  (/doctor · /tools)"></textarea>
      <div class="composer-footer">
        <button type="button" class="composer-mode-pill" id="modePill" title="Cycle Plan / Act / Debug / Verify">Act</button>
        <button type="button" class="composer-icon-btn" data-action="startAgent" title="Start agent terminal">▶</button>
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
const stCli = document.getElementById('stCli');
const stSession = document.getElementById('stSession');
const stMode = document.getElementById('stMode');
const stCtx = document.getElementById('stCtx');
const stBoard = document.getElementById('stBoard');
const stTwin = document.getElementById('stTwin');
const labels = { act: 'Act', plan: 'Plan', debug: 'Debug', verify: 'Verify' };

function setModeUi(m) {
  modePill.textContent = labels[m] || m;
  shell.className = 'composer-shell mode-' + m;
  stMode.textContent = 'Mode · ' + (labels[m] || m);
}

function renderStatus(m) {
  if (m.cliPath) {
    stCli.textContent = 'CLI ✓' + (m.cliVersion ? ' v' + m.cliVersion : '');
    stCli.classList.add('ok');
    stCli.classList.remove('warn');
  } else {
    stCli.textContent = 'CLI missing';
    stCli.classList.add('warn');
    stCli.classList.remove('ok');
  }
  if (m.signedIn) {
    stSession.textContent = m.email ? ('In · ' + m.email.split('@')[0]) : 'Signed in';
    stSession.classList.add('ok');
    stSession.classList.remove('warn');
  } else {
    stSession.textContent = 'Not signed in';
    stSession.classList.add('warn');
    stSession.classList.remove('ok');
  }
  // LabWired distinction: context always, twin when buildable
  if (m.designContextOk) {
    stCtx.textContent = m.contextMode === 'twin_ready' ? 'Ctx · full' : 'Ctx · design';
    stCtx.classList.add('ok');
    stCtx.classList.remove('warn');
  } else {
    stCtx.textContent = 'Ctx · —';
    stCtx.classList.remove('ok');
    stCtx.classList.add('warn');
  }
  if (m.board) {
    stBoard.textContent = 'Board · ' + m.board;
    stBoard.classList.add('ok');
    stBoard.classList.remove('warn');
  } else {
    stBoard.textContent = 'Board · —';
    stBoard.classList.remove('ok');
  }
  if (m.twinBuildable) {
    stTwin.textContent = 'Twin · ready';
    stTwin.classList.add('ok');
    stTwin.classList.remove('warn');
  } else if (m.designContextOk) {
    stTwin.textContent = 'Twin · design-only';
    stTwin.classList.remove('ok');
    stTwin.classList.remove('warn');
  } else {
    stTwin.textContent = 'Twin · —';
    stTwin.classList.remove('ok');
  }
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

document.querySelectorAll('[data-status]').forEach(el => {
  el.addEventListener('click', () => {
    vscode.postMessage({ type: 'statusClick', target: el.dataset.status });
  });
});

document.querySelectorAll('[data-action]').forEach(el => {
  el.addEventListener('click', () => {
    const action = el.dataset.action;
    if (action === 'runTool' && el.dataset.tool) {
      vscode.postMessage({ type: 'runTool', name: el.dataset.tool });
      return;
    }
    if (action === 'proveTwin') {
      vscode.postMessage({ type: 'proveTwin' });
      return;
    }
    if (action === 'debugTwin') {
      vscode.postMessage({ type: 'debugTwin' });
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
  else if (v.startsWith('/')) shell.classList.add('input-mode-bash');
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 160) + 'px';
});

window.addEventListener('message', (event) => {
  const m = event.data;
  if (m.type !== 'state') return;
  setModeUi(m.mode || 'act');
  renderStatus(m);
  renderTabs(m.tabs);
  renderMessages(m.messages);
});
vscode.postMessage({ type: 'ready' });
`,
    });
  }
}

async function expandAtMentions(text: string): Promise<string> {
  const re = /@([^\s]+)/g;
  let out = text;
  const root = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!root) return out;
  for (const m of text.matchAll(re)) {
    const rel = m[1];
    try {
      const uri = vscode.Uri.joinPath(root, rel);
      const data = await vscode.workspace.fs.readFile(uri);
      const content = Buffer.from(data).toString("utf8").slice(0, 12000);
      out = out.replace(
        m[0],
        `\n--- file: ${rel} ---\n${content}\n--- end ${rel} ---\n`
      );
    } catch {
      /* leave */
    }
  }
  return out;
}

function getNonce(): string {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let s = "";
  for (let i = 0; i < 32; i++)
    s += chars.charAt(Math.floor(Math.random() * chars.length));
  return s;
}
