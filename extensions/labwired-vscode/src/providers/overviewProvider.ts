/**
 * LabWired visual overview — Playground-style glass for the workbench:
 * session, board topology, OLED/display panel, serial strip, element series, evidence.
 */
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import type { LabWiredBridge } from "../cli/bridge";
import { loadCloudSession } from "../cli/cloudSession";
import { inspectSnapshot } from "../cli/hostedMcp";
import type { CatalogService } from "../catalog/service";
import {
  extractDisplayFromRunJson,
  extractSnapshotId,
  findRunJsonCandidates,
  writeDisplayLatest,
  type TwinDisplayFrame,
} from "../display/fromPeripherals";
import { shellHtml } from "../webview/theme";

export type OverviewDisplay = {
  kind: string;
  width: number;
  height: number;
  format?: TwinDisplayFrame["format"];
  /** base64 pixels — mono page, rgb565, or gray */
  pixelBase64?: string;
  /** legacy alias for ssd1306_page */
  monoBase64?: string;
  label?: string;
  metaOnly?: boolean;
  snapshotId?: string;
};

export type OverviewSnapshot = {
  session: {
    signedIn: boolean;
    email?: string;
    projectId?: string;
    apiBase?: string;
    expiresAt?: number;
  };
  cli: { path: string; version?: string; source: string };
  board?: {
    name: string;
    chip: string;
    devices: { id: string; kind: string; bus?: string }[];
    board_io?: { id: string; kind: string; peripheral?: string; pin?: number }[];
  };
  serialTail: string;
  series: Record<string, number[]>;
  evidence?: { status?: string; path?: string; summary?: string };
  display?: OverviewDisplay;
  lastSnapshotId?: string;
  displayStatus?: string;
};

