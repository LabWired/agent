import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import type { LabWiredBridge } from "../cli/bridge";
import type { RpcClient } from "../cli/rpcClient";
import type { OverviewViewProvider } from "./overviewProvider";
import { shellHtml } from "../webview/theme";

type TwinResult = {
  runId?: string;
  ok?: boolean;
  suite?: string;
  twin_verified?: boolean;
  model_verified?: boolean;
  summary?: string;
  evidencePath?: string;
  durationMs?: number;
  code?: number | null;
};

/**
 * Evidence panel — loads twin/verify JSON + runs twin/run via RPC.
 */
export class EvidenceViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "labwired.evidence";
  private view?: vscode.WebviewView;
  private currentPath?: string;
  private currentJson?: unknown;
  private lastTwin?: TwinResult;

  private overview?: OverviewViewProvider;

  constructor(
    private readonly extUri: vscode.Uri,
    private readonly bridge: LabWiredBridge,
    private readonly rpc?: RpcClient
  ) {
    rpc?.on("notification", (method: string, params: Record<string, unknown>) => {
      if (method === "chat/toolResult" && params.toolName === "twin/run") {
        const r = params.result as { success?: boolean; summary?: string; runId?: string };
        void this.refreshFromRpc(r?.runId);
      }
    });
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

  setOverview(overview: OverviewViewProvider | undefined) {
    this.overview = overview;
  }

  /** Called after twin/run from chat or command palette. */
  async showTwinResult(result: TwinResult): Promise<void> {
    this.lastTwin = result;
    this.overview?.setEvidence({
      status:
        result.model_verified || result.twin_verified || result.ok
          ? result.model_verified
            ? "model_verified"
            : "twin_verified"
          : "failed",
      path: result.evidencePath,
      summary: result.summary,
    });
    if (result.evidencePath) {
      const resultJson = path.join(result.evidencePath, "result.json");
      if (fs.existsSync(resultJson)) {
        await this.loadPath(resultJson);
        return;
      }
    }
    // Synthetic evidence view from RPC payload
    this.currentPath = result.evidencePath || `(run ${result.runId || "?"})`;
    this.currentJson = {
      status: result.ok || result.twin_verified ? "twin_verified" : "failed",
      proven: !!(result.ok || result.twin_verified),
      model_verified: false,
      twin_verified: !!(result.ok || result.twin_verified),
      board: result.suite || "twin",
      oracle_results: [
        {
          clause: "twin/run",
          passed: !!(result.ok || result.twin_verified),
          detail: `code=${result.code} durationMs=${result.durationMs ?? "?"}`,
        },
      ],
      gaps: result.ok ? [] : ["twin_failed"],
      summary: result.summary || "",
      runId: result.runId,
      evidencePath: result.evidencePath,
    };
    this.pushEvidence();
  }

  async runTwin(suite = "smoke"): Promise<TwinResult | null> {
    if (!this.rpc?.isRunning()) {
      // Fallback: CLI smoke via bridge
      await this.bridge.ensureCli();
      const r = await this.bridge.run(["smoke"], { timeoutMs: 120_000 });
      const synth: TwinResult = {
        runId: `local_${Date.now().toString(36)}`,
        ok: r.code === 0,
        suite,
        twin_verified: r.code === 0,
        model_verified: false,
        summary: (r.stdout || r.stderr || "").slice(0, 4000),
        code: r.code,
      };
      await this.showTwinResult(synth);
      return synth;
    }
    this.post({ type: "status", text: `Running twin/${suite}…` });
    try {
      const result = (await this.rpc.request("twin/run", {
        suite,
      })) as TwinResult;
      await this.showTwinResult(result);
      return result;
    } catch (e) {
      this.post({ type: "error", text: `twin/run failed: ${String(e)}` });
      return null;
    }
  }

  async refreshFromRpc(runId?: string): Promise<void> {
    if (!this.rpc?.isRunning()) return;
    try {
      const ev = (await this.rpc.request("twin/evidence", {
        runId: runId || this.lastTwin?.runId,
      })) as { last?: TwinResult & { evidencePath?: string } };
      if (ev.last) await this.showTwinResult(ev.last);
    } catch {
      /* */
    }
  }

  async loadPath(file: string): Promise<void> {
    try {
      this.currentPath = file;
      const raw = fs.readFileSync(file, "utf8");
      this.currentJson = JSON.parse(raw);
      this.pushEvidence();
      this.syncOverviewFromJson(file, this.currentJson);
    } catch (e) {
      // try bridge helper
      try {
        this.currentPath = file;
        this.currentJson = this.bridge.readJsonFile(file);
        this.pushEvidence();
        this.syncOverviewFromJson(file, this.currentJson);
      } catch (e2) {
        this.post({
          type: "error",
          text: `Failed to load ${file}: ${String(e2 || e)}`,
        });
      }
    }
  }

  private syncOverviewFromJson(file: string, json: unknown) {
    const j = (json || {}) as {
      status?: string;
      summary?: string;
      model_verified?: boolean;
      twin_verified?: boolean;
    };
    const status =
      j.status ||
      (j.model_verified
        ? "model_verified"
        : j.twin_verified
          ? "twin_verified"
          : "loaded");
    this.overview?.setEvidence({
      status,
      path: file,
      summary: j.summary,
    });
    // If verify/run JSON carries peripherals with display artifacts, paint them
    this.overview?.ingestRunJson(json, path.basename(file));
  }

  private async onMessage(msg: { type: string; [k: string]: unknown }) {
    switch (msg.type) {
      case "ready": {
        // Prefer latest twin evidence from RPC
        if (this.rpc?.isRunning()) {
          try {
            const ev = (await this.rpc.request("twin/evidence", {})) as {
              last?: TwinResult;
              runs?: string[];
            };
            if (ev.last) {
              await this.showTwinResult(ev.last);
              break;
            }
          } catch {
            /* */
          }
        }
        const hints = this.bridge.findDefaultEvidenceHints();
        if (hints[0]) await this.loadPath(hints[0]);
        else {
          // Scan .labwired/evidence
          const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
          if (ws) {
            const root = path.join(ws, ".labwired", "evidence");
            if (fs.existsSync(root)) {
              const dirs = fs
                .readdirSync(root)
                .map((d) => path.join(root, d, "result.json"))
                .filter((p) => fs.existsSync(p))
                .sort()
                .reverse();
              if (dirs[0]) {
                await this.loadPath(dirs[0]);
                break;
              }
            }
          }
          this.post({ type: "empty" });
        }
        break;
      }
      case "pick": {
        const uris = await vscode.window.showOpenDialog({
          canSelectMany: false,
          filters: { JSON: ["json"] },
          title: "Open LabWired verify / twin JSON",
        });
        if (uris?.[0]) await this.loadPath(uris[0].fsPath);
        break;
      }
      case "demo": {
        const demo = this.bridge.demoEvidencePath();
        if (demo) await this.loadPath(demo);
        else {
          this.post({
            type: "error",
            text: "Demo fixture not found — run twin first (Run twin button).",
          });
        }
        break;
      }
      case "runTwin": {
        await this.runTwin(String(msg.suite || "smoke"));
        break;
      }
      case "refresh": {
        await this.refreshFromRpc();
        break;
      }
      case "score": {
        if (!this.currentPath || this.currentPath.startsWith("(")) {
          this.post({
            type: "error",
            text: "Load a verify JSON file first (or run twin).",
          });
          return;
        }
        await this.bridge.ensureCli();
        const r = await this.bridge.scoreVerify(this.currentPath);
        this.post({
          type: "score",
          text: (r.stdout || r.stderr || "").trim(),
          code: r.code,
        });
        break;
      }
      case "assert": {
        if (!this.currentPath || this.currentPath.startsWith("(")) return;
        const expected = String(msg.expected || "model_verified");
        await this.bridge.ensureCli();
        const r = await this.bridge.assertStatus(expected, this.currentPath);
        this.post({
          type: "score",
          text: `$ labwired assert-status ${expected}\nexit ${r.code}\n${(r.stdout || r.stderr || "").trim()}`,
          code: r.code,
        });
        break;
      }
      case "openFolder": {
        if (this.lastTwin?.evidencePath && fs.existsSync(this.lastTwin.evidencePath)) {
          void vscode.commands.executeCommand(
            "revealFileInOS",
            vscode.Uri.file(this.lastTwin.evidencePath)
          );
        } else if (this.currentPath && fs.existsSync(this.currentPath)) {
          void vscode.commands.executeCommand(
            "revealFileInOS",
            vscode.Uri.file(path.dirname(this.currentPath))
          );
        }
        break;
      }
    }
  }

  private pushEvidence() {
    const j = this.currentJson as Record<string, unknown> | undefined;
    if (!j) return;
    const status = String(
      j.status ?? (j.twin_verified ? "twin_verified" : j.ok === false ? "failed" : "unknown")
    );
    const proven = Boolean(
      j.proven ?? j.twin_verified ?? j.ok === true
    );
    const board = j.board != null ? String(j.board) : String(j.suite || "");
    let oracleResults = Array.isArray(j.oracle_results) ? j.oracle_results : [];
    if (!oracleResults.length && (j.twin_verified != null || j.ok != null)) {
      oracleResults = [
        {
          clause: "twin",
          passed: proven,
          detail: String(j.summary || "").slice(0, 200),
        },
      ];
    }
    const gaps = Array.isArray(j.gaps) ? j.gaps : [];
    this.post({
      type: "evidence",
      path: this.currentPath,
      status,
      proven,
      board,
      oracleResults,
      gaps,
      twinVerified: Boolean(j.twin_verified ?? proven),
      modelVerified: Boolean(j.model_verified),
      summary: String(j.summary || "").slice(0, 2000),
      raw: JSON.stringify(j, null, 2),
    });
  }

  private post(payload: unknown) {
    void this.view?.webview.postMessage(payload);
  }

  private html(): string {
    const nonce = getNonce();
    return shellHtml({
      nonce,
      title: "LabWired Evidence",
      body: `
<div class="app">
  <div class="header">
    <h1>Evidence</h1>
    <span class="badge neutral" id="statusBadge">—</span>
    <span class="grow"></span>
    <button class="ghost" id="runTwin" type="button">Run twin</button>
    <button class="ghost" id="refresh" type="button">Refresh</button>
    <button class="ghost" id="pick" type="button">Open…</button>
    <button class="ghost" id="demo" type="button">Demo</button>
    <button class="ghost" id="score" type="button">Score</button>
  </div>
  <div class="status-strip">
    <span class="muted xs" id="path">No evidence yet</span>
    <span class="grow"></span>
    <span class="muted xs">twin <strong id="twinV" style="font-weight:600;color:var(--text)">—</strong></span>
    <span class="muted xs">model <strong id="modelV" style="font-weight:600;color:var(--text)">false</strong></span>
    <span class="muted xs">board <strong id="board" style="font-weight:600;color:var(--text)">—</strong></span>
  </div>
  <div class="scroll" style="padding:10px">
    <div class="card col" id="clauses" style="margin-bottom:10px"></div>
    <div class="card" style="margin-bottom:10px">
      <div class="muted xs" style="margin-bottom:6px">summary</div>
      <pre class="mono" id="summary" style="margin:0;max-height:120px;overflow:auto"></pre>
    </div>
    <div class="card" style="margin-bottom:10px">
      <div class="muted xs" style="margin-bottom:6px">score / assert / status</div>
      <pre class="mono" id="scoreOut" style="margin:0"></pre>
    </div>
    <div class="card">
      <div class="muted xs" style="margin-bottom:6px">raw JSON</div>
      <pre class="mono" id="raw" style="margin:0; max-height: 240px; overflow:auto"></pre>
    </div>
  </div>
</div>`,
      script: `
const statusBadge = document.getElementById('statusBadge');
const pathEl = document.getElementById('path');
const board = document.getElementById('board');
const twinV = document.getElementById('twinV');
const modelV = document.getElementById('modelV');
const clauses = document.getElementById('clauses');
const raw = document.getElementById('raw');
const summary = document.getElementById('summary');
const scoreOut = document.getElementById('scoreOut');

document.getElementById('pick').onclick = () => vscode.postMessage({ type: 'pick' });
document.getElementById('demo').onclick = () => vscode.postMessage({ type: 'demo' });
document.getElementById('score').onclick = () => vscode.postMessage({ type: 'score' });
document.getElementById('runTwin').onclick = () => vscode.postMessage({ type: 'runTwin', suite: 'smoke' });
document.getElementById('refresh').onclick = () => vscode.postMessage({ type: 'refresh' });

function renderEvidence(m) {
  pathEl.textContent = m.path || '';
  board.textContent = m.board || '—';
  twinV.textContent = m.twinVerified ? 'true' : 'false';
  modelV.textContent = m.modelVerified ? 'true' : 'false';
  statusBadge.textContent = m.status || '—';
  const ok = m.proven || m.twinVerified || m.status === 'twin_verified' || m.status === 'model_verified';
  statusBadge.className = 'badge ' + (ok ? 'ok' : (m.status === 'fail' || m.status === 'failed' ? 'fail' : 'warn'));
  summary.textContent = m.summary || '';
  clauses.innerHTML = '<div class="muted small" style="margin-bottom:8px">Oracle / twin clauses</div>';
  (m.oracleResults || []).forEach(c => {
    const row = document.createElement('div');
    row.className = 'row';
    row.style.marginBottom = '6px';
    const b = document.createElement('span');
    b.className = 'badge ' + (c.passed ? 'ok' : 'fail');
    b.textContent = c.passed ? 'pass' : 'fail';
    const t = document.createElement('span');
    t.className = 'mono small grow';
    t.textContent = (c.clause || '') + (c.detail ? ' — ' + c.detail : '');
    row.appendChild(b); row.appendChild(t);
    clauses.appendChild(row);
  });
  if (!(m.oracleResults || []).length) {
    const d = document.createElement('div');
    d.className = 'muted small';
    d.textContent = 'No clauses — Run twin to generate evidence.';
    clauses.appendChild(d);
  }
  if ((m.gaps || []).length) {
    const g = document.createElement('div');
    g.className = 'muted small';
    g.style.marginTop = '8px';
    g.textContent = 'Gaps: ' + m.gaps.join(', ');
    clauses.appendChild(g);
  }
  raw.textContent = m.raw || '';
}

window.addEventListener('message', (e) => {
  const m = e.data;
  if (m.type === 'evidence') renderEvidence(m);
  if (m.type === 'empty') {
    pathEl.textContent = 'No evidence — click Run twin or Open JSON';
    statusBadge.textContent = 'none';
    statusBadge.className = 'badge warn';
  }
  if (m.type === 'error') scoreOut.textContent = m.text;
  if (m.type === 'status') scoreOut.textContent = m.text || '';
  if (m.type === 'score') scoreOut.textContent = m.text || '';
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
