/**
 * Digital twin session for the agent extension.
 * Run / prove / debug via hosted MCP (labwired_run | verify | debug)
 * using .labwired/diagram.json — same contract as CLI agents.
 */
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { callHostedTool } from "../cli/hostedMcp";
import { loadCloudSession } from "../cli/cloudSession";
import { buildWorkspaceContext } from "../board/workspaceContext";

export type TwinAction = "run" | "prove" | "debug";

export type TwinSessionResult = {
  ok: boolean;
  action: TwinAction;
  model_verified: boolean;
  twin_ran: boolean;
  board?: string;
  summary: string;
  serial?: string;
  snapshot_id?: string;
  status?: string;
  proven?: boolean;
  raw?: unknown;
  error?: string;
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

function workspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
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
        return { error: `No parts in ${p} — mint a twin first (New board / Import)` };
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

/** Ensure twin is mint-ready before calling hosted tools. */
export function twinReadiness(root?: string): {
  ok: boolean;
  message: string;
  board?: string;
} {
  const ws = root || workspaceRoot();
  if (!ws) return { ok: false, message: "Open a workspace folder first" };
  const session = loadCloudSession();
  if (!session?.accessToken) {
    return {
      ok: false,
      message: "Sign in (LabWired: Log in) to run the hosted digital twin",
    };
  }
  const ctx = buildWorkspaceContext(ws);
  if (!ctx.twin_buildable) {
    return {
      ok: false,
      message: `Twin not ready (${ctx.summary}). New board… or Import… first.`,
      board: ctx.board,
    };
  }
  const d = loadDiagram(ws);
  if ("error" in d) return { ok: false, message: d.error };
  return { ok: true, message: "ready", board: d.board };
}

/**
 * Run firmware on the digital twin (observational — not model_verified).
 */
export async function runOnTwin(
  root?: string
): Promise<TwinSessionResult> {
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
  const fw = loadOrDefaultFirmware(ws);
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
    (serial && serial.includes("BOOT OK"));
  return {
    ok: !!pass,
    action: "run",
    model_verified: false,
    twin_ran: true,
    board: loaded.board,
    summary: `labwired_run status=${status}${serial ? ` · serial=${serial.slice(0, 200)}` : ""}`,
    serial,
    snapshot_id,
    status,
    raw: body,
  };
}

/**
 * Prove on twin via labwired_verify → may mint model_verified.
 */
export async function proveOnTwin(
  root?: string
): Promise<TwinSessionResult> {
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
  const loaded = loadDiagram(ws);
  if ("error" in loaded) {
    return {
      ok: false,
      action: "prove",
      model_verified: false,
      twin_ran: false,
      summary: loaded.error,
      error: loaded.error,
    };
  }
  const fw = loadOrDefaultFirmware(ws);
  const res = await callHostedTool("labwired_verify", {
    diagram: loaded.diagram,
    board: loaded.board,
    source: fw.source,
    language: fw.language,
    entryPath: fw.entryPath,
    oracle: { serial: [{ contains: "BOOT OK" }] },
  });
  const body = parseToolBody(res.raw ?? res.text);
  if (!res.ok && body.status !== "model_verified") {
    return {
      ok: false,
      action: "prove",
      model_verified: false,
      twin_ran: true,
      board: loaded.board,
      summary: res.error || res.text || "labwired_verify failed",
      error: res.error || String(body.error || body.detail || body.reason || ""),
      status: typeof body.status === "string" ? body.status : undefined,
      proven: body.proven === true,
      raw: body,
      serial: typeof body.serial === "string" ? body.serial : undefined,
    };
  }
  const model_verified =
    body.status === "model_verified" || body.proven === true;
  return {
    ok: model_verified,
    action: "prove",
    model_verified,
    twin_ran: true,
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

/**
 * Scripted twin probe (labwired_debug) — observational, never model_verified.
 * Also tries to start VS Code LabWired Debugger (type labwired) if installed.
 */
export async function debugOnTwin(
  root?: string
): Promise<TwinSessionResult & { dapStarted?: boolean }> {
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

  // Prefer native F5 debugger extension when available
  let dapStarted = false;
  try {
    const folders = vscode.workspace.workspaceFolders;
    if (folders?.[0]) {
      const started = await vscode.debug.startDebugging(folders[0], {
        type: "labwired",
        name: "LabWired Twin",
        request: "launch",
        stopOnEntry: true,
        cwd: ws,
      });
      dapStarted = !!started;
    }
  } catch {
    dapStarted = false;
  }

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
  const ok = res.ok && body.status !== "error";
  return {
    ok: ok || dapStarted,
    action: "debug",
    model_verified: false,
    twin_ran: true,
    board: loaded.board,
    summary: dapStarted
      ? `VS Code LabWired Debug started · MCP probe: ${body.stop_reason || body.status || "done"}`
      : `labwired_debug stop=${body.stop_reason || body.status || "?"} pc=${body.pc || "—"} (install "LabWired Debugger" for F5 DAP)`,
    serial: typeof body.serial === "string" ? body.serial : undefined,
    status: typeof body.status === "string" ? body.status : undefined,
    raw: body,
    error: res.ok ? undefined : res.error,
    dapStarted,
  };
}

export function formatTwinResultForChat(r: TwinSessionResult): string {
  const head =
    r.action === "prove"
      ? r.model_verified
        ? "✓ model_verified"
        : "✗ not verified"
      : r.ok
        ? `✓ twin ${r.action}`
        : `✗ twin ${r.action}`;
  return [
    head,
    r.board ? `board=${r.board}` : null,
    r.status ? `status=${r.status}` : null,
    r.snapshot_id ? `snapshot_id=${r.snapshot_id}` : null,
    r.summary,
    r.serial ? `serial:\n${r.serial.slice(0, 1500)}` : null,
    r.error ? `error: ${r.error}` : null,
    r.action === "prove"
      ? "Claim: model_verified only from labwired_verify (this path)."
      : r.action === "run"
        ? "Observational run — not a prove claim. Use Prove on twin for model_verified."
        : "Debug is observational — never model_verified.",
  ]
    .filter(Boolean)
    .join("\n");
}
