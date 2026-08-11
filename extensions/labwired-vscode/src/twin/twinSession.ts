/**
 * Digital twin session — **local-first** for client development, hosted optional.
 *
 * Backends (setting `labwired.twinBackend`):
 * - **local** (default): CLI smoke + local stdio `@labwired/mcp` (labwired_run demo)
 * - **hosted**: api.labwired.com MCP (compile-from-source when logged in)
 * - **auto**: local first; hosted if local fails and signed in
 *
 * Debug: local DAP (LabWired Debugger) preferred; MCP labwired_debug as probe.
 */
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { callHostedTool } from "../cli/hostedMcp";
import { loadCloudSession } from "../cli/cloudSession";
import { buildWorkspaceContext } from "../board/workspaceContext";
import { callLocalMcpTool } from "./localMcp";
import type { LabWiredBridge } from "../cli/bridge";

export type TwinAction = "run" | "prove" | "debug";
export type TwinBackend = "local" | "hosted" | "auto";

export type TwinSessionResult = {
  ok: boolean;
  action: TwinAction;
  model_verified: boolean;
  twin_ran: boolean;
  backend?: "local" | "hosted";
  board?: string;
  summary: string;
  serial?: string;
  snapshot_id?: string;
  status?: string;
  proven?: boolean;
  raw?: unknown;
  error?: string;
  dapStarted?: boolean;
};

const BLINK_ARDUINO = `// LabWired twin smoke — prints BOOT OK for oracle/acceptance
void setup() {
  Serial.begin(115200);
  pinMode(8, OUTPUT);
  Serial.println("BOOT OK");
}
void loop() {
  digitalWrite(8, HIGH);
  delay(200);
  digitalWrite(8, LOW);
  delay(200);
}
`;

let bridgeRef: LabWiredBridge | undefined;

/** Wire CLI bridge for local smoke/prove (called from activate). */
export function setTwinBridge(bridge: LabWiredBridge | undefined) {
  bridgeRef = bridge;
}

function workspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function twinBackendSetting(): TwinBackend {
  const v = vscode.workspace
    .getConfiguration("labwired")
    .get<string>("twinBackend");
  if (v === "hosted" || v === "auto" || v === "local") return v;
  return "local";
}

function loadDiagram(
  root: string
): { diagram: Record<string, unknown>; board: string } | { error: string } {
  const candidates = [
    path.join(root, ".labwired", "diagram.json"),
    path.join(root, ".labwired", "source-diagram.json"),
  ];
  for (const p of candidates) {
    try {
      if (!fs.existsSync(p)) continue;
      const diagram = JSON.parse(fs.readFileSync(p, "utf8")) as Record<
        string,
        unknown
      >;
      const board =
        typeof diagram.board === "string" ? diagram.board : undefined;
      if (!board) return { error: `No board in ${p}` };
      if (!Array.isArray(diagram.parts) || diagram.parts.length === 0) {
        return {
          error: `No parts in ${p} — mint a twin first (New board / Import)`,
        };
      }
      return { diagram, board };
    } catch (e) {
      return { error: `Failed to read ${p}: ${e}` };
    }
  }
  return {
    error:
      "No .labwired/diagram.json — use New board… or Import… then try again",
  };
}

function loadOrDefaultFirmware(root: string): {
  source: string;
  language: string;
  entryPath: string;
} {
  const candidates = [
    path.join(root, "src", "main.ino"),
    path.join(root, "src", "main.cpp"),
    path.join(root, ".labwired", "firmware", "main.ino"),
    path.join(root, "main.ino"),
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        const source = fs.readFileSync(p, "utf8");
        const language = p.endsWith(".ino") ? "arduino" : "cpp";
        const entryPath = p.endsWith(".ino") ? "src/main.ino" : "src/main.cpp";
        return { source, language, entryPath };
      }
    } catch {
      /* */
    }
  }
  return {
    source: BLINK_ARDUINO,
    language: "arduino",
    entryPath: "src/main.ino",
  };
}

function parseToolBody(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return { text: raw };
    }
  }
  return {};
}

function writeLastTwinResult(root: string, payload: unknown) {
  try {
    const dir = path.join(root, ".labwired");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "last-twin-run.json"),
      JSON.stringify(payload, null, 2) + "\n",
      "utf8"
    );
  } catch {
    /* */
  }
}

