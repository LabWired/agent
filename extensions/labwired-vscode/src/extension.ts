import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
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
import { CircuitViewProvider } from "./providers/circuitProvider";
import { SchematicEditorProvider } from "./providers/schematicEditor";
import { ToolRunner } from "./tools/runner";
import { TOOLS } from "./tools/registry";
import { CatalogService } from "./catalog/service";
import { CatalogViewProvider } from "./providers/catalogProvider";
import { OverviewViewProvider } from "./providers/overviewProvider";
import { AgentSession } from "./agent/session";
import { RpcClient, resolveAgentRoot } from "./cli/rpcClient";
import { DatasheetService } from "./datasheet/agentic";
import { ProbeDebugService } from "./debug/probeGdb";
import { BillingService } from "./pro/billing";
import { mintFromDiagramObject, mintFromFile } from "./board/boardMint";
import {
  buildStarterDiagram,
  loadCatalogBoards,
  type StarterPreset,
} from "./board/catalogBoards";
import {
  importCircuitSource,
  type ImportSourceKind,
} from "./board/multiImport";

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("LabWired");
  const bridge = new LabWiredBridge(output, context.extensionPath);
  // Local digital twin path uses CLI smoke + stdio MCP
  void import("./twin/twinSession").then((m) => m.setTwinBridge(bridge));
  const session = new SessionState(context);
  const store = new ConversationStore(context);
  const diffs = new DiffService(context);
  const catalog = new CatalogService(context.extensionUri);
  const datasheets = new DatasheetService();
  const probeDebug = new ProbeDebugService();
  const billing = new BillingService(context);
  billing.setBridge(bridge);
  const tools = new ToolRunner(
    bridge,
    catalog,
    datasheets,
    probeDebug,
    billing
  );
  const agent = new AgentSession(catalog, tools);
  const agentRoot = resolveAgentRoot(context.extensionPath);
  const rpc = new RpcClient(output, agentRoot);
  bridge.refresh();

  const plot = new PlotViewProvider(context.extensionUri);
  const circuit = new CircuitViewProvider(context.extensionUri);
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
  // Prefer RPC plot stream when server emits plot/data
  rpc.on("notification", (method: string, params: Record<string, unknown>) => {
    if (method === "plot/data") {
      const vals = params.values as number[] | undefined;
      if (vals?.length) {
        for (const v of vals) {
          plot.pushSample(v);
          overview.pushSample(v);
        }
      }
    }
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

  // Optional RPC server — do NOT block activation. Only start if setting enabled.
  const startRpc = vscode.workspace
    .getConfiguration("labwired")
    .get<boolean>("autoStartRpc");
  if (startRpc) {
    const ws =
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
    void rpc.start(ws).then(
      () => {
        output.appendLine("RPC server ready.");
      },
      (e) => {
        output.appendLine(`RPC server failed: ${e}`);
      }
    );
  } else {
    output.appendLine(
      "RPC auto-start off (labwired.autoStartRpc). CLI agent path is primary."
    );
  }

  // Chat-first IA: Agent (sidebar) + Monitor / Plot / Twin circuit (panel).
  // Twin circuit = parts as blocks + wires; develop/run actions on that twin.
  // Plot = composed observability glass (E4). Overview / Evidence remain commands.
  context.subscriptions.push(
    output,
    { dispose: () => serial.dispose() },
    { dispose: () => agent.stop() },
    { dispose: () => void rpc.stop() },
    { dispose: () => probeDebug.dispose() },
    regView(ChatViewProvider.viewType, chat),
    regView(SerialViewProvider.viewType, serial),
    regView(PlotViewProvider.viewType, plot),
    regView(CircuitViewProvider.viewType, circuit),
    vscode.window.registerCustomEditorProvider(
      SchematicEditorProvider.viewType,
      schematic,
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );
  // Keep instances alive for commands (overview editor, twin evidence, history pick)
  void overview;
  void evidence;
  void history;
  void plan;
  void catalogView;

  const focus = async (viewId: string) => {
    await vscode.commands.executeCommand("workbench.view.extension.labwired");
    try {
      await vscode.commands.executeCommand(`${viewId}.focus`);
    } catch {
      /* some hosts ignore */
    }
  };

  const finishMint = async (
    result: import("./board/boardMint").BoardMintResult
  ) => {
    store.append("tool", `✓ board\n${result.summary}`);
    if (result.errors.length) {
      store.append("system", result.errors.map((e) => `⚠ ${e}`).join("\n"));
    }
    if (result.dropped.length) {
      store.append(
        "system",
        `Dropped from twin: ${result.dropped.map((d) => d.type).join(", ")}`
      );
    }
    overview.setEvidence({
      status: result.ok ? "twin_ready" : "empty",
      path: result.diagramPath,
      summary: result.summary,
    });
    circuit.refresh();
    chat.refresh();
    await circuit.reveal();
    await focus("labwired.chat");
    const next = await vscode.window.showInformationMessage(
      result.ok
        ? `Board ready · ${result.board} · ${result.supported.length} parts`
        : `Mint incomplete · ${result.errors[0] || "no supported parts"}`,
      result.ok ? "Start agent" : "OK",
      "Open twin circuit",
      "Open coverage"
    );
    if (next === "Start agent") {
      await bridge.startAgentTerminal(session.getMode());
    } else if (next === "Open twin circuit") {
      await circuit.reveal();
    } else if (next === "Open coverage") {
      const doc = await vscode.workspace.openTextDocument(result.coveragePath);
      await vscode.window.showTextDocument(doc, { preview: true });
    }
  };

  /** Embedder-style: pick board from OUR catalog → mint twin. */
  const runNewBoardFromCatalog = async () => {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) {
      void vscode.window.showErrorMessage(
        "Open a workspace folder first — LabWired writes .labwired/ there."
      );
      return;
    }
    const boards = loadCatalogBoards(context.extensionPath);
    const boardPick = await vscode.window.showQuickPick(
      boards.map((b) => ({
        label: b.id,
        description: b.chip !== b.id ? b.chip : undefined,
        detail: `MCU part ${b.mcuType} · blink pin ${b.ledPin}`,
        board: b,
      })),
      {
        title: "New board — LabWired twin catalog",
        placeHolder: "Pick a board / MCU (product catalog, not a file hunt)",
        matchOnDescription: true,
        matchOnDetail: true,
      }
    );
    if (!boardPick) return;

    const presetPick = await vscode.window.showQuickPick(
      [
        {
          label: "Blink LED starter",
          description: "MCU + LED wired (recommended)",
          preset: "blink" as StarterPreset,
        },
        {
          label: "Bare MCU",
          description: "Board only — no peripherals",
          preset: "bare" as StarterPreset,
        },
      ],
      { title: `Starter for ${boardPick.board.id}` }
    );
    if (!presetPick) return;

    try {
      const diagram = buildStarterDiagram(boardPick.board, presetPick.preset);
      // Persist starter as source for remint
      const lab = path.join(root, ".labwired");
      fs.mkdirSync(lab, { recursive: true });
      const sourcePath = path.join(lab, "source-diagram.json");
      fs.writeFileSync(sourcePath, JSON.stringify(diagram, null, 2) + "\n");
      const result = mintFromDiagramObject(
        diagram,
        root,
        catalog.asMintLookup(),
        `catalog:${boardPick.board.id}`
      );
      await finishMint(result);
    } catch (e) {
      void vscode.window.showErrorMessage(`New board failed: ${e}`);
      store.append("system", `New board failed: ${e}`);
    }
  };

  const runBoardMint = async (sourcePath?: string) => {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) {
      void vscode.window.showErrorMessage(
        "Open a workspace folder to mint a twin from a board diagram."
      );
      return;
    }
    let src = sourcePath;
    if (!src) {
      const pick = await vscode.window.showOpenDialog({
        canSelectMany: false,
        filters: { Diagram: ["json"] },
        title: "Open local diagram.json (advanced)",
        defaultUri: vscode.Uri.file(root),
      });
      if (!pick?.[0]) return;
      src = pick[0].fsPath;
    }
    try {
      try {
        const copyTo = path.join(root, ".labwired", "source-diagram.json");
        fs.mkdirSync(path.dirname(copyTo), { recursive: true });
        if (path.resolve(src) !== path.resolve(copyTo)) {
          fs.copyFileSync(src, copyTo);
        }
      } catch {
        /* ignore */
      }
      const result = mintFromFile(src, root, catalog.asMintLookup());
      await finishMint(result);
    } catch (e) {
      void vscode.window.showErrorMessage(`Board mint failed: ${e}`);
      store.append("system", `Board mint failed: ${e}`);
    }
  };

  const runImportCircuit = async () => {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) {
      void vscode.window.showErrorMessage(
        "Open a workspace folder first — import writes under .labwired/."
      );
      return;
    }

    const sourcePick = await vscode.window.showQuickPick(
      [
        {
          label: "$(file-pdf) PDF schematic",
          description: "Customer board drawing",
          forceKind: "pdf-schematic" as ImportSourceKind,
        },
        {
          label: "$(book) Datasheet PDF",
          description: "Part knowledge for agent",
          forceKind: "pdf-datasheet" as ImportSourceKind,
        },
        {
          label: "$(circuit-board) KiCad schematic",
          description: ".kicad_sch",
          forceKind: "kicad-sch" as ImportSourceKind,
        },
        {
          label: "$(file-binary) Netlist",
          description: ".net / spice-like",
          forceKind: "netlist" as ImportSourceKind,
        },
        {
          label: "$(json) LabWired diagram.json",
          description: "Mint twin directly",
          forceKind: "diagram-json" as ImportSourceKind,
        },
        {
          label: "$(file-media) Image",
          description: "Photo/scan of schematic",
          forceKind: "image" as ImportSourceKind,
        },
        {
          label: "$(table) BOM CSV",
          description: "Parts list",
          forceKind: "bom-csv" as ImportSourceKind,
        },
        {
          label: "$(file-text) Text / notes",
          description: ".txt / .md description",
          forceKind: "text" as ImportSourceKind,
        },
        {
          label: "$(code) Existing firmware / project",
          description: "platformio.ini, main.c/cpp, sdkconfig — on-ramp to twin + FW loop",
          forceKind: "text" as ImportSourceKind,
        },
        {
          label: "$(file) Any file (auto-detect)",
          description: "Guess from extension",
          forceKind: undefined,
        },
      ],
      { title: "On-ramp to twin + firmware loop (source format is incidental)" }
    );
    if (!sourcePick) return;

    const filters: Record<string, string[]> = {
      "pdf-schematic": ["pdf"],
      "pdf-datasheet": ["pdf"],
      "kicad-sch": ["kicad_sch", "kicad_pro", "sch"],
      "kicad-pcb": ["kicad_pcb", "kicad_pro"],
      netlist: ["net", "cir", "sp", "txt"],
      "diagram-json": ["json"],
      image: ["png", "jpg", "jpeg", "webp", "gif", "tif", "tiff"],
      "bom-csv": ["csv", "tsv", "txt"],
      text: ["txt", "md", "log"],
    };
    const fk = sourcePick.forceKind;
    const files = await vscode.window.showOpenDialog({
      canSelectMany: false,
      filters: fk
        ? { Import: filters[fk] || ["*"] }
        : {
            "Circuit sources": [
              "pdf",
              "kicad_sch",
              "kicad_pcb",
              "net",
              "json",
              "png",
              "jpg",
              "csv",
              "txt",
              "md",
            ],
          },
      title: `Import: ${sourcePick.label.replace(/\$\([^)]+\)\s*/, "")}`,
    });
    if (!files?.[0]) return;

    // User context is first-class: board, goals, and (for code) where the FW lives.
    const userContext =
      (await vscode.window.showInputBox({
        title: "User context (optional but recommended)",
        prompt:
          "Board/MCU, goal (blink + prove), sensors, pins, or “this is existing FW for …”",
        placeHolder:
          "e.g. ESP32-C3 SuperMini, GPIO8 LED, existing PlatformIO project — prove on twin",
        ignoreFocusOut: true,
      })) || "";

    const boards = loadCatalogBoards(context.extensionPath);
    let partTypes: string[] = [];
    try {
      const facts = catalog.load();
      partTypes = [
        ...facts.device_types,
        ...facts.parts.map((p) => p.type),
        ...facts.chips,
      ];
    } catch {
      partTypes = ["led", "button", "bme280", "ssd1306", "resistor"];
    }

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "LabWired: importing circuit…",
      },
      async () => {
        const result = importCircuitSource({
          sourcePath: files[0].fsPath,
          workspaceRoot: root,
          boards,
          partTypes,
          lookup: catalog.asMintLookup(),
          forceKind: sourcePick.forceKind,
          autoMintStarter: true,
          starterPreset: "blink",
          userContext,
        });

        if (!result.ok) {
          void vscode.window.showErrorMessage(result.summary);
          store.append("system", result.summary);
          await focus("labwired.chat");
          return;
        }

        store.append("tool", `✓ import (${result.sourceKind})\n${result.summary}`);
        await focus("labwired.chat");

        if (result.sourceKind === "pdf-datasheet") {
          try {
            datasheets.ensureDirs();
            datasheets.extractAll(true);
            store.append("system", "Datasheet extracted for /datasheet tools.");
          } catch (e) {
            store.append("system", `Datasheet extract note: ${e}`);
          }
          void vscode.window.showInformationMessage(
            "Datasheet imported — agent can use datasheet tools."
          );
          return;
        }

        if (result.minted?.ok) {
          await finishMint(result.minted);
          store.append(
            "system",
            "Twin minted. Design context also in .labwired/import/ (DESIGN_CONTEXT.md, AGENT_PROMPT.md)."
          );
          return;
        }

        // Twin optional — design context is still success
        store.append(
          "system",
          "Twin not fully buildable (or not minted). Design context kept for drivers/FW — " +
            ".labwired/import/DESIGN_CONTEXT.md + USER_CONTEXT.md + extracts."
        );

        const next = await vscode.window.showInformationMessage(
          result.suggestedBoardId
            ? `Imported · context ready · suggested ${result.suggestedBoardId}`
            : "Imported · design context ready (twin incomplete)",
          "Start agent (design / twin)",
          "New board…",
          "OK"
        );
        if (next === "Start agent (design / twin)") {
          store.append(
            "system",
            "Starting agent with design context (import-circuit). Drivers OK even without full twin."
          );
          await bridge.sendPromptViaTerminal(
            result.agentPrompt,
            session.getMode()
          );
        } else if (next === "New board…") {
          await runNewBoardFromCatalog();
        }
      }
    );
  };

  const cmds: [string, (...args: never[]) => unknown][] = [
    [
      "labwired.newBoard",
      async () => {
        await runNewBoardFromCatalog();
      },
    ],
    [
      "labwired.importCircuit",
      async () => {
        await runImportCircuit();
      },
    ],
    [
      "labwired.importPdf",
      async () => {
        // Back-compat: same multi-import, default PDF filter via auto
        await runImportCircuit();
      },
    ],
    [
      "labwired.openBoardDiagram",
      async () => {
        await runBoardMint();
      },
    ],
    [
      "labwired.remintTwin",
      async () => {
        const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!root) return;
        const candidates = [
          path.join(root, ".labwired", "source-diagram.json"),
          path.join(root, "diagram.json"),
          path.join(root, ".labwired", "diagram.json"),
        ];
        // Prefer original source recorded in board.json
        try {
          const meta = JSON.parse(
            fs.readFileSync(path.join(root, ".labwired", "board.json"), "utf8")
          ) as { source?: string };
          if (meta.source && fs.existsSync(meta.source)) {
            await runBoardMint(meta.source);
            return;
          }
        } catch {
          /* */
        }
        const hit = candidates.find((c) => fs.existsSync(c));
        if (!hit) {
          void vscode.window.showWarningMessage(
            "No diagram found — use Open board diagram…"
          );
          return;
        }
        await runBoardMint(hit);
      },
    ],
    [
      "labwired.openOverview",
      async () => {
        overview.openInEditor();
      },
    ],
    [
      "labwired.pullTwinDisplay",
      async () => {
        overview.openInEditor();
        const ok = await overview.pullFromTwinInspect();
        if (!ok) await overview.pullFromWorkspaceFiles();
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
    [
      "labwired.viewHistory",
      async () => {
        await vscode.commands.executeCommand(
          "labwired.openConversationFromHistory"
        );
      },
    ],
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
        await plot.reveal();
      },
    ],
    [
      "labwired.openComposedPlot",
      async () => {
        await plot.openComposedFile();
      },
    ],
    [
      "labwired.openTwinCircuit",
      async () => {
        await circuit.reveal();
      },
    ],
    [
      "labwired.openEvidence",
      async () => {
        await vscode.commands.executeCommand("labwired.loadEvidence");
      },
    ],
    [
      "labwired.openPlan",
      async () => {
        const root = vscode.workspace.workspaceFolders?.[0]?.uri;
        if (!root) {
          void vscode.window.showInformationMessage(
            "Open a workspace to use Plan."
          );
          return;
        }
        const planUri = vscode.Uri.joinPath(root, ".labwired", "plan.md");
        try {
          await vscode.workspace.fs.stat(planUri);
        } catch {
          await vscode.workspace.fs.createDirectory(
            vscode.Uri.joinPath(root, ".labwired")
          );
          await vscode.workspace.fs.writeFile(
            planUri,
            Buffer.from("# LabWired plan\n\n", "utf8")
          );
        }
        const doc = await vscode.workspace.openTextDocument(planUri);
        await vscode.window.showTextDocument(doc, { preview: false });
      },
    ],
    [
      "labwired.runTwin",
      async () => {
        await vscode.commands.executeCommand("labwired.runOnTwin");
      },
    ],
    [
      "labwired.runOnTwin",
      async () => {
        await focus("labwired.chat");
        const { runOnTwin, formatTwinResultForChat } = await import(
          "./twin/twinSession"
        );
        const r = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: "LabWired: run on digital twin…",
            cancellable: false,
          },
          () => runOnTwin()
        );
        store.append("tool", formatTwinResultForChat(r));
        if (r.snapshot_id) {
          void overview?.setEvidence?.({
            status: r.ok ? "twin_ran" : "failed",
            summary: r.summary,
          });
        }
        void vscode.window.showInformationMessage(
          r.ok
            ? `Twin run OK · ${r.board || ""}`
            : `Twin run failed — ${r.error || r.summary}`.slice(0, 120)
        );
      },
    ],
    [
      "labwired.proveOnTwin",
      async () => {
        await focus("labwired.chat");
        const { proveOnTwin, formatTwinResultForChat } = await import(
          "./twin/twinSession"
        );
        const r = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: "LabWired: prove on digital twin…",
            cancellable: false,
          },
          () => proveOnTwin()
        );
        store.append("tool", formatTwinResultForChat(r));
        await evidence.showTwinResult({
          ok: r.model_verified,
          suite: "prove",
          twin_verified: r.twin_ran,
          model_verified: r.model_verified,
          summary: r.summary,
        });
        void vscode.window.showInformationMessage(
          r.model_verified
            ? "model_verified — twin prove green"
            : `Prove red — ${r.error || r.summary}`.slice(0, 120)
        );
      },
    ],
    [
      "labwired.debugOnTwin",
      async () => {
        await focus("labwired.chat");
        const { debugOnTwin, formatTwinResultForChat } = await import(
          "./twin/twinSession"
        );
        const r = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: "LabWired: debug on digital twin…",
            cancellable: false,
          },
          () => debugOnTwin()
        );
        store.append("tool", formatTwinResultForChat(r));
        void vscode.window.showInformationMessage(
          r.ok
            ? r.dapStarted
              ? "Twin debug session started (F5 DAP)"
              : "Twin debug probe done (MCP) — install LabWired Debugger for full F5"
            : `Twin debug failed — ${r.error || r.summary}`.slice(0, 120)
        );
      },
    ],
    [
      "labwired.startRtt",
      async () => {
        if (!rpc.isRunning()) {
          void vscode.window.showWarningMessage("labwired server not running");
          return;
        }
        const chip =
          (await vscode.window.showInputBox({
            prompt: "Chip for probe-rs RTT (e.g. STM32F401RETx, nRF52840_xxAA)",
            value:
              vscode.workspace.getConfiguration("labwired").get<string>("defaultChip") ||
              process.env.LABWIRED_CHIP ||
              "",
            placeHolder: "Leave empty for demo stream without probe",
          })) || "";
        const elf =
          (await vscode.window.showInputBox({
            prompt: "ELF path (optional, for RTT control block / defmt)",
            value: process.env.LABWIRED_ELF || "",
          })) || "";
        try {
          const res = (await rpc.request("trace/sessionStart", {
            transport: chip ? "rtt" : "demo",
            chip: chip || undefined,
            elf: elf || undefined,
            demo: !chip,
          })) as {
            sessionId?: string;
            demo?: boolean;
            message?: string;
            chip?: string;
          };
          const ch = vscode.window.createOutputChannel("LabWired RTT");
          ch.show(true);
          ch.appendLine(
            res.demo
              ? `[demo] ${res.message || "RTT demo stream"}`
              : `[rtt] session ${res.sessionId} chip=${res.chip}`
          );
          const onEv = (method: string, params: Record<string, unknown>) => {
            if (method === "trace/eventBatch") {
              const events = params.events as { msg?: string; kind?: string }[];
              for (const e of events || []) {
                ch.appendLine(e.msg || "");
              }
            } else if (method === "trace/streamStatus") {
              ch.appendLine(`[status] ${JSON.stringify(params)}`);
            }
          };
          rpc.on("notification", onEv);
          void vscode.window.showInformationMessage(
            res.demo
              ? `RTT demo started (${res.sessionId}) — attach probe + chip for live`
              : `RTT live: ${res.sessionId}`
          );
        } catch (e) {
          void vscode.window.showErrorMessage(`RTT start failed: ${e}`);
        }
      },
    ],
    [
      "labwired.stopRtt",
      async () => {
        if (!rpc.isRunning()) return;
        try {
          await rpc.request("trace/sessionStop", {});
          void vscode.window.showInformationMessage("RTT/trace session stopped");
        } catch (e) {
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
        const list = (await rpc.request("instrument/list", {})) as {
          drivers?: { id: string; label: string; available?: boolean }[];
        };
        const pick = await vscode.window.showQuickPick(
          (list.drivers || []).map((d) => ({
            label: d.label,
            description: d.id + (d.available === false ? " (not installed)" : ""),
            id: d.id,
          })),
          { title: "Open instrument driver" }
        );
        if (!pick) return;
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
              (await vscode.window.showQuickPick(
                [
                  "generic",
                  "rigol-ds1000z",
                  "siglent-sds",
                  "keysight-dsox",
                  "rigol-dp800",
                  "siglent-spd",
                ],
                { title: "SCPI profile" }
              )) || "generic";
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
          })) as { session?: { id: string; label: string } };
          const id = opened.session?.id;
          if (!id) return;
          const idn = (await rpc.request("instrument/scpi", {
            id,
            command: "*IDN?",
          })) as { response?: string };
          const cap = (await rpc.request("instrument/capture", { id })) as {
            evidencePath?: string;
            runId?: string;
          };
          void vscode.window.showInformationMessage(
            `${opened.session?.label}: ${idn.response || "?"} · evidence ${cap.runId || ""}`
          );
          if (cap.evidencePath) {
            await evidence.loadPath(path.join(cap.evidencePath, "result.json"));
            await focus("labwired.chat");
          }
        } catch (e) {
          void vscode.window.showErrorMessage(String(e));
        }
      },
    ],
    [
      "labwired.loadEvidence",
      async () => {
        const uris = await vscode.window.showOpenDialog({
          canSelectMany: false,
          filters: { JSON: ["json"] },
          title: "Load twin verify JSON",
        });
        if (!uris?.[0]) return;
        await evidence.loadPath(uris[0].fsPath);
        store.append(
          "tool",
          `✓ evidence loaded\n${uris[0].fsPath}`
        );
        await focus("labwired.chat");
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

  // Mode change → notify chat
  context.subscriptions.push(
    session.onChange(() => chat.refresh())
  );

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
  // Empty-state UI is the onboarding; keep first system line short.
  store.clearActive();
  output.appendLine(
    `LabWired v0.7.0 chat-first — Embedder + twin · tools=${TOOLS.length} catalog=${cs.parts} cli=${cli.path || "missing"} flavor=${cli.flavor}`
  );
  void chat.refresh();
}

export function deactivate(): void {
  /* noop */
}
