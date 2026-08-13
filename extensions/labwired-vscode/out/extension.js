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
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const path = __importStar(require("path"));
const bridge_1 = require("./cli/bridge");
const conversationStore_1 = require("./services/conversationStore");
const sessionState_1 = require("./services/sessionState");
const diffService_1 = require("./services/diffService");
const chatProvider_1 = require("./providers/chatProvider");
const serialProvider_1 = require("./providers/serialProvider");
const evidenceProvider_1 = require("./providers/evidenceProvider");
const historyProvider_1 = require("./providers/historyProvider");
const planProvider_1 = require("./providers/planProvider");
const plotProvider_1 = require("./providers/plotProvider");
const schematicEditor_1 = require("./providers/schematicEditor");
const runner_1 = require("./tools/runner");
const registry_1 = require("./tools/registry");
const service_1 = require("./catalog/service");
const catalogProvider_1 = require("./providers/catalogProvider");
const overviewProvider_1 = require("./providers/overviewProvider");
const session_1 = require("./agent/session");
const rpcClient_1 = require("./cli/rpcClient");
const messages_1 = require("./rpc/messages");
const agentic_1 = require("./datasheet/agentic");
const probeGdb_1 = require("./debug/probeGdb");
const billing_1 = require("./pro/billing");
function activate(context) {
    const output = vscode.window.createOutputChannel("LabWired");
    const bridge = new bridge_1.LabWiredBridge(output, context.extensionPath);
    const session = new sessionState_1.SessionState(context);
    const store = new conversationStore_1.ConversationStore(context);
    const diffs = new diffService_1.DiffService(context);
    const catalog = new service_1.CatalogService(context.extensionUri);
    const datasheets = new agentic_1.DatasheetService();
    const probeDebug = new probeGdb_1.ProbeDebugService();
    const billing = new billing_1.BillingService(context);
    billing.setBridge(bridge);
    const agentRoot = (0, rpcClient_1.resolveAgentRoot)(context.extensionPath);
    const rpc = new rpcClient_1.RpcClient(output, agentRoot);
    const tools = new runner_1.ToolRunner(bridge, catalog, datasheets, probeDebug, billing, rpc);
    const agent = new session_1.AgentSession(catalog, tools);
    bridge.refresh();
    const plot = new plotProvider_1.PlotViewProvider(context.extensionUri);
    const overview = new overviewProvider_1.OverviewViewProvider(context.extensionUri, bridge, catalog);
    const evidence = new evidenceProvider_1.EvidenceViewProvider(context.extensionUri, bridge, rpc);
    evidence.setOverview(overview);
    const serial = new serialProvider_1.SerialViewProvider(context.extensionUri, bridge, plot, rpc, overview);
    billing.setRpc(rpc);
    // Server-fed plot stream (plot/update carries named series)
    (0, messages_1.onNotification)(rpc, "plot/update", (p) => {
        plot.updateSeries((0, messages_1.parsePlotUpdate)(p));
    });
    const chat = new chatProvider_1.ChatViewProvider(context.extensionUri, bridge, store, session, tools, agent, rpc, evidence);
    const history = new historyProvider_1.HistoryViewProvider(context.extensionUri, store);
    const plan = new planProvider_1.PlanViewProvider(context.extensionUri, session);
    const schematic = new schematicEditor_1.SchematicEditorProvider(context.extensionUri);
    const catalogView = new catalogProvider_1.CatalogViewProvider(context.extensionUri, catalog);
    const regView = (id, provider) => vscode.window.registerWebviewViewProvider(id, provider, {
        webviewOptions: { retainContextWhenHidden: true },
    });
    // Start Embedder-style JSON-RPC server (labwired server / rpc-server.mjs)
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
    void rpc.start(ws).then(() => {
        output.appendLine("RPC server ready (Embedder --server clone).");
    }, (e) => {
        output.appendLine(`RPC server failed (using local agent fallback): ${e}`);
    });
    context.subscriptions.push(output, { dispose: () => serial.dispose() }, { dispose: () => agent.stop() }, { dispose: () => void rpc.stop() }, { dispose: () => probeDebug.dispose() }, regView(overviewProvider_1.OverviewViewProvider.viewType, overview), regView(chatProvider_1.ChatViewProvider.viewType, chat), regView(serialProvider_1.SerialViewProvider.viewType, serial), regView(evidenceProvider_1.EvidenceViewProvider.viewType, evidence), regView(historyProvider_1.HistoryViewProvider.viewType, history), regView(planProvider_1.PlanViewProvider.viewType, plan), regView(plotProvider_1.PlotViewProvider.viewType, plot), regView(catalogProvider_1.CatalogViewProvider.viewType, catalogView), vscode.window.registerCustomEditorProvider(schematicEditor_1.SchematicEditorProvider.viewType, schematic, { webviewOptions: { retainContextWhenHidden: true } }));
    const focus = async (viewId) => {
        await vscode.commands.executeCommand("workbench.view.extension.labwired");
        try {
            await vscode.commands.executeCommand(`${viewId}.focus`);
        }
        catch {
            /* some hosts ignore */
        }
    };
    const cmds = [
        [
            "labwired.openOverview",
            async () => {
                overview.openInEditor();
                await focus("labwired.overview");
            },
        ],
        [
            "labwired.pullTwinDisplay",
            async () => {
                overview.openInEditor();
                const ok = await overview.pullFromTwinInspect();
                if (!ok)
                    await overview.pullFromWorkspaceFiles();
                await focus("labwired.overview");
            },
        ],
        ["labwired.openChat", async () => focus("labwired.chat")],
        [
            "labwired.openChatInEditor",
            async () => {
                const panel = vscode.window.createWebviewPanel("labwired.chat.editor", "LabWired Chat", vscode.ViewColumn.Beside, { enableScripts: true, retainContextWhenHidden: true });
                // Reuse sidebar by focusing; editor panel is a lightweight redirect
                panel.webview.html = `<html><head><meta name="color-scheme" content="dark light"/><style>
          body{font:13px var(--vscode-font-family,system-ui);padding:20px;color:var(--vscode-foreground,#ccc);background:var(--vscode-editor-background,#1e1e1e)}
          .box{max-width:400px;border:1px solid var(--vscode-panel-border,rgba(128,128,128,.35));border-radius:6px;padding:14px 16px;background:var(--vscode-sideBar-background,transparent)}
          h3{margin:0 0 8px;font-size:13px;font-weight:600}
          p{margin:0 0 6px;line-height:1.45;color:var(--vscode-descriptionForeground,#9d9d9d);font-size:12px}
          .accent{color:#0056b3}
          </style></head><body>
          <div class="box">
          <h3><span class="accent">LabWired</span> Chat</h3>
          <p>Use the <b>LabWired → Agent</b> sidebar for multi-tab chat (Plan / Act / Debug / Verify).</p>
          <p>This editor tab keeps the workbench docked beside code.</p>
          </div></body></html>`;
                await focus("labwired.chat");
            },
        ],
        [
            "labwired.openConversationFromHistory",
            async () => {
                const items = store.historyList();
                const pick = await vscode.window.showQuickPick(items.map((i) => ({
                    label: i.title,
                    description: `${i.count} msgs`,
                    id: i.id,
                })), { title: "Open conversation" });
                if (pick && "id" in pick) {
                    store.setActive(pick.id);
                    await focus("labwired.chat");
                }
            },
        ],
        ["labwired.refreshHistory", () => history.refresh()],
        [
            "labwired.moveChatToSecondarySidebar",
            async () => {
                try {
                    await vscode.commands.executeCommand("workbench.action.focusAuxiliaryBar");
                }
                catch {
                    /* ignore */
                }
                await focus("labwired.chat");
                void vscode.window.showInformationMessage("LabWired chat focused (secondary bar when available).");
            },
        ],
        [
            "labwired.showBuildInfo",
            async () => {
                const info = bridge.startupProfile();
                bridge.log(info);
                bridge.showOutput();
                const doc = await vscode.workspace.openTextDocument({
                    content: info,
                    language: "plaintext",
                });
                await vscode.window.showTextDocument(doc, { preview: true });
            },
        ],
        [
            "labwired.openSchematics",
            async () => {
                const uris = await vscode.window.showOpenDialog({
                    canSelectMany: false,
                    filters: {
                        KiCad: ["kicad_sch", "kicad_pcb", "kicad_pro", "sch"],
                    },
                    title: "Open schematic",
                });
                if (uris?.[0]) {
                    await vscode.commands.executeCommand("vscode.openWith", uris[0], schematicEditor_1.SchematicEditorProvider.viewType);
                }
            },
        ],
        [
            "labwired.openSchematicFile",
            async (uri) => {
                const u = uri ||
                    (await vscode.window.showOpenDialog({ canSelectMany: false }))?.[0];
                if (u) {
                    await vscode.commands.executeCommand("vscode.openWith", u, schematicEditor_1.SchematicEditorProvider.viewType);
                }
            },
        ],
        ["labwired.switchToPlan", () => session.setMode("plan")],
        ["labwired.switchToAct", () => session.setMode("act")],
        ["labwired.switchToDebug", () => session.setMode("debug")],
        ["labwired.switchToVerify", () => session.setMode("verify")],
        [
            "labwired.switchMode",
            async () => {
                const next = session.cycleMode();
                void vscode.window.showInformationMessage(`LabWired mode: ${next}`);
                chat.refresh();
            },
        ],
        ["labwired.showSidebar", async () => focus("labwired.chat")],
        [
            "labwired.hideSidebar",
            async () => {
                await vscode.commands.executeCommand("workbench.action.closeSidebar");
            },
        ],
        [
            "labwired.showMonitor",
            async () => {
                await vscode.commands.executeCommand("labwired.serial.focus");
            },
        ],
        [
            "labwired.hideMonitor",
            async () => {
                await vscode.commands.executeCommand("workbench.action.togglePanel");
            },
        ],
        [
            "labwired.showTerminal",
            async () => {
                await vscode.commands.executeCommand("workbench.action.terminal.toggleTerminal");
            },
        ],
        ["labwired.newTab", () => store.newTab()],
        ["labwired.closeTab", () => store.closeActive()],
        [
            "labwired.restartCli",
            async () => {
                bridge.stopGeneration();
                const msg = await bridge.tryStartServer();
                const r = bridge.refresh();
                void vscode.window.showInformationMessage(r.path ? `CLI ready. ${msg}` : "CLI missing");
            },
        ],
        [
            "labwired.switchModel",
            async () => {
                const models = [
                    "local",
                    "deepinfra",
                    "gpt-4.1",
                    "claude-sonnet",
                    "custom…",
                ];
                const pick = await vscode.window.showQuickPick(models, {
                    title: "Switch model",
                });
                if (!pick)
                    return;
                let model = pick;
                if (pick === "custom…") {
                    model =
                        (await vscode.window.showInputBox({
                            prompt: "Model id",
                        })) || "";
                }
                if (model) {
                    await session.setModel(model);
                    void vscode.window.showInformationMessage(`Model: ${model}`);
                }
            },
        ],
        ["labwired.stopGeneration", () => bridge.stopGeneration()],
        ["labwired.installCli", () => bridge.installCli()],
        ["labwired.clearConversation", () => store.clearActive()],
        ["labwired.compressConversation", () => store.compressActive()],
        [
            "labwired.viewUsage",
            async () => {
                await billing.openBilling();
            },
        ],
        ["labwired.viewHistory", async () => focus("labwired.history")],
        [
            "labwired.switchTeam",
            async () => {
                const team = await vscode.window.showInputBox({
                    prompt: "Team name / id",
                    value: session.snapshot().team,
                });
                if (team != null) {
                    await session.setTeam(team);
                    void vscode.window.showInformationMessage(`Team: ${team || "(none)"}`);
                }
            },
        ],
        [
            "labwired.switchProject",
            async () => {
                const project = await vscode.window.showInputBox({
                    prompt: "Project name / id",
                    value: session.snapshot().project,
                });
                if (project != null) {
                    await session.setProject(project);
                    void vscode.window.showInformationMessage(`Project: ${project || "(none)"}`);
                }
            },
        ],
        [
            "labwired.undoLastMessage",
            () => {
                const ok = store.undoLast();
                void vscode.window.showInformationMessage(ok ? "Undid last turn / restored checkpoint" : "Nothing to undo");
            },
        ],
        [
            "labwired.rewind",
            async () => {
                const cps = store.listCheckpoints();
                if (!cps.length) {
                    void vscode.window.showInformationMessage("No checkpoints yet");
                    return;
                }
                const pick = await vscode.window.showQuickPick(cps.map((c) => ({
                    label: c.label,
                    description: new Date(c.at).toLocaleString(),
                    id: c.id,
                })), { title: "Rewind to checkpoint" });
                if (pick && "id" in pick) {
                    store.restoreCheckpoint(pick.id);
                    await focus("labwired.chat");
                }
            },
        ],
        [
            "labwired.openConsole",
            async () => {
                await vscode.env.openExternal(vscode.Uri.parse(session.appUrl()));
            },
        ],
        ["labwired.openLogs", () => bridge.openLogsFolder()],
        [
            "labwired.showCliProcessOutput",
            () => {
                bridge.showOutput();
            },
        ],
        ["labwired.showStartupProfile", async () => {
                await vscode.commands.executeCommand("labwired.showBuildInfo");
            }],
        [
            "labwired.openSerial",
            async () => {
                await vscode.commands.executeCommand("labwired.serial.focus");
            },
        ],
        ["labwired.openSerialInEditor", () => serial.openInEditor()],
        [
            "labwired.toggleSerial",
            async () => {
                await vscode.commands.executeCommand("workbench.action.togglePanel");
                await vscode.commands.executeCommand("labwired.serial.focus");
            },
        ],
        [
            "labwired.openPlot",
            async () => {
                await vscode.commands.executeCommand("labwired.plot.focus");
            },
        ],
        [
            "labwired.openComposedPlot",
            async () => {
                const picked = await vscode.window.showOpenDialog({
                    canSelectMany: false,
                    filters: { JSON: ["json"] },
                    title: "Open composed.json from labwired compose job",
                });
                if (!picked?.[0])
                    return;
                await plot.loadComposedFile(picked[0]);
            },
        ],
        ["labwired.openEvidence", async () => focus("labwired.evidence")],
        ["labwired.openPlan", async () => focus("labwired.plan")],
        [
            "labwired.runTwin",
            async () => {
                await focus("labwired.evidence");
                const r = await vscode.window.withProgress({
                    location: vscode.ProgressLocation.Notification,
                    title: "LabWired twin/run…",
                }, async () => evidence.runTwin("smoke"));
                if (r) {
                    void vscode.window.showInformationMessage(r.ok || r.twin_verified
                        ? `Twin OK · ${r.runId}`
                        : `Twin failed · ${r.runId || "?"}`);
                }
                else {
                    void vscode.window.showWarningMessage("twin/run failed");
                }
            },
        ],
        [
            "labwired.startRtt",
            async () => {
                if (!rpc.isRunning()) {
                    void vscode.window.showWarningMessage("labwired server not running");
                    return;
                }
                const chip = (await vscode.window.showInputBox({
                    prompt: "Chip for probe-rs RTT (e.g. STM32F401RETx, nRF52840_xxAA)",
                    value: vscode.workspace.getConfiguration("labwired").get("defaultChip") ||
                        process.env.LABWIRED_CHIP ||
                        "",
                    placeHolder: "Leave empty for demo stream without probe",
                })) || "";
                const elf = (await vscode.window.showInputBox({
                    prompt: "ELF path (optional, for RTT control block / defmt)",
                    value: process.env.LABWIRED_ELF || "",
                })) || "";
                try {
                    const res = (await rpc.request("trace/sessionStart", {
                        transport: chip ? "rtt" : "demo",
                        chip: chip || undefined,
                        elf: elf || undefined,
                        demo: !chip,
                    }));
                    const ch = vscode.window.createOutputChannel("LabWired RTT");
                    ch.show(true);
                    ch.appendLine(res.demo
                        ? `[demo] ${res.message || "RTT demo stream"}`
                        : `[rtt] session ${res.sessionId} chip=${res.chip}`);
                    const onEv = (method, params) => {
                        if (method === "trace/eventBatch") {
                            const events = params.events;
                            for (const e of events || []) {
                                ch.appendLine(e.msg || "");
                            }
                        }
                        else if (method === "trace/streamStatus") {
                            ch.appendLine(`[status] ${JSON.stringify(params)}`);
                        }
                    };
                    rpc.on("notification", onEv);
                    void vscode.window.showInformationMessage(res.demo
                        ? `RTT demo started (${res.sessionId}) — attach probe + chip for live`
                        : `RTT live: ${res.sessionId}`);
                }
                catch (e) {
                    void vscode.window.showErrorMessage(`RTT start failed: ${e}`);
                }
            },
        ],
        [
            "labwired.stopRtt",
            async () => {
                if (!rpc.isRunning())
                    return;
                try {
                    await rpc.request("trace/sessionStop", {});
                    void vscode.window.showInformationMessage("RTT/trace session stopped");
                }
                catch (e) {
                    void vscode.window.showErrorMessage(String(e));
                }
            },
        ],
        [
            "labwired.instruments",
            async () => {
                if (!rpc.isRunning()) {
                    void vscode.window.showWarningMessage("labwired server not running");
                    return;
                }
                const list = (await rpc.request("instrument/list", {}));
                const pick = await vscode.window.showQuickPick((list.drivers || []).map((d) => ({
                    label: d.label,
                    description: d.id + (d.available === false ? " (not installed)" : ""),
                    id: d.id,
                })), { title: "Open instrument driver" });
                if (!pick)
                    return;
                try {
                    let resource = "";
                    let chip = "";
                    let profile = "";
                    if (pick.id === "scpi") {
                        resource =
                            (await vscode.window.showInputBox({
                                prompt: "SCPI resource (TCPIP0::host::5025::SOCKET)",
                                value: process.env.LABWIRED_SCPI_RESOURCE || "TCPIP0::127.0.0.1::5025::SOCKET",
                            })) || "";
                        profile =
                            (await vscode.window.showQuickPick([
                                "generic",
                                "rigol-ds1000z",
                                "siglent-sds",
                                "keysight-dsox",
                                "rigol-dp800",
                                "siglent-spd",
                            ], { title: "SCPI profile" })) || "generic";
                    }
                    if (pick.id === "probe_rs") {
                        chip =
                            (await vscode.window.showInputBox({
                                prompt: "Chip (optional)",
                                value: process.env.LABWIRED_CHIP || "",
                            })) || "";
                    }
                    const opened = (await rpc.request("instrument/open", {
                        driver: pick.id,
                        resource,
                        chip,
                        profile,
                        force: true,
                    }));
                    const id = opened.session?.id;
                    if (!id)
                        return;
                    const idn = (await rpc.request("instrument/scpi", {
                        id,
                        command: "*IDN?",
                    }));
                    const cap = (await rpc.request("instrument/capture", { id }));
                    void vscode.window.showInformationMessage(`${opened.session?.label}: ${idn.response || "?"} · evidence ${cap.runId || ""}`);
                    if (cap.evidencePath) {
                        await evidence.loadPath(path.join(cap.evidencePath, "result.json"));
                        await focus("labwired.evidence");
                    }
                }
                catch (e) {
                    void vscode.window.showErrorMessage(String(e));
                }
            },
        ],
        [
            "labwired.loadEvidence",
            async () => {
                await focus("labwired.evidence");
                const uris = await vscode.window.showOpenDialog({
                    canSelectMany: false,
                    filters: { JSON: ["json"] },
                });
                if (uris?.[0])
                    await evidence.loadPath(uris[0].fsPath);
            },
        ],
        ["labwired.startAgent", async () => bridge.startAgentTerminal(session.getMode())],
        [
            "labwired.doctor",
            async () => {
                await chat.invokeTool("doctor");
                await focus("labwired.chat");
            },
        ],
        [
            "labwired.smoke",
            async () => {
                // Twin path produces evidence (smoke suite under the hood)
                await vscode.commands.executeCommand("labwired.runTwin");
            },
        ],
        [
            "labwired.runTool",
            async () => {
                await focus("labwired.chat");
                // Reuse chat palette via webview message path
                await vscode.commands.executeCommand("labwired.openChat");
                const items = registry_1.TOOLS.map((t) => ({
                    label: t.title,
                    description: t.group,
                    detail: t.description,
                    name: t.name,
                }));
                const pick = await vscode.window.showQuickPick(items, {
                    title: `LabWired tools (${registry_1.TOOLS.length})`,
                    matchOnDetail: true,
                });
                if (!pick)
                    return;
                const def = registry_1.TOOLS.find((t) => t.name === pick.name);
                const params = {};
                for (const p of def?.params || []) {
                    const v = await vscode.window.showInputBox({
                        prompt: p.description,
                        value: p.default || "",
                        placeHolder: p.name,
                    });
                    if (v === undefined)
                        return;
                    if (v)
                        params[p.name] = v;
                }
                await chat.invokeTool(pick.name, params);
            },
        ],
        [
            "labwired.restartBridge",
            () => {
                const r = bridge.refresh();
                void vscode.window.showInformationMessage(r.path ? `CLI: ${r.path}` : "CLI not found");
            },
        ],
        [
            "labwired.replayOnboarding",
            async () => {
                await vscode.commands.executeCommand("workbench.action.openWalkthrough", "labwired.labwired-vscode#labwiredGettingStarted", true);
            },
        ],
        [
            "labwired.showGettingStarted",
            async () => {
                await vscode.commands.executeCommand("workbench.action.openWalkthrough", "labwired.labwired-vscode#labwiredGettingStarted", false);
            },
        ],
        [
            "labwired.openMcpDocs",
            async () => {
                await vscode.env.openExternal(vscode.Uri.parse("https://labwired.com/agent.html"));
            },
        ],
        [
            "labwired.githubDaemon",
            async () => {
                void vscode.window.showInformationMessage("GitHub daemon: parity with embedder start daemon — ship after labwired --server.");
                await vscode.env.openExternal(vscode.Uri.parse("https://docs.embedder.com/integrations/github-bot"));
            },
        ],
        [
            "labwired.login",
            async () => {
                await billing.loginInteractive();
                const s = await billing.status();
                void vscode.window.setStatusBarMessage(s.loggedIn
                    ? `LabWired Pro · ${s.projectName || s.projectId || "no project"}`
                    : "LabWired Free", 5000);
            },
        ],
        [
            "labwired.selectProject",
            async () => {
                await billing.selectProjectInteractive();
            },
        ],
        [
            "labwired.logout",
            async () => {
                await billing.logout();
            },
        ],
        [
            "labwired.billingStatus",
            async () => {
                const s = await billing.status();
                const doc = await vscode.workspace.openTextDocument({
                    content: billing.formatStatus(s),
                    language: "markdown",
                });
                await vscode.window.showTextDocument(doc, { preview: true });
            },
        ],
        [
            "labwired.datasheetExtract",
            async () => {
                await chat.invokeTool("datasheet_extract");
                await focus("labwired.chat");
            },
        ],
        [
            "labwired.debugInfo",
            async () => {
                await chat.invokeTool("debug_info");
                await focus("labwired.chat");
            },
        ],
        [
            "labwired.startGithubDaemon",
            async () => {
                const term = vscode.window.createTerminal("LabWired Daemon");
                term.show(true);
                const pathMod = await Promise.resolve().then(() => __importStar(require("path")));
                const fsMod = await Promise.resolve().then(() => __importStar(require("fs")));
                const candidates = [
                    pathMod.join(agentRoot, "server", "github-daemon.mjs"),
                    pathMod.join(agentRoot, "..", "..", "server", "github-daemon.mjs"),
                    pathMod.join(context.extensionPath, "server", "github-daemon.mjs"),
                ];
                const script = candidates.find((p) => fsMod.existsSync(p));
                if (!script) {
                    void vscode.window.showErrorMessage("github-daemon.mjs not found — reinstall extension or agent package");
                    return;
                }
                term.sendText(`export LABWIRED_GITHUB_REPO="\${LABWIRED_GITHUB_REPO:-}"; echo "Need: GITHUB_TOKEN + LABWIRED_GITHUB_REPO=owner/name"; node "${script}"`);
            },
        ],
        [
            "labwired.diffApproveDemo",
            async () => {
                const result = await diffs.proposeEdit({
                    title: "LabWired proposed edit",
                    pathLabel: "src/main.c",
                    before: "void loop() {\n  // TODO\n}\n",
                    after: "void loop() {\n  digitalWrite(LED_BUILTIN, HIGH);\n  delay(500);\n  digitalWrite(LED_BUILTIN, LOW);\n  delay(500);\n}\n",
                });
                void vscode.window.showInformationMessage(`Diff response: ${result || "dismissed"}`);
            },
        ],
    ];
    for (const [id, fn] of cmds) {
        context.subscriptions.push(vscode.commands.registerCommand(id, fn));
    }
    // Mode change → notify chat + keep server-side gates in sync, so
    // palette-initiated tool runs honor the current plan/verify mode too.
    const pushMode = () => {
        if (!rpc.isRunning())
            return;
        void rpc
            .request("mode/set", { mode: session.getMode() })
            .catch(() => { });
    };
    context.subscriptions.push(session.onChange(() => {
        chat.refresh();
        pushMode();
    }));
    // Session mode may be restored (e.g. plan) while the server boots in act.
    rpc.on("ready", pushMode);
    const cfg = vscode.workspace.getConfiguration("labwired");
    if (cfg.get("autoRevealOnStartup")) {
        void vscode.commands.executeCommand("workbench.view.extension.labwired");
    }
    if (cfg.get("closeAgentChatOnActivation")) {
        // Best-effort; command ids vary by host
        void (async () => {
            for (const c of [
                "workbench.action.chat.close",
                "workbench.panel.chat.view.copilot.removeView",
            ]) {
                try {
                    await vscode.commands.executeCommand(c);
                }
                catch {
                    /* ignore */
                }
            }
        })();
    }
    const cs = catalog.stats();
    const cli = bridge.getCli();
    store.append("system", `LabWired workbench v0.6.3 — same start-here as CLI\n` +
        `1. Log in (labwired login) → hosted MCP + model\n` +
        `2. Doctor → Start Agent (Terminal) → LabWired Agent + golden-path\n` +
        `3. Overview: twin display (inspect) · topology · serial · elements\n` +
        `4. “Blink the LED and prove it on the twin.”\n` +
        `• Packs: golden-path · bringup · prove · observe · desk-hw\n` +
        `• Knowledge: MCP labwired_part / labwired_datasheet\n` +
        `• Compose: labwired compose … (elements, not ready-made plots)\n` +
        `• CLI: ${cli.path || "(missing)"} (${cli.source}${cli.version ? ` v${cli.version}` : ""})\n` +
        `• Catalog: ${cs.parts} parts · tools: /tools`);
    output.appendLine(`LabWired workbench v0.6.3 — tools=${registry_1.TOOLS.length} catalog=${cs.parts} cli=${cli.path || "missing"}`);
    // Surface overview on first activation so visual glass matches LabWired UI
    void overview.pushState();
}
function deactivate() {
    /* noop */
}
//# sourceMappingURL=extension.js.map