/** Twin mint readiness (local pack) — no network required. */
export function twinReadiness(root?: string): {
  ok: boolean;
  message: string;
  board?: string;
  needsLogin?: boolean;
} {
  const ws = root || workspaceRoot();
  if (!ws) return { ok: false, message: "Open a workspace folder first" };
  const ctx = buildWorkspaceContext(ws);
  if (!ctx.twin_buildable && !ctx.board) {
    const d = loadDiagram(ws);
    if ("error" in d) {
      return { ok: false, message: d.error, board: ctx.board };
    }
  }
  const d = loadDiagram(ws);
  if ("error" in d) return { ok: false, message: d.error, board: ctx.board };
  return { ok: true, message: "ready", board: d.board };
}

// ─── Local backends ───────────────────────────────────────────────────────────

async function runLocalCliSmoke(
  board?: string
): Promise<TwinSessionResult | null> {
  if (!bridgeRef) return null;
  try {
    await bridgeRef.ensureCli();
    const r = await bridgeRef.smoke();
    const out = `${r.stdout || ""}\n${r.stderr || ""}`;
    const ok = r.code === 0;
    return {
      ok,
      action: "run",
      model_verified: false,
      twin_ran: true,
      backend: "local",
      board,
      summary: `local CLI smoke exit=${r.code}${ok ? "" : " (non-zero)"}`,
      serial: out.slice(0, 4000),
      status: ok ? "pass" : "failed",
      raw: { code: r.code, stdout: r.stdout, stderr: r.stderr },
      error: ok ? undefined : out.slice(0, 500),
    };
  } catch (e) {
    return {
      ok: false,
      action: "run",
      model_verified: false,
      twin_ran: false,
      backend: "local",
      board,
      summary: `local CLI smoke failed: ${e}`,
      error: String(e),
    };
  }
}

/** Local stdio MCP: labwired_run with board demo firmware (no compile). */
async function runLocalMcpDemo(board: string): Promise<TwinSessionResult> {
  const res = await callLocalMcpTool(
    "labwired_run",
    {
      target: board,
      // omit firmware_ref → board demo ELF when available
      output: "full",
      max_cycles: 5_000_000,
    },
    { timeoutMs: 180_000 }
  );
  const body = parseToolBody(res.raw ?? res.text);
  if (!res.ok) {
    return {
      ok: false,
      action: "run",
      model_verified: false,
      twin_ran: false,
      backend: "local",
      board,
      summary: res.error || "local labwired_run failed",
      error: res.error || String(body.error || body.message || ""),
      raw: body,
    };
  }
  const status = String(body.status || body.run_status || "ok");
  const serial = typeof body.serial === "string" ? body.serial : undefined;
  const snapshot_id =
    typeof body.snapshot_id === "string" ? body.snapshot_id : undefined;
  const pass =
    !body.error &&
    (status === "pass" ||
      status === "ok" ||
      status === "success" ||
      status === "completed" ||
      (serial != null && serial.length > 0));
  return {
    ok: pass,
    action: "run",
    model_verified: false,
    twin_ran: true,
    backend: "local",
    board,
    summary: `local MCP labwired_run status=${status}${serial ? ` · serial=${serial.slice(0, 200)}` : ""}`,
    serial,
    snapshot_id,
    status,
    raw: body,
  };
}

async function runLocal(root: string, board: string): Promise<TwinSessionResult> {
  // 1) Prefer local MCP demo twin (real sim on client machine)
  const mcp = await runLocalMcpDemo(board);
  if (mcp.ok || mcp.twin_ran) {
    writeLastTwinResult(root, { backend: "local", mcp: mcp.raw });
    return mcp;
  }
  // 2) CLI smoke fallback
  const smoke = await runLocalCliSmoke(board);
  if (smoke) {
    writeLastTwinResult(root, { backend: "local", smoke: smoke.raw });
    if (smoke.ok || smoke.twin_ran) return smoke;
    // combine errors
    return {
      ...smoke,
      summary: `local MCP: ${mcp.error || "fail"} · CLI: ${smoke.summary}`,
      error: [mcp.error, smoke.error].filter(Boolean).join(" · "),
    };
  }
  return {
    ok: false,
    action: "run",
    model_verified: false,
    twin_ran: false,
    backend: "local",
    board,
    summary:
      mcp.summary +
      " · Install labwired CLI and/or `npx @labwired/mcp` for local twins. Set LABWIRED_REPO_ROOT if board YAMLs are missing.",
    error: mcp.error,
    raw: mcp.raw,
  };
}

