import * as vscode from "vscode";
import * as path from "path";
import { LabWiredBridge } from "./cli/bridge";
import { ConversationStore } from "./services/conversationStore";
import { SessionState } from "./services/sessionState";
import { DiffService } from "./services/diffService";
import { ChatViewProvider } from "./providers/chatProvider";
import { SerialViewProvider } from "./providers/serialProvider";
import { EvidenceViewProvider } from "./providers/evidenceProvider";
import { HistoryViewProvider } from "./providers/historyProvider";
import { PlanViewProvider } from "./providers/planProvider";
import { PlotViewProvider } from "./providers/plotProvider";
import { SchematicEditorProvider } from "./providers/schematicEditor";
import { ToolRunner } from "./tools/runner";
import { TOOLS } from "./tools/registry";
import { CatalogService } from "./catalog/service";
import { CatalogViewProvider } from "./providers/catalogProvider";
import { OverviewViewProvider } from "./providers/overviewProvider";
import { AgentSession } from "./agent/session";
import { RpcClient, resolveAgentRoot } from "./cli/rpcClient";
import { onNotification, parsePlotUpdate } from "./rpc/messages";
import { DatasheetService } from "./datasheet/agentic";
import { ProbeDebugService } from "./debug/probeGdb";
import { BillingService } from "./pro/billing";

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("LabWired");
  const bridge = new LabWiredBridge(output, context.extensionPath);
  const session = new SessionState(context);
  const store = new ConversationStore(context);
  const diffs = new DiffService(context);
  const catalog = new CatalogService(context.extensionUri);
  const datasheets = new DatasheetService();
  const probeDebug = new ProbeDebugService();
  const billing = new BillingService(context);
  billing.setBridge(bridge);
  billing.setOutput(output);
  const agentRoot = resolveAgentRoot(context.extensionPath);
  const rpc = new RpcClient(output, agentRoot);
  const tools = new ToolRunner(
    bridge,
    catalog,
    datasheets,
    probeDebug,
    billing,
    rpc
  );
  const agent = new AgentSession(catalog, tools);
  bridge.refresh();

  const plot = new PlotViewProvider(context.extensionUri);
  const overview = new OverviewViewProvider(
    context.extensionUri,
    bridge,
    catalog
  );
  const evidence = new EvidenceViewProvider(context.extensionUri, bridge, rpc);
  evidence.setOverview(overview);
  const serial = new SerialViewProvider(
    context.extensionUri,
    bridge,
    plot,
    rpc,
    overview
  );
  billing.setRpc(rpc);
  // Server-fed plot stream (plot/update carries named series)
  onNotification(rpc, "plot/update", (p) => {
    plot.updateSeries(parsePlotUpdate(p));
  });
  const chat = new ChatViewProvider(
    context.extensionUri,
    bridge,
    store,
    session,
    tools,
    agent,
    rpc,
    evidence
  );
  const history = new HistoryViewProvider(context.extensionUri, store);
  const plan = new PlanViewProvider(context.extensionUri, session);
  const schematic = new SchematicEditorProvider(context.extensionUri);
  const catalogView = new CatalogViewProvider(context.extensionUri, catalog);

  const regView = (
    id: string,
    provider: vscode.WebviewViewProvider
  ) =>
    vscode.window.registerWebviewViewProvider(id, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    });

  // Start Embedder-style JSON-RPC server (labwired server / rpc-server.mjs)
  const ws =
    vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
  void rpc.start(ws).then(
    () => {
      output.appendLine("RPC server ready (Embedder --server clone).");
    },
    (e) => {
      output.appendLine(`RPC server failed (using local agent fallback): ${e}`);
    }
  );

  context.subscriptions.push(
    output,
    { dispose: () => serial.dispose() },
    { dispose: () => agent.stop() },
    { dispose: () => void rpc.stop() },
    { dispose: () => probeDebug.dispose() },
    regView(OverviewViewProvider.viewType, overview),
    regView(ChatViewProvider.viewType, chat),
    regView(SerialViewProvider.viewType, serial),
    regView(EvidenceViewProvider.viewType, evidence),
    regView(HistoryViewProvider.viewType, history),
    regView(PlanViewProvider.viewType, plan),
    regView(PlotViewProvider.viewType, plot),
    regView(CatalogViewProvider.viewType, catalogView),
    vscode.window.registerCustomEditorProvider(
      SchematicEditorProvider.viewType,
      schematic,
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );

  const focus = async (viewId: string) => {
    await vscode.commands.executeCommand("workbench.view.extension.labwired");
    try {
      await vscode.commands.executeCommand(`${viewId}.focus`);
    } catch {
      /* some hosts ignore */
    }
  };

  const cmds: [string, (...args: never[]) => unknown][] = [
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
        if (!ok) await overview.pullFromWorkspaceFiles();
        await focus("labwired.overview");
      },
    ],
    ["labwired.openChat", async () => focus("labwired.chat")],
    [
      "labwired.openChatInEditor",
      async () => {
        const panel = vscode.window.createWebviewPanel(
          "labwired.chat.editor",
          "LabWired Chat",
          vscode.ViewColumn.Beside,
          { enableScripts: true, retainContextWhenHidden: true }
        );
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
        const pick = await vscode.window.showQuickPick(
          items.map((i) => ({
            label: i.title,
            description: `${i.count} msgs`,
            id: i.id,
          })),
          { title: "Open conversation" }
        );
        if (pick && "id" in pick) {
          store.setActive((pick as { id: string }).id);
          await focus("labwired.chat");
        }
      },
    ],
    ["labwired.refreshHistory", () => history.refresh()],
    [
      "labwired.moveChatToSecondarySidebar",
      async () => {
        try {
          await vscode.commands.executeCommand(
            "workbench.action.focusAuxiliaryBar"
          );
        } catch {
          /* ignore */
        }
        await focus("labwired.chat");
        void vscode.window.showInformationMessage(
          "LabWired chat focused (secondary bar when available)."
        );
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
          await vscode.commands.executeCommand(
            "vscode.openWith",
            uris[0],
            SchematicEditorProvider.viewType
          );
        }
      },
    ],
    [
      "labwired.openSchematicFile",
      async (uri?: vscode.Uri) => {
        const u =
          uri ||
          (await vscode.window.showOpenDialog({ canSelectMany: false }))?.[0];
        if (u) {
          await vscode.commands.executeCommand(
            "vscode.openWith",
            u,
            SchematicEditorProvider.viewType
          );
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
        await vscode.commands.executeCommand(
          "workbench.action.terminal.toggleTerminal"
        );
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
        void vscode.window.showInformationMessage(
          r.path ? `CLI ready. ${msg}` : "CLI missing"
        );
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
        if (!pick) return;
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
          void vscode.window.showInformationMessage(
            `Project: ${project || "(none)"}`
          );
        }
      },
    ],
    [
      "labwired.undoLastMessage",
      () => {
        const ok = store.undoLast();
        void vscode.window.showInformationMessage(
          ok ? "Undid last turn / restored checkpoint" : "Nothing to undo"
        );
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
        const pick = await vscode.window.showQuickPick(
          cps.map((c) => ({
            label: c.label,
            description: new Date(c.at).toLocaleString(),
            id: c.id,
          })),
          { title: "Rewind to checkpoint" }
        );
        if (pick && "id" in pick) {
          store.restoreCheckpoint((pick as { id: string }).id);
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
        if (!picked?.[0]) return;
        await plot.loadComposedFile(picked[0]);
      },
    ],
    ["labwired.openEvidence", async () => focus("labwired.evidence")],
    ["labwired.openPlan", async () => focus("labwired.plan")],
    [
      "labwired.runTwin",
      async () => {
        await focus("labwired.evidence");
        const r = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: "LabWired twin/run…",
          },
          async () => evidence.runTwin("smoke")
        );
        if (r) {
          void vscode.window.showInformationMessage(
            r.ok || r.twin_verified
              ? `Twin OK · ${r.runId}`
              : `Twin failed · ${r.runId || "?"}`
          );
        } else {
          void vscode.window.showWarningMessage("twin/run failed");
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
        if (uris?.[0]) await evidence.loadPath(uris[0].fsPath);
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
        const items = TOOLS.map((t) => ({
          label: t.title,
          description: t.group,
          detail: t.description,
          name: t.name,
        }));
        const pick = await vscode.window.showQuickPick(items, {
          title: `LabWired tools (${TOOLS.length})`,
          matchOnDetail: true,
        });
        if (!pick) return;
        const def = TOOLS.find((t) => t.name === pick.name);
        const params: Record<string, string> = {};
        for (const p of def?.params || []) {
          const v = await vscode.window.showInputBox({
            prompt: p.description,
            value: p.default || "",
            placeHolder: p.name,
          });
          if (v === undefined) return;
          if (v) params[p.name] = v;
        }
        await chat.invokeTool(pick.name, params);
      },
    ],
    [
      "labwired.restartBridge",
      () => {
        const r = bridge.refresh();
        void vscode.window.showInformationMessage(
          r.path ? `CLI: ${r.path}` : "CLI not found"
        );
      },
    ],
    [
      "labwired.replayOnboarding",
      async () => {
        await vscode.commands.executeCommand(
          "workbench.action.openWalkthrough",
          "labwired.labwired-vscode#labwiredGettingStarted",
          true
        );
      },
    ],
    [
      "labwired.showGettingStarted",
      async () => {
        await vscode.commands.executeCommand(
          "workbench.action.openWalkthrough",
          "labwired.labwired-vscode#labwiredGettingStarted",
          false
        );
      },
    ],
    [
      "labwired.openMcpDocs",
      async () => {
        await vscode.env.openExternal(
          vscode.Uri.parse("https://labwired.com/agent.html")
        );
      },
    ],
    [
      "labwired.githubDaemon",
      async () => {
        void vscode.window.showInformationMessage(
          "GitHub daemon: parity with embedder start daemon — ship after labwired --server."
        );
        await vscode.env.openExternal(
          vscode.Uri.parse(
            "https://docs.embedder.com/integrations/github-bot"
          )
        );
      },
    ],
    [
      "labwired.login",
      async () => {
        await billing.loginInteractive();
        const s = await billing.status();
        void vscode.window.setStatusBarMessage(
          s.loggedIn
            ? `LabWired Pro · ${s.projectName || s.projectId || "no project"}`
            : "LabWired Free",
          5000
        );
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
        const pathMod = await import("path");
        const fsMod = await import("fs");
        const candidates = [
          pathMod.join(agentRoot, "server", "github-daemon.mjs"),
          pathMod.join(agentRoot, "..", "..", "server", "github-daemon.mjs"),
          pathMod.join(
            context.extensionPath,
            "server",
            "github-daemon.mjs"
          ),
        ];
        const script = candidates.find((p) => fsMod.existsSync(p));
        if (!script) {
          void vscode.window.showErrorMessage(
            "github-daemon.mjs not found — reinstall extension or agent package"
          );
          return;
        }
        term.sendText(
          `export LABWIRED_GITHUB_REPO="\${LABWIRED_GITHUB_REPO:-}"; echo "Need: GITHUB_TOKEN + LABWIRED_GITHUB_REPO=owner/name"; node "${script}"`
        );
      },
    ],
    [
      "labwired.diffApproveDemo",
      async () => {
        const result = await diffs.proposeEdit({
          title: "LabWired proposed edit",
          pathLabel: "src/main.c",
          before: "void loop() {\n  // TODO\n}\n",
          after:
            "void loop() {\n  digitalWrite(LED_BUILTIN, HIGH);\n  delay(500);\n  digitalWrite(LED_BUILTIN, LOW);\n  delay(500);\n}\n",
        });
        void vscode.window.showInformationMessage(
          `Diff response: ${result || "dismissed"}`
        );
      },
    ],
  ];

  for (const [id, fn] of cmds) {
    context.subscriptions.push(
      vscode.commands.registerCommand(id, fn as (...args: unknown[]) => unknown)
    );
  }

  // Mode change → notify chat + keep server-side gates in sync, so
  // palette-initiated tool runs honor the current plan/verify mode too.
  const pushMode = () => {
    if (!rpc.isRunning()) return;
    void rpc
      .request("mode/set", { mode: session.getMode() })
      .catch(() => {});
  };
  context.subscriptions.push(
    session.onChange(() => {
      chat.refresh();
      pushMode();
    })
  );
  // Session mode may be restored (e.g. plan) while the server boots in act.
  rpc.on("ready", pushMode);

  const cfg = vscode.workspace.getConfiguration("labwired");
  if (cfg.get<boolean>("autoRevealOnStartup")) {
    void vscode.commands.executeCommand("workbench.view.extension.labwired");
  }
  if (cfg.get<boolean>("closeAgentChatOnActivation")) {
    // Best-effort; command ids vary by host
    void (async () => {
      for (const c of [
        "workbench.action.chat.close",
        "workbench.panel.chat.view.copilot.removeView",
      ]) {
        try {
          await vscode.commands.executeCommand(c);
        } catch {
          /* ignore */
        }
      }
    })();
  }

  const cs = catalog.stats();
  const cli = bridge.getCli();
  store.append(
    "system",
    `LabWired workbench v0.6.3 — same start-here as CLI\n` +
      `1. Log in (labwired login) → hosted MCP + model\n` +
      `2. Doctor → Start Agent (Terminal) → LabWired Agent + golden-path\n` +
      `3. Overview: twin display (inspect) · topology · serial · elements\n` +
      `4. “Blink the LED and prove it on the twin.”\n` +
      `• Packs: golden-path · bringup · prove · observe · desk-hw\n` +
      `• Knowledge: MCP labwired_part / labwired_datasheet\n` +
      `• Compose: labwired compose … (elements, not ready-made plots)\n` +
      `• CLI: ${cli.path || "(missing)"} (${cli.source}${cli.version ? ` v${cli.version}` : ""})\n` +
      `• Catalog: ${cs.parts} parts · tools: /tools`
  );
  output.appendLine(
    `LabWired workbench v0.6.3 — tools=${TOOLS.length} catalog=${cs.parts} cli=${cli.path || "missing"}`
  );
  // Surface overview on first activation so visual glass matches LabWired UI
  void overview.pushState();
}

export function deactivate(): void {
  /* noop */
}