export class OverviewViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "labwired.overview";
  private view?: vscode.WebviewView;
  private editor?: vscode.WebviewPanel;
  private serialTail = "";
  private series: Record<string, number[]> = { uart: [] };
  private evidence?: OverviewSnapshot["evidence"];
  private display?: OverviewDisplay;
  private lastSnapshotId?: string;
  private displayStatus = "";

  constructor(
    private readonly extUri: vscode.Uri,
    private readonly bridge: LabWiredBridge,
    private readonly catalog: CatalogService
  ) {}

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
    webviewView.webview.onDidReceiveMessage((m) => void this.onMessage(m));
  }

  openInEditor(): void {
    if (this.editor) {
      this.editor.reveal(vscode.ViewColumn.Beside);
      void this.pushState();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      "labwired.overview.editor",
      "LabWired Overview",
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    this.editor = panel;
    panel.webview.html = this.html();
    panel.webview.onDidReceiveMessage((m) => void this.onMessage(m));
    panel.onDidDispose(() => {
      if (this.editor === panel) this.editor = undefined;
    });
    void this.pushState();
  }

  /** Feed UART text into overview serial strip + numeric series. */
  ingestSerialText(text: string): void {
    this.serialTail = (this.serialTail + text).slice(-12_000);
    this.ingestNumbers(text, "uart");
    void this.pushState();
  }

  pushSample(n: number, series = "uart"): void {
    const arr = this.series[series] || (this.series[series] = []);
    arr.push(n);
    if (arr.length > 400) this.series[series] = arr.slice(-400);
    void this.pushState();
  }

  setEvidence(ev: OverviewSnapshot["evidence"]): void {
    this.evidence = ev;
    void this.pushState();
  }

  setDisplay(display: OverviewDisplay): void {
    this.display = display;
    void this.pushState();
  }

  /** Apply a twin display frame (from run/inspect peripherals). */
  applyTwinFrame(frame: TwinDisplayFrame, snapshotId?: string): void {
    if (snapshotId) this.lastSnapshotId = snapshotId;
    this.display = {
      kind: frame.kind,
      width: frame.width,
      height: frame.height,
      format: frame.format,
      pixelBase64: frame.pixelBase64 || frame.monoBase64,
      monoBase64: frame.monoBase64 || (frame.format === "ssd1306_page" ? frame.pixelBase64 : undefined),
      label: frame.label,
      metaOnly: frame.metaOnly,
      snapshotId: snapshotId || this.lastSnapshotId,
    };
    this.displayStatus = frame.metaOnly
      ? "Twin display meta only (no pixels in payload)"
      : `Twin display · ${frame.kind} ${frame.width}×${frame.height}`;
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (root && !frame.metaOnly && (frame.pixelBase64 || frame.monoBase64)) {
      try {
        writeDisplayLatest(root, frame, {
          snapshot_id: snapshotId || this.lastSnapshotId,
        });
      } catch {
        /* ignore */
      }
    }
    void this.pushState();
  }

  /** Ingest a full run/inspect/verify JSON (from agent, RPC, or file). */
  ingestRunJson(json: unknown, source = "run"): boolean {
    const snap = extractSnapshotId(json);
    if (snap) this.lastSnapshotId = snap;
    const frame = extractDisplayFromRunJson(json);
    if (frame) {
      this.applyTwinFrame(frame, snap);
      this.displayStatus = `${this.displayStatus} · via ${source}`;
      return true;
    }
    if (snap) {
      this.displayStatus = `snapshot ${snap} (no display bytes in ${source}) — try Pull twin display`;
      void this.pushState();
    }
    return false;
  }

  /** Scan workspace for run/inspect JSON and load the first display frame found. */
  async pullFromWorkspaceFiles(): Promise<boolean> {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) {
      this.displayStatus = "Open a workspace to load twin display JSON";
      await this.pushState();
      return false;
    }
    for (const file of findRunJsonCandidates(root)) {
      try {
        const j = JSON.parse(fs.readFileSync(file, "utf8"));
        if (this.ingestRunJson(j, path.basename(file))) {
          this.displayStatus = `Loaded from ${path.relative(root, file)}`;
          await this.pushState();
          return true;
        }
        const sid = extractSnapshotId(j);
        if (sid) this.lastSnapshotId = sid;
      } catch {
        /* next */
      }
    }
    this.displayStatus = "No display buffer in workspace run JSON";
    await this.pushState();
    return false;
  }

  /** labwired_inspect(snapshot_id) → peripherals → OLED/TFT canvas. */
  async pullFromTwinInspect(snapshotId?: string): Promise<boolean> {
    const id =
      snapshotId ||
      this.lastSnapshotId ||
      (await vscode.window.showInputBox({
        prompt: "snapshot_id from labwired_run",
        value: this.lastSnapshotId || "",
        ignoreFocusOut: true,
      }));
    if (!id) {
      this.displayStatus = "Need snapshot_id from labwired_run";
      await this.pushState();
      return false;
    }
    this.displayStatus = `Inspecting ${id}…`;
    await this.pushState();

    // Prefer full for pixel bytes; fall back to peripherals
    let res = await inspectSnapshot(id, "full");
    if (!res.ok) {
      res = await inspectSnapshot(id, "peripherals");
    }
    if (!res.ok) {
      this.displayStatus = res.error || "inspect failed";
      await this.pushState();
      void vscode.window.showWarningMessage(
        `Twin display: ${res.error || "inspect failed"}`
      );
      return false;
    }
    this.lastSnapshotId = id;
    if (this.ingestRunJson(res.raw, "labwired_inspect")) {
      return true;
    }
    // Sometimes tool wraps text only
    if (res.text) {
      try {
        if (this.ingestRunJson(JSON.parse(res.text), "labwired_inspect")) {
          return true;
        }
      } catch {
        /* */
      }
    }
    this.displayStatus = `Inspect ok but no display artifact on ${id}`;
    await this.pushState();
    return false;
  }

  /** Demo OLED frame matching Playground-style monochrome panel. */
  showDemoDisplay(): void {
    const w = 128;
    const h = 64;
    const buf = new Uint8Array((w * h) / 8);
    // Draw simple LabWired banner + blinky LED corner (page-packed SSD1306 style)
    const set = (x: number, y: number) => {
      if (x < 0 || y < 0 || x >= w || y >= h) return;
      const page = y >> 3;
      const bit = y & 7;
      buf[page * w + x] |= 1 << bit;
    };
    const text = (s: string, ox: number, oy: number) => {
      // 5x7 font via simple rectangles for letters we care about
      const glyphs: Record<string, number[]> = {
        L: [0x7f, 0x40, 0x40, 0x40, 0x40],
        a: [0x20, 0x54, 0x54, 0x54, 0x78],
        b: [0x7f, 0x48, 0x44, 0x44, 0x38],
        W: [0x3f, 0x40, 0x38, 0x40, 0x3f],
        i: [0x00, 0x44, 0x7d, 0x40, 0x00],
        r: [0x7c, 0x08, 0x04, 0x04, 0x08],
        e: [0x38, 0x54, 0x54, 0x54, 0x18],
        d: [0x38, 0x44, 0x44, 0x48, 0x7f],
        " ": [0, 0, 0, 0, 0],
        "→": [0x10, 0x10, 0x7c, 0x38, 0x10],
        "✓": [0x08, 0x10, 0x20, 0x10, 0x08],
        o: [0x38, 0x44, 0x44, 0x44, 0x38],
        v: [0x1c, 0x20, 0x40, 0x20, 0x1c],
        w: [0x3c, 0x40, 0x30, 0x40, 0x3c],
        n: [0x7c, 0x08, 0x04, 0x04, 0x78],
        g: [0x08, 0x54, 0x54, 0x54, 0x3c],
        p: [0x7c, 0x14, 0x14, 0x14, 0x08],
        t: [0x04, 0x3f, 0x44, 0x40, 0x20],
        h: [0x7f, 0x08, 0x04, 0x04, 0x78],
        s: [0x48, 0x54, 0x54, 0x54, 0x24],
        u: [0x3c, 0x40, 0x40, 0x20, 0x7c],
        m: [0x7c, 0x04, 0x18, 0x04, 0x78],
        c: [0x38, 0x44, 0x44, 0x44, 0x28],
        k: [0x7f, 0x10, 0x28, 0x44, 0x00],
        y: [0x0c, 0x50, 0x50, 0x50, 0x3c],
        "!": [0x00, 0x00, 0x5f, 0x00, 0x00],
        ".": [0x00, 0x60, 0x60, 0x00, 0x00],
      };
      let x = ox;
      for (const ch of s) {
        const g = glyphs[ch] || glyphs[ch.toLowerCase()] || glyphs[" "];
        for (let col = 0; col < 5; col++) {
          const bits = g[col] || 0;
          for (let row = 0; row < 7; row++) {
            if (bits & (1 << row)) set(x + col, oy + row);
          }
        }
        x += 6;
      }
    };
    // border
    for (let x = 0; x < w; x++) {
      set(x, 0);
      set(x, h - 1);
    }
    for (let y = 0; y < h; y++) {
      set(0, y);
      set(w - 1, y);
    }
    text("LabWired", 8, 8);
    text("overview", 8, 22);
    text("twin ok", 8, 40);
    // LED blob top-right
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        if (dx * dx + dy * dy <= 16) set(w - 14 + dx, 14 + dy);
      }
    }
    const b64 = Buffer.from(buf).toString("base64");
    this.display = {
      kind: "ssd1306",
      width: w,
      height: h,
      format: "ssd1306_page",
      monoBase64: b64,
      pixelBase64: b64,
      label: "Demo OLED (SSD1306-style) — same glass as Playground display",
    };
    this.displayStatus = "Demo frame (not twin)";
    void this.pushState();
  }

  private ingestNumbers(text: string, series: string) {
    const arr = this.series[series] || (this.series[series] = []);
    const re = /(?:^|[\s,;=:])(-?\d+(?:\.\d+)?)(?=$|[\s,;])/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const n = Number(m[1]);
      if (!Number.isNaN(n) && Number.isFinite(n)) arr.push(n);
    }
    if (arr.length > 400) this.series[series] = arr.slice(-400);
  }

  private loadBoardFromWorkspace(): OverviewSnapshot["board"] {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) {
      return {
        name: "LabWired",
        chip: "select board",
        devices: [
          { id: "mcu", kind: "mcu", bus: "core" },
          { id: "led", kind: "led", bus: "gpio" },
          { id: "uart", kind: "uart", bus: "serial" },
        ],
      };
    }
    const candidates = [
      path.join(root, "diagram.json"),
      path.join(root, ".labwired", "diagram.json"),
      path.join(root, ".labwired", "lab.yaml"),
    ];
    for (const c of candidates) {
      if (!fs.existsSync(c)) continue;
      try {
        if (c.endsWith(".json")) {
          const j = JSON.parse(fs.readFileSync(c, "utf8")) as {
            board?: string;
            parts?: { id: string; type: string }[];
            name?: string;
          };
          return {
            name: j.name || j.board || path.basename(root),
            chip: j.board || "mcu",
            devices: (j.parts || []).map((p) => ({
              id: p.id,
              kind: p.type,
              bus: p.type.includes("oled") || p.type.includes("ssd")
                ? "display"
                : p.type.includes("uart")
                  ? "serial"
                  : "gpio",
            })),
          };
        }
      } catch {
        /* try next */
      }
    }
    // Fallback: hero catalog
    const hit = this.catalog.search("esp32", 1)[0];
    return {
      name: path.basename(root),
      chip: hit?.id || "firmware project",
      devices: [
        { id: "mcu", kind: "mcu" },
        { id: "led", kind: "led", bus: "gpio" },
        { id: "serial", kind: "uart", bus: "serial" },
      ],
    };
  }

  private snapshot(): OverviewSnapshot {
    const cloud = loadCloudSession();
    const cli = this.bridge.getCli();
    return {
      session: {
        signedIn: !!cloud,
        email: cloud?.email,
        projectId: cloud?.projectId,
        apiBase: cloud?.apiBase,
        expiresAt: cloud?.expiresAt,
      },
      cli: {
        path: cli.path || "",
        version: cli.version,
        source: cli.source,
      },
      board: this.loadBoardFromWorkspace(),
      serialTail: this.serialTail,
      series: this.series,
      evidence: this.evidence,
      display: this.display,
      lastSnapshotId: this.lastSnapshotId,
      displayStatus: this.displayStatus,
    };
  }

  private post(target: vscode.Webview | undefined, msg: unknown) {
    void target?.postMessage(msg);
  }

  async pushState(): Promise<void> {
    const snap = this.snapshot();
    this.post(this.view?.webview, { type: "state", state: snap });
    this.post(this.editor?.webview, { type: "state", state: snap });
  }

  private async onMessage(msg: {
    type: string;
    path?: string;
    status?: string;
    snapshotId?: string;
  }) {
    if (msg.type === "ready" || msg.type === "refresh") {
      // Prefer real twin buffer from workspace, else demo glass
      const loaded = await this.pullFromWorkspaceFiles();
      if (!loaded && !this.display) this.showDemoDisplay();
      await this.pushState();
      return;
    }
    if (msg.type === "pullTwinDisplay") {
      const ok = await this.pullFromTwinInspect(msg.snapshotId);
      if (!ok) {
        // try local files as fallback
        await this.pullFromWorkspaceFiles();
      }
      return;
    }
    if (msg.type === "pullWorkspaceDisplay") {
      await this.pullFromWorkspaceFiles();
      return;
    }
    if (msg.type === "startAgent") {
      await vscode.commands.executeCommand("labwired.startAgent");
      return;
    }
    if (msg.type === "doctor") {
      await vscode.commands.executeCommand("labwired.doctor");
      return;
    }
    if (msg.type === "login") {
      await vscode.commands.executeCommand("labwired.login");
      return;
    }
    if (msg.type === "openPlayground") {
      await vscode.env.openExternal(
        vscode.Uri.parse("https://app.labwired.com")
      );
      return;
    }
    if (msg.type === "demoDisplay") {
      this.showDemoDisplay();
      return;
    }
    if (msg.type === "loadEvidence") {
      const uris = await vscode.window.showOpenDialog({
        canSelectMany: false,
        filters: { JSON: ["json"] },
      });
      if (!uris?.[0]) return;
      try {
        const j = JSON.parse(fs.readFileSync(uris[0].fsPath, "utf8")) as {
          status?: string;
          summary?: string;
        };
        this.setEvidence({
          status: j.status || "loaded",
          path: uris[0].fsPath,
          summary: j.summary || JSON.stringify(j).slice(0, 200),
        });
        this.ingestRunJson(j, path.basename(uris[0].fsPath));
        await vscode.commands.executeCommand("labwired.loadEvidence");
      } catch (e) {
        void vscode.window.showErrorMessage(String(e));
      }
      return;
    }
    if (msg.type === "loadRunJson") {
      const uris = await vscode.window.showOpenDialog({
        canSelectMany: false,
        filters: { JSON: ["json"] },
      });
      if (!uris?.[0]) return;
      try {
        const j = JSON.parse(fs.readFileSync(uris[0].fsPath, "utf8"));
        if (!this.ingestRunJson(j, path.basename(uris[0].fsPath))) {
          void vscode.window.showWarningMessage(
            "No display buffer in that JSON (need peripherals[].artifacts[].bytes)"
          );
        }
      } catch (e) {
        void vscode.window.showErrorMessage(String(e));
      }
      return;
    }
    if (msg.type === "loadCompose") {
      const uris = await vscode.window.showOpenDialog({
        canSelectMany: false,
        filters: { JSON: ["json"] },
      });
      if (!uris?.[0]) return;
      try {
        const j = JSON.parse(fs.readFileSync(uris[0].fsPath, "utf8")) as {
          series?: Record<string, number[]>;
          elements?: unknown;
          display?: OverviewDisplay;
        };
        if (j.series) this.series = { ...this.series, ...j.series };
        if (j.display) this.display = j.display;
        this.ingestRunJson(j, "compose");
        const any = j as Record<string, unknown>;
        for (const [k, v] of Object.entries(any)) {
          if (Array.isArray(v) && v.every((x) => typeof x === "number")) {
            this.series[k] = v as number[];
          }
        }
        await this.pushState();
      } catch (e) {
        void vscode.window.showErrorMessage(String(e));
      }
    }
  }

  private html(): string {
    const nonce = getNonce();
    return shellHtml({
      nonce,
      title: "Overview",
      body: `
<div class="app overview-app">
  <div class="header">
    <h1>Overview</h1>
    <span class="badge brand" id="sessBadge">…</span>
    <span class="grow"></span>
    <button class="ghost" id="refresh" type="button">Refresh</button>
  </div>
  <div class="status-strip muted xs" id="statusLine">Playground-style glass · twin · display · serial · elements</div>
  <div class="scroll overview-body">
    <div class="ov-grid">
      <div class="ov-card">
        <div class="ov-card-h">Session</div>
        <div id="sessDetail" class="mono xs"></div>
        <div class="ov-actions">
          <button class="primary" id="login" type="button">Log in</button>
          <button class="ghost" id="doctor" type="button">Doctor</button>
          <button class="ghost" id="agent" type="button">Start Agent</button>
        </div>
      </div>
      <div class="ov-card">
        <div class="ov-card-h">Evidence</div>
        <div id="evBadge" class="ov-ev">no evidence yet</div>
        <div id="evDetail" class="muted xs"></div>
        <div class="ov-actions">
          <button class="ghost" id="loadEv" type="button">Load verify JSON…</button>
        </div>
      </div>
    </div>

    <div class="ov-card full">
      <div class="ov-card-h">Board topology</div>
      <svg id="topo" viewBox="0 0 640 180" class="ov-topo" aria-label="board topology"></svg>
      <div id="boardMeta" class="muted xs"></div>
    </div>

    <div class="ov-grid">
      <div class="ov-card">
        <div class="ov-card-h">Display <span class="muted" id="dispLabel"></span></div>
        <div class="muted xs" id="dispStatus"></div>
        <div class="ov-oled-wrap">
          <canvas id="oled" width="256" height="128" class="ov-oled"></canvas>
        </div>
        <div class="ov-actions">
          <button class="primary" id="pullTwin" type="button">Pull twin display</button>
          <button class="ghost" id="pullWs" type="button">From workspace</button>
          <button class="ghost" id="loadRun" type="button">Load run JSON…</button>
          <button class="ghost" id="demoDisp" type="button">Demo OLED</button>
          <button class="ghost" id="playground" type="button">Open Playground UI</button>
        </div>
      </div>
      <div class="ov-card">
        <div class="ov-card-h">Elements / series</div>
        <canvas id="spark" width="320" height="120" class="ov-spark"></canvas>
        <div class="ov-actions">
          <button class="ghost" id="loadCompose" type="button">Load compose JSON…</button>
        </div>
      </div>
    </div>

    <div class="ov-card full">
      <div class="ov-card-h">Serial</div>
      <pre id="serial" class="ov-serial mono"></pre>
    </div>
  </div>
</div>
<style nonce="${nonce}">
.overview-app { overflow: hidden; }
.overview-body { padding: 8px; display: flex; flex-direction: column; gap: 8px; }
.ov-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
@media (max-width: 520px) { .ov-grid { grid-template-columns: 1fr; } }
.ov-card {
  background: var(--bg-element);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}
.ov-card.full { width: 100%; }
.ov-card-h { font-size: var(--font-size-xs); font-weight: 600; text-transform: uppercase; letter-spacing: .04em; color: var(--text-muted); }
.ov-actions { display: flex; flex-wrap: wrap; gap: 6px; }
.ov-topo { width: 100%; height: 160px; background: #0b1220; border-radius: 6px; border: 1px solid var(--border); }
.ov-oled-wrap {
  background: #050505;
  border-radius: 8px;
  padding: 10px;
  display: flex;
  justify-content: center;
  border: 1px solid #1a1a1a;
  box-shadow: inset 0 0 24px rgba(0,120,255,.08);
}
.ov-oled {
  image-rendering: pixelated;
  width: 100%;
  max-width: 320px;
  height: auto;
  background: #000;
  border: 2px solid #1e293b;
  border-radius: 4px;
}
.ov-spark { width: 100%; height: 120px; background: #0b1220; border-radius: 6px; border: 1px solid var(--border); }
.ov-serial {
  max-height: 160px;
  overflow: auto;
  background: #0a0a0a;
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 8px;
  font-size: 11px;
  line-height: 1.35;
  white-space: pre-wrap;
  margin: 0;
}
.ov-ev { font-weight: 600; }
.ov-ev.ok { color: var(--success); }
.ov-ev.bad { color: var(--error); }
.ov-ev.warn { color: var(--warning); }
.mono { font-family: var(--vscode-editor-font-family, ui-monospace, Menlo, monospace); }
.xs { font-size: var(--font-size-xs); }
.node-mcu { fill: #0e639c; }
.node-led { fill: #e11d48; }
.node-display { fill: #22c55e; }
.node-uart, .node-serial { fill: #a855f7; }
.node-default { fill: #64748b; }
</style>`,
      script: `
const $ = (id) => document.getElementById(id);
$('refresh').onclick = () => vscode.postMessage({ type: 'refresh' });
$('login').onclick = () => vscode.postMessage({ type: 'login' });
$('doctor').onclick = () => vscode.postMessage({ type: 'doctor' });
$('agent').onclick = () => vscode.postMessage({ type: 'startAgent' });
$('loadEv').onclick = () => vscode.postMessage({ type: 'loadEvidence' });
$('demoDisp').onclick = () => vscode.postMessage({ type: 'demoDisplay' });
$('playground').onclick = () => vscode.postMessage({ type: 'openPlayground' });
$('loadCompose').onclick = () => vscode.postMessage({ type: 'loadCompose' });
$('pullTwin').onclick = () => vscode.postMessage({ type: 'pullTwinDisplay' });
$('pullWs').onclick = () => vscode.postMessage({ type: 'pullWorkspaceDisplay' });
$('loadRun').onclick = () => vscode.postMessage({ type: 'loadRunJson' });

function drawDisplay(d) {
  const canvas = $('oled');
  const ctx = canvas.getContext('2d');
  const w = d?.width || 128, h = d?.height || 64;
  const scale = Math.max(1, Math.min(3, Math.floor(320 / w)));
  canvas.width = w * scale; canvas.height = h * scale;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const b64 = d?.pixelBase64 || d?.monoBase64;
  if (!b64) {
    ctx.fillStyle = '#0f172a';
    ctx.fillRect(0,0,canvas.width,canvas.height);
    ctx.fillStyle = '#38bdf8';
    ctx.font = '12px monospace';
    ctx.fillText(d?.metaOnly ? 'Meta only (no pixels)' : 'No display buffer', 12, 36);
    ctx.fillStyle = '#64748b';
    ctx.fillText('Pull twin display / run JSON / Demo', 12, 54);
    $('dispLabel').textContent = d?.label || '';
    return;
  }
  const raw = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  const img = ctx.createImageData(w, h);
  const fmt = d.format || (d.monoBase64 ? 'ssd1306_page' : 'unknown');
  if (fmt === 'ssd1306_page' || (!d.format && raw.length === (w*h)/8)) {
    const pages = Math.ceil(h / 8);
    for (let page = 0; page < pages; page++) {
      for (let x = 0; x < w; x++) {
        const byte = raw[page * w + x] || 0;
        for (let bit = 0; bit < 8; bit++) {
          const y = page * 8 + bit;
          if (y >= h) continue;
          const on = (byte >> bit) & 1;
          const i = (y * w + x) * 4;
          img.data[i] = on ? 180 : 0;
          img.data[i+1] = on ? 220 : 0;
          img.data[i+2] = on ? 255 : 8;
          img.data[i+3] = 255;
        }
      }
    }
  } else if (fmt === 'rgb565_be' || fmt === 'rgb565_le' || raw.length >= w*h*2) {
    const le = fmt === 'rgb565_le';
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const o = (y * w + x) * 2;
        const v = le ? (raw[o] | (raw[o+1] << 8)) : ((raw[o] << 8) | raw[o+1]);
        const r = ((v >> 11) & 0x1f) * 255 / 31;
        const g = ((v >> 5) & 0x3f) * 255 / 63;
        const b = (v & 0x1f) * 255 / 31;
        const i = (y * w + x) * 4;
        img.data[i] = r; img.data[i+1] = g; img.data[i+2] = b; img.data[i+3] = 255;
      }
    }
  } else if (fmt === 'raw_gray' || raw.length >= w*h) {
    for (let i = 0; i < w*h; i++) {
      const g = raw[i] || 0;
      const p = i * 4;
      img.data[p] = g; img.data[p+1] = g; img.data[p+2] = g; img.data[p+3] = 255;
    }
  } else {
    // best-effort mono page
    const pages = Math.ceil(h / 8);
    for (let page = 0; page < pages; page++) {
      for (let x = 0; x < w; x++) {
        const byte = raw[page * w + x] || 0;
        for (let bit = 0; bit < 8; bit++) {
          const y = page * 8 + bit;
          if (y >= h) continue;
          const on = (byte >> bit) & 1;
          const i = (y * w + x) * 4;
          img.data[i] = on ? 200 : 0;
          img.data[i+1] = on ? 220 : 0;
          img.data[i+2] = on ? 255 : 8;
          img.data[i+3] = 255;
        }
      }
    }
  }
  const off = document.createElement('canvas');
  off.width = w; off.height = h;
  off.getContext('2d').putImageData(img, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(off, 0, 0, canvas.width, canvas.height);
  $('dispLabel').textContent = d.label || (d.kind + ' ' + w + '×' + h + ' · ' + fmt);
}

function drawSpark(series) {
  const canvas = $('spark');
  const ctx = canvas.getContext('2d');
  const W = canvas.width = canvas.clientWidth || 320;
  const H = canvas.height = 120;
  ctx.fillStyle = '#0b1220';
  ctx.fillRect(0,0,W,H);
  const colors = ['#38bdf8','#22c55e','#f59e0b','#e879f9','#f43f5e'];
  let ci = 0;
  const keys = Object.keys(series || {});
  if (!keys.length) {
    ctx.fillStyle = '#64748b';
    ctx.font = '12px sans-serif';
    ctx.fillText('No element series yet — serial numbers or compose JSON', 12, 60);
    return;
  }
  keys.forEach((k) => {
    const data = series[k] || [];
    if (data.length < 2) return;
    const min = Math.min(...data), max = Math.max(...data);
    const range = max - min || 1;
    ctx.beginPath();
    ctx.strokeStyle = colors[ci++ % colors.length];
    ctx.lineWidth = 1.5;
    data.forEach((v, i) => {
      const x = (i / (data.length - 1)) * (W - 8) + 4;
      const y = H - 8 - ((v - min) / range) * (H - 20);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();
    ctx.fillStyle = ctx.strokeStyle;
    ctx.font = '10px sans-serif';
    ctx.fillText(k + ' (' + data.length + ')', 8, 12 + (ci-1) * 12);
  });
}

function drawTopo(board) {
  const svg = $('topo');
  while (svg.firstChild) svg.removeChild(svg.firstChild);
  const name = board?.name || 'board';
  const chip = board?.chip || 'mcu';
  $('boardMeta').textContent = name + ' · ' + chip;
  const ns = 'http://www.w3.org/2000/svg';
  const el = (tag, attrs) => {
    const n = document.createElementNS(ns, tag);
    for (const [k,v] of Object.entries(attrs || {})) n.setAttribute(k, String(v));
    return n;
  };
  // MCU center
  svg.appendChild(el('rect', { x: 250, y: 55, width: 140, height: 70, rx: 10, class: 'node-mcu' }));
  const t = el('text', { x: 320, y: 90, fill: '#fff', 'text-anchor': 'middle', 'font-size': 13, 'font-family': 'sans-serif' });
  t.textContent = chip.length > 16 ? chip.slice(0,16)+'…' : chip;
  svg.appendChild(t);
  const devices = (board?.devices || []).filter(d => d.kind !== 'mcu').slice(0, 8);
  devices.forEach((d, i) => {
    const left = i % 2 === 0;
    const row = Math.floor(i / 2);
    const x = left ? 40 : 480;
    const y = 30 + row * 50;
    const kind = (d.kind || 'default').toLowerCase();
    let cls = 'node-default';
    if (kind.includes('led')) cls = 'node-led';
    else if (kind.includes('oled') || kind.includes('ssd') || kind.includes('display') || kind.includes('lcd') || kind.includes('tft')) cls = 'node-display';
    else if (kind.includes('uart') || kind.includes('serial')) cls = 'node-uart';
    svg.appendChild(el('line', { x1: left ? 120 : 480, y1: y+18, x2: left ? 250 : 390, y2: 90, stroke: '#334155', 'stroke-width': 2 }));
    svg.appendChild(el('rect', { x, y, width: 100, height: 36, rx: 8, class: cls }));
    const label = el('text', { x: x+50, y: y+22, fill: '#fff', 'text-anchor': 'middle', 'font-size': 11, 'font-family': 'sans-serif' });
    label.textContent = (d.id || d.kind || '?').slice(0, 12);
    svg.appendChild(label);
  });
  if (!devices.length) {
    const hint = el('text', { x: 320, y: 160, fill: '#64748b', 'text-anchor': 'middle', 'font-size': 11 });
    hint.textContent = 'Add diagram.json or use catalog · same topology idea as LabWired UI';
    svg.appendChild(hint);
  }
}

window.addEventListener('message', (e) => {
  const m = e.data;
  if (m?.type !== 'state') return;
  const s = m.state || {};
  const sess = s.session || {};
  const badge = $('sessBadge');
  badge.textContent = sess.signedIn ? ('hosted · ' + (sess.email || 'ok')) : 'local';
  badge.className = 'badge ' + (sess.signedIn ? 'brand' : '');
  $('sessDetail').textContent = [
    sess.signedIn ? 'signed in' : 'not signed in',
    sess.projectId ? 'project ' + sess.projectId : '',
    s.cli?.version ? 'cli v' + s.cli.version : '',
    s.cli?.source || '',
    sess.apiBase || '',
  ].filter(Boolean).join('\\n');
  $('statusLine').textContent = sess.signedIn
    ? 'Hosted MCP + model · packs golden-path · same tools as Playground'
    : 'Local tools · Log in for hosted MCP + model gateway';
  const ev = s.evidence;
  const eb = $('evBadge');
  if (!ev) {
    eb.textContent = 'no evidence yet';
    eb.className = 'ov-ev warn';
    $('evDetail').textContent = 'Prove path → model_verified only after labwired_verify';
  } else {
    const st = String(ev.status || '');
    const ok = /model_verified|twin_verified|pass|ok/i.test(st);
    eb.textContent = st;
    eb.className = 'ov-ev ' + (ok ? 'ok' : 'bad');
    $('evDetail').textContent = [ev.path, ev.summary].filter(Boolean).join(' · ');
  }
  drawTopo(s.board);
  drawDisplay(s.display);
  drawSpark(s.series || {});
  $('serial').textContent = s.serialTail || '(serial idle — open Monitor or run agent)';
  const ds = $('dispStatus');
  if (ds) {
    ds.textContent = [s.displayStatus, s.lastSnapshotId ? ('snapshot ' + s.lastSnapshotId) : ''].filter(Boolean).join(' · ');
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
  for (let i = 0; i < 32; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}