async function proveLocal(
  root: string,
  board: string
): Promise<TwinSessionResult> {
  // Local prove: run twin then check serial for BOOT OK; full model_verified
  // still prefers labwired_verify (hosted or local MCP with firmware_ref).
  const run = await runLocal(root, board);
  if (!run.twin_ran) {
    return { ...run, action: "prove", model_verified: false };
  }
  const serial = run.serial || "";
  const bootOk = /BOOT OK/i.test(serial) || run.ok;
  // Try local verify if we have a path later; for now honest local claim:
  // local demo run success is twin_ran, NOT model_verified without verify tool.
  let verifyAttempt: { ok: boolean; error?: string; raw?: unknown } = {
    ok: false,
    error: "verify unavailable",
  };
  try {
    verifyAttempt = await callLocalMcpTool(
      "labwired_verify",
      {
        // stdio verify needs system_yaml + firmware_ref; empty probe may fail
        system_yaml: "",
        firmware_ref: "",
      },
      { timeoutMs: 30_000 }
    );
  } catch {
    verifyAttempt = { ok: false, error: "verify unavailable" };
  }

  // If local verify isn't usable, report honest dual claim
  if (!verifyAttempt.ok) {
    return {
      ok: bootOk,
      action: "prove",
      model_verified: false,
      twin_ran: true,
      backend: "local",
      board,
      summary: bootOk
        ? `local twin ran OK (serial/smoke). model_verified requires labwired_verify (set twinBackend=hosted or provide local firmware_ref).`
        : `local twin did not show BOOT OK · ${run.summary}`,
      serial,
      status: bootOk ? "local_pass" : "failed",
      proven: false,
      raw: { run: run.raw, verify: verifyAttempt },
    };
  }
  const body = parseToolBody(verifyAttempt.raw);
  const model_verified =
    body.status === "model_verified" || body.proven === true;
  return {
    ok: model_verified,
    action: "prove",
    model_verified,
    twin_ran: true,
    backend: "local",
    board,
    summary: model_verified
      ? `local model_verified · ${String(body.verification || "")}`
      : `local verify status=${body.status} · ${body.error || body.detail || ""}`,
    serial: typeof body.serial === "string" ? body.serial : serial,
    status: typeof body.status === "string" ? body.status : undefined,
    proven: body.proven === true,
    raw: body,
  };
}

// ─── Hosted backends ──────────────────────────────────────────────────────────

async function runHosted(root: string): Promise<TwinSessionResult> {
  const session = loadCloudSession();
  if (!session?.accessToken) {
    return {
      ok: false,
      action: "run",
      model_verified: false,
      twin_ran: false,
      backend: "hosted",
      summary: "Not signed in — Log in for hosted twin, or use twinBackend=local",
      error: "not_signed_in",
    };
  }
  const loaded = loadDiagram(root);
  if ("error" in loaded) {
    return {
      ok: false,
      action: "run",
      model_verified: false,
      twin_ran: false,
      backend: "hosted",
      summary: loaded.error,
      error: loaded.error,
    };
  }
  const fw = loadOrDefaultFirmware(root);
  const res = await callHostedTool("labwired_run", {
    diagram: loaded.diagram,
    board: loaded.board,
    source: fw.source,
    language: fw.language,
    entryPath: fw.entryPath,
    acceptance: { serial_contains: ["BOOT OK"] },
    max_steps: 2_000_000,
  });
  const body = parseToolBody(res.raw ?? res.text);
  if (!res.ok) {
    return {
      ok: false,
      action: "run",
      model_verified: false,
      twin_ran: false,
      backend: "hosted",
      board: loaded.board,
      summary: res.error || res.text || "labwired_run failed",
      error: res.error || String(body.error || body.detail || ""),
      raw: body,
    };
  }
  const status = String(body.status || body.run_status || "ok");
  const serial = typeof body.serial === "string" ? body.serial : undefined;
  const snapshot_id =
    typeof body.snapshot_id === "string" ? body.snapshot_id : undefined;
  const pass =
    status === "pass" ||
    status === "ok" ||
    status === "success" ||
    (serial != null && serial.includes("BOOT OK"));
  writeLastTwinResult(root, { backend: "hosted", run: body });
  return {
    ok: !!pass,
    action: "run",
    model_verified: false,
    twin_ran: true,
    backend: "hosted",
    board: loaded.board,
    summary: `hosted labwired_run status=${status}${serial ? ` · serial=${serial.slice(0, 200)}` : ""}`,
    serial,
    snapshot_id,
    status,
    raw: body,
  };
}

async function proveHosted(root: string): Promise<TwinSessionResult> {
  const session = loadCloudSession();
  if (!session?.accessToken) {
    return {
      ok: false,
      action: "prove",
      model_verified: false,
      twin_ran: false,
      backend: "hosted",
      summary: "Not signed in for hosted prove — use local twin or Log in",
      error: "not_signed_in",
    };
  }
  const loaded = loadDiagram(root);
  if ("error" in loaded) {
    return {
      ok: false,
      action: "prove",
      model_verified: false,
      twin_ran: false,
      backend: "hosted",
      summary: loaded.error,
      error: loaded.error,
    };
  }
  const fw = loadOrDefaultFirmware(root);
  const res = await callHostedTool("labwired_verify", {
    diagram: loaded.diagram,
    board: loaded.board,
    source: fw.source,
    language: fw.language,
    entryPath: fw.entryPath,
    oracle: { serial: [{ contains: "BOOT OK" }] },
  });
  const body = parseToolBody(res.raw ?? res.text);
  const model_verified =
    body.status === "model_verified" || body.proven === true;
  writeLastTwinResult(root, { backend: "hosted", verify: body });
  if (!res.ok && !model_verified) {
    return {
      ok: false,
      action: "prove",
      model_verified: false,
      twin_ran: true,
      backend: "hosted",
      board: loaded.board,
      summary: res.error || res.text || "labwired_verify failed",
      error: res.error || String(body.error || body.detail || body.reason || ""),
      status: typeof body.status === "string" ? body.status : undefined,
      proven: body.proven === true,
      raw: body,
      serial: typeof body.serial === "string" ? body.serial : undefined,
    };
  }
  return {
    ok: model_verified,
    action: "prove",
    model_verified,
    twin_ran: true,
    backend: "hosted",
    board: loaded.board,
    summary: model_verified
      ? `model_verified · ${String(body.verification || body.summary || "oracle green")}`
      : `not verified · status=${body.status} · ${body.reason || body.error || ""}`,
    status: typeof body.status === "string" ? body.status : undefined,
    proven: body.proven === true,
    serial: typeof body.serial === "string" ? body.serial : undefined,
    raw: body,
  };
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function runOnTwin(root?: string): Promise<TwinSessionResult> {
  const ws = root || workspaceRoot();
  const ready = twinReadiness(ws);
  if (!ready.ok || !ws) {
    return {
      ok: false,
      action: "run",
      model_verified: false,
      twin_ran: false,
      summary: ready.message,
      error: ready.message,
    };
  }
  const loaded = loadDiagram(ws);
  if ("error" in loaded) {
    return {
      ok: false,
      action: "run",
      model_verified: false,
      twin_ran: false,
      summary: loaded.error,
      error: loaded.error,
    };
  }
  const board = ready.board || loaded.board;

  const mode = twinBackendSetting();
  if (mode === "local") return runLocal(ws, board);
  if (mode === "hosted") return runHosted(ws);

  // auto: local first
  const local = await runLocal(ws, board);
  if (local.ok || local.twin_ran) return local;
  if (loadCloudSession()?.accessToken) {
    const hosted = await runHosted(ws);
    if (hosted.ok || hosted.twin_ran) return hosted;
    return {
      ...hosted,
      summary: `auto: local failed (${local.error || local.summary}); hosted: ${hosted.summary}`,
      error: [local.error, hosted.error].filter(Boolean).join(" · "),
    };
  }
  return {
    ...local,
    summary:
      local.summary +
      " · Sign in or fix local MCP/CLI for twin (twinBackend=local|auto)",
  };
}

export async function proveOnTwin(root?: string): Promise<TwinSessionResult> {
  const ws = root || workspaceRoot();
  const ready = twinReadiness(ws);
  if (!ready.ok || !ws) {
    return {
      ok: false,
      action: "prove",
      model_verified: false,
      twin_ran: false,
      summary: ready.message,
      error: ready.message,
    };
  }
  const board = ready.board || "unknown";
  const mode = twinBackendSetting();

  if (mode === "hosted") return proveHosted(ws);
  if (mode === "local") return proveLocal(ws, board);

  // auto: try local run honesty, then hosted verify for true model_verified
  if (loadCloudSession()?.accessToken) {
    const hosted = await proveHosted(ws);
    if (hosted.model_verified || hosted.twin_ran) return hosted;
  }
  return proveLocal(ws, board);
}

export async function debugOnTwin(
  root?: string
): Promise<TwinSessionResult> {
  const ws = root || workspaceRoot();
  const ready = twinReadiness(ws);
  if (!ready.ok || !ws) {
    return {
      ok: false,
      action: "debug",
      model_verified: false,
      twin_ran: false,
      summary: ready.message,
      error: ready.message,
    };
  }
  const loaded = loadDiagram(ws);
  if ("error" in loaded) {
    return {
      ok: false,
      action: "debug",
      model_verified: false,
      twin_ran: false,
      summary: loaded.error,
      error: loaded.error,
    };
  }

  // Local DAP first (LabWired Debugger extension) — best local DX
  let dapStarted = false;
  try {
    const folders = vscode.workspace.workspaceFolders;
    if (folders?.[0]) {
      dapStarted = !!(await vscode.debug.startDebugging(folders[0], {
        type: "labwired",
        name: "LabWired Twin (local)",
        request: "launch",
        stopOnEntry: true,
        cwd: ws,
      }));
    }
  } catch {
    dapStarted = false;
  }

  // Local MCP debug probe (if available)
  let localProbe: TwinSessionResult | undefined;
  try {
    const res = await callLocalMcpTool(
      "labwired_debug",
      {
        diagram: loaded.diagram,
        board: loaded.board,
        target: loaded.board,
        max_steps: 200_000,
      },
      { timeoutMs: 60_000 }
    );
    if (res.ok || res.raw) {
      const body = parseToolBody(res.raw);
      localProbe = {
        ok: true,
        action: "debug",
        model_verified: false,
        twin_ran: true,
        backend: "local",
        board: loaded.board,
        summary: `local debug probe stop=${body.stop_reason || body.status || "ok"}`,
        serial: typeof body.serial === "string" ? body.serial : undefined,
        raw: body,
        dapStarted,
      };
    }
  } catch {
    /* */
  }

  if (dapStarted || localProbe) {
    return (
      localProbe || {
        ok: true,
        action: "debug",
        model_verified: false,
        twin_ran: true,
        backend: "local",
        board: loaded.board,
        summary: "Local LabWired Debugger session started (F5 DAP)",
        dapStarted: true,
      }
    );
  }

  // Hosted debug if signed in
  if (loadCloudSession()?.accessToken) {
    const fw = loadOrDefaultFirmware(ws);
    const res = await callHostedTool("labwired_debug", {
      diagram: loaded.diagram,
      board: loaded.board,
      source: fw.source,
      language: fw.language,
      entryPath: fw.entryPath,
      max_steps: 500_000,
      read: ["serial", "pc", "regs", "location"],
    });
    const body = parseToolBody(res.raw ?? res.text);
    return {
      ok: res.ok,
      action: "debug",
      model_verified: false,
      twin_ran: true,
      backend: "hosted",
      board: loaded.board,
      summary: res.ok
        ? `hosted labwired_debug stop=${body.stop_reason || body.status}`
        : res.error || "debug failed",
      serial: typeof body.serial === "string" ? body.serial : undefined,
      raw: body,
      error: res.ok ? undefined : res.error,
      dapStarted: false,
    };
  }

  return {
    ok: false,
    action: "debug",
    model_verified: false,
    twin_ran: false,
    backend: "local",
    board: loaded.board,
    summary:
      'Install "LabWired Debugger" for F5 local twin debug, or `npx @labwired/mcp`, or Log in for hosted debug.',
    error: "no_local_debug_backend",
  };
}

export function formatTwinResultForChat(r: TwinSessionResult): string {
  const head =
    r.action === "prove"
      ? r.model_verified
        ? "✓ model_verified"
        : r.twin_ran
          ? "△ twin ran (not model_verified)"
          : "✗ prove failed"
      : r.ok
        ? `✓ twin ${r.action}`
        : `✗ twin ${r.action}`;
  return [
    head,
    r.backend ? `backend=${r.backend}` : null,
    r.board ? `board=${r.board}` : null,
    r.status ? `status=${r.status}` : null,
    r.snapshot_id ? `snapshot_id=${r.snapshot_id}` : null,
    r.summary,
    r.serial ? `serial:\n${r.serial.slice(0, 1500)}` : null,
    r.error ? `error: ${r.error}` : null,
    r.action === "prove"
      ? "Claim: model_verified only from labwired_verify — local smoke alone is not enough."
      : r.action === "run"
        ? "Observational run. Use Prove for model_verified. Local twin is default for development."
        : "Debug is observational — never model_verified.",
  ]
    .filter(Boolean)
    .join("\n");
}
