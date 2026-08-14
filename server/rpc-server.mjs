#!/usr/bin/env node
/**
 * LabWired agent JSON-RPC server (Embedder-style thin client target).
 *
 * Transport: JSON-RPC 2.0 + Content-Length framing on stdio.
 * Tools stay in the labwired CLI; this process only routes.
 *
 * Usage:
 *   node server/rpc-server.mjs
 *   labwired server --rpc-stdio
 */
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { readdir } from "node:fs/promises";

const __dirname = dirname(fileURLToPath(import.meta.url));
const AGENT_ROOT = resolve(__dirname, "..");
const PROTOCOL = "0.5.0";

/** @type {{ workspacePath: string, mode: string, autoConfirm: boolean, clientName: string }} */
const state = {
  workspacePath: process.cwd(),
  mode: "act",
  autoConfirm: true,
  clientName: "unknown",
};

/** @type {import('node:child_process').ChildProcessWithoutNullStreams | null} */
let chatChild = null;

/** @type {{ fd: number | null, stream: fs.ReadStream | null, port: string, baud: number, open: boolean, bytesIn: number, bytesOut: number }} */
const serialLive = {
  fd: null,
  stream: null,
  port: "",
  baud: 115200,
  open: false,
  bytesIn: 0,
  bytesOut: 0,
};

/** GDB server state (probe-rs) */
const gdbState = {
  child: null,
  running: false,
  chip: "",
  port: 1337,
  pid: null,
  lastLog: "",
};

/** Simple UART numeric series for plot (Part 3) */
const plotSeries = {
  /** @type {Record<string, number[]>} */
  series: {},
  maxPoints: 200,
};

// ——— framing ———

let buf = Buffer.alloc(0);

function writeMessage(obj) {
  const body = Buffer.from(JSON.stringify(obj), "utf8");
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
}

function notify(method, params = {}) {
  writeMessage({ jsonrpc: "2.0", method, params });
}

function respond(id, result) {
  writeMessage({ jsonrpc: "2.0", id, result });
}

function respondError(id, code, message) {
  writeMessage({
    jsonrpc: "2.0",
    id,
    error: { code, message },
  });
}

function onData(chunk) {
  buf = Buffer.concat([buf, chunk]);
  while (true) {
    const headerEnd = buf.indexOf("\r\n\r\n");
    if (headerEnd === -1) break;
    const header = buf.subarray(0, headerEnd).toString("ascii");
    const m = /content-length:\s*(\d+)/i.exec(header);
    if (!m) {
      buf = buf.subarray(headerEnd + 4);
      continue;
    }
    const len = Number(m[1]);
    const start = headerEnd + 4;
    const end = start + len;
    if (buf.length < end) break;
    const body = buf.subarray(start, end).toString("utf8");
    buf = buf.subarray(end);
    try {
      const msg = JSON.parse(body);
      void handleMessage(msg);
    } catch (e) {
      // ignore parse errors
    }
  }
}

// ——— labwired resolution ———

function findLabwiredAgent() {
  const candidates = [
    process.env.LABWIRED_AGENT_CLI_PATH,
    join(AGENT_ROOT, "bin", "labwired-agent"),
    join(homedir(), ".labwired", "agent", "bin", "labwired-agent"),
    "labwired-agent", // PATH
  ].filter(Boolean);
  for (const c of candidates) {
    if (c === "labwired-agent") return c;
    if (existsSync(c)) return c;
  }
  return null;
}

/**
 * Tool registry — argv after `labwired`. Keep in sync with extension tools/registry.
 * Params use ${name} placeholders.
 */
const TOOLS = [
  { name: "doctor", title: "Doctor", argv: ["doctor"], group: "install" },
  {
    name: "doctor_strict",
    title: "Doctor (strict)",
    argv: ["doctor", "--strict"],
    group: "install",
  },
  { name: "version", title: "Version", argv: ["version"], group: "install" },
  {
    name: "smoke",
    title: "Smoke",
    argv: ["smoke"],
    group: "install",
    timeoutMs: 180_000,
  },
  {
    name: "install_deps",
    title: "Install deps",
    argv: ["install-deps"],
    group: "install",
    timeoutMs: 600_000,
  },
  { name: "help", title: "Help", argv: ["help"], group: "project" },
  { name: "probe_list", title: "Probe list", argv: ["probe", "list"], group: "hardware" },
  {
    name: "probe_doctor",
    title: "Probe doctor",
    argv: ["probe", "doctor"],
    group: "hardware",
  },
  {
    name: "probe_chips",
    title: "Probe chips",
    argv: ["probe", "chips", "${query}"],
    params: ["query"],
    group: "hardware",
  },
  {
    name: "probe_flash",
    title: "Flash",
    argv: ["probe", "flash", "${elf}", "--chip", "${chip}", "--target", "${target}"],
    params: ["elf", "chip", "target", "confirm"],
    group: "hardware",
    timeoutMs: 120_000,
  },
  {
    name: "serial_capture",
    title: "Serial capture",
    argv: ["serial-capture", "${port}", "${baud}", "${marker}", "${timeout}"],
    params: ["port", "baud", "marker", "timeout"],
    group: "hardware",
    timeoutMs: 60_000,
  },
  {
    name: "score_verify",
    title: "Score verify",
    argv: ["score-verify", "${file}"],
    params: ["file"],
    group: "verify",
  },
  {
    name: "assert_status",
    title: "Assert status",
    argv: ["assert-status", "${expected}", "${file}"],
    params: ["expected", "file"],
    group: "verify",
  },
  // —— debug / GDB (handled in-process, not labwired argv) ——
  {
    name: "debug_info",
    title: "Debug info",
    argv: ["__debug__", "info"],
    group: "debug",
  },
  {
    name: "debug_gdb_start",
    title: "GDB server start",
    argv: ["__debug__", "gdb_start", "${chip}", "${port}"],
    params: ["chip", "port"],
    group: "debug",
  },
  {
    name: "debug_gdb_stop",
    title: "GDB server stop",
    argv: ["__debug__", "gdb_stop"],
    group: "debug",
  },
  {
    name: "debug_read",
    title: "Memory read",
    argv: ["__debug__", "read", "${addr}", "${len}", "${chip}"],
    params: ["addr", "len", "chip"],
    group: "debug",
  },
  {
    name: "plot_status",
    title: "Serial plot status",
    argv: ["__plot__", "status"],
    group: "hardware",
  },
  {
    name: "plot_clear",
    title: "Serial plot clear",
    argv: ["__plot__", "clear"],
    group: "hardware",
  },
  {
    name: "hw_claim_shape",
    title: "HW claim shape check",
    // Claim rules live in lib/claim-shape.sh — one engine, shared with the CLI.
    argv: [
      "claim-shape",
      "--status", "${status}",
      "--marker-matched", "${marker_matched}",
      "--flashed", "${flashed}",
    ],
    params: ["status", "marker_matched", "flashed"],
    group: "verify",
  },
  {
    name: "hw_promote",
    title: "HW promote (flash + marker → claim)",
    argv: ["__hw__", "promote", "${elf}", "${chip}", "${target}", "${port}", "${marker}", "${confirm}"],
    params: ["elf", "chip", "target", "port", "marker", "confirm", "baud", "timeout"],
    group: "verify",
    timeoutMs: 180_000,
  },
];

function expandArgv(template, params = {}) {
  return template.map((part) =>
    part.replace(/\$\{(\w+)\}/g, (_, k) => {
      const v = params[k];
      return v === undefined || v === null ? "" : String(v);
    })
  );
}

/** Run the Agent CLI.
 *  onDelta(stream, text) fires per chunk as the child writes, so a long tool
 *  (smoke ~180s, install_deps ~600s) reports progress instead of going silent
 *  until close. Output is still accumulated for the final result. */
function runLabwired(argv, { timeoutMs = 120_000, onDelta } = {}) {
  return new Promise((resolveRun) => {
    const bin = findLabwiredAgent();
    if (!bin) {
      resolveRun({
        code: 127,
        stdout: "",
        stderr: "labwired CLI not found. Install: curl -fsSL https://labwired.com/install | bash",
      });
      return;
    }
    const child = spawn(bin, argv, {
      cwd: state.workspacePath,
      env: {
        ...process.env,
        LABWIRED_MODE: state.mode,
        LABWIRED_VSCODE: "1",
        LABWIRED_EDITOR: "1",
      },
      shell: false,
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {
        /* */
      }
      resolveRun({ code: 124, stdout, stderr: stderr + "\n(timeout)", timedOut: true });
    }, timeoutMs);
    child.stdout?.on("data", (d) => {
      const s = d.toString();
      stdout += s;
      onDelta?.("stdout", s);
    });
    child.stderr?.on("data", (d) => {
      const s = d.toString();
      stderr += s;
      onDelta?.("stderr", s);
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolveRun({ code: 1, stdout, stderr: String(err.message || err) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolveRun({ code: code ?? 1, stdout, stderr });
    });
  });
}

// ——— methods ———

async function handleMessage(msg) {
  if (!msg || typeof msg !== "object") return;
  // notification from client (ignore for now)
  if (msg.method && msg.id === undefined) return;

  const { id, method, params = {} } = msg;
  if (id === undefined || !method) return;

  try {
    const result = await dispatch(method, params);
    respond(id, result);
  } catch (e) {
    respondError(id, -32000, e?.message || String(e));
  }
}

async function dispatch(method, params) {
  switch (method) {
    case "initialize":
      return initialize(params);
    case "mode/set":
      state.mode = String(params.mode || "act").toLowerCase();
      return { mode: state.mode };
    case "mode/get":
      return { mode: state.mode };
    case "autoConfirm/set":
      state.autoConfirm = !!params.enabled;
      return { enabled: state.autoConfirm };
    case "tool/list":
      return {
        tools: TOOLS.map((t) => ({
          name: t.name,
          title: t.title,
          group: t.group,
          params: t.params || [],
        })),
      };
    case "tool/run":
      return toolRun(params);
    case "chat/send":
      return chatSend(params);
    case "chat/stop":
      return chatStop();
    case "serial/listPorts":
      return listSerialPorts();
    case "serial/connect":
      return serialConnect(params);
    case "serial/disconnect":
      return serialDisconnect();
    case "serial/send":
      return serialSend(params);
    case "serial/status":
      return serialStatus();
    case "ping":
      return { ok: true, protocolVersion: PROTOCOL };
    default:
      throw new Error(`Method not found: ${method}`);
  }
}

function initialize(params) {
  if (params.workspacePath) state.workspacePath = String(params.workspacePath);
  if (params.clientName) state.clientName = String(params.clientName);
  const labwired = findLabwiredAgent();
  return {
    protocolVersion: PROTOCOL,
    serverName: "labwired-agent",
    serverVersion: "0.5.0",
    agentRoot: AGENT_ROOT,
    labwiredPath: labwired,
    capabilities: {
      tools: true,
      chat: true,
      serial: true,
      modes: ["act", "plan", "debug", "verify"],
    },
  };
}

async function toolRun(params) {
  const name = String(params.name || params.tool || "");
  const toolParams = params.params || params.arguments || {};
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) {
    throw new Error(`Unknown tool: ${name}. Use tool/list.`);
  }
  // Mode gates — Plan/Verify never flash, promote-to-desk, install deps, or GDB attach.
  // hw_promote nests probe_flash; it MUST be in the Plan denylist (not only probe_flash).
  const destructive = new Set([
    "probe_flash",
    "probe_reset",
    "install_deps",
    "probe_install_backend",
    "debug_gdb_start",
    "hw_promote",
  ]);
  const verifyOnly = new Set([
    "score_verify",
    "assert_status",
    "doctor",
    "doctor_strict",
    "version",
    "help",
    "probe_list",
    "probe_doctor",
    "probe_chips",
    "serial_capture",
    "smoke",
    "plot_status",
    "plot_clear",
    "hw_claim_shape",
    "debug_info",
  ]);
  if (state.mode === "plan" && destructive.has(name)) {
    throw new Error(
      `Plan mode: tool \`${name}\` disabled (no flash/promote/install/GDB attach). Switch to Act or Debug.`,
    );
  }
  if (state.mode === "verify" && !verifyOnly.has(name)) {
    throw new Error(
      `Verify mode: only doctor/score/assert/probe-list/serial-capture tools. \`${name}\` blocked.`,
    );
  }
  if (state.mode === "verify" && name === "probe_flash") {
    throw new Error("Verify mode: flash disabled. Use score/assert tools.");
  }

  // Physical flash requires explicit confirm=1 (or yes/true). Virtual target is auto-allowed.
  if (name === "probe_flash") {
    const target = String(toolParams.target || "auto").toLowerCase();
    const confirm = String(toolParams.confirm || "").toLowerCase();
    const confirmed = confirm === "1" || confirm === "yes" || confirm === "true";
    const isVirtual = target === "virtual" || target === "sim" || target === "twin";
    if (!isVirtual && !confirmed && !state.autoConfirm) {
      throw new Error(
        "probe_flash: physical flash requires confirm=1 (or target=virtual). " +
          "Example: tool/run probe_flash { elf, chip, target:\"probe\", confirm:\"1\" }",
      );
    }
    // Even with autoConfirm, require confirm for non-virtual unless LABWIRED_FLASH_AUTO=1
    if (!isVirtual && !confirmed && process.env.LABWIRED_FLASH_AUTO !== "1") {
      // Soft-gate when autoConfirm true: still require confirm for physical safety
      if (target === "probe" || target === "auto" || target === "hardware") {
        throw new Error(
          "probe_flash: confirmation required for physical/auto target. " +
            "Pass confirm=1 after user approval, or target=virtual for twin. " +
            "Override only with LABWIRED_FLASH_AUTO=1 (dangerous).",
        );
      }
    }
  }

  notify("chat/toolCall", { name: tool.name, title: tool.title, params: toolParams });

  // In-process special tools
  if (tool.argv[0] === "__debug__" || tool.argv[0] === "__plot__" || tool.argv[0] === "__hw__") {
    const special = await runSpecialTool(tool, toolParams);
    notify("chat/toolResult", {
      name: tool.name,
      code: special.code,
      detail: (special.stdout || special.stderr || "").slice(0, 100_000),
    });
    return {
      name: tool.name,
      code: special.code,
      stdout: special.stdout,
      stderr: special.stderr || "",
      timedOut: false,
      extra: special.extra,
    };
  }

  const argv = expandArgv(tool.argv, {
    query: "stm32",
    baud: "115200",
    marker: "LABWIRED_OK",
    timeout: "10",
    target: "auto",
    expected: "model_verified",
    port: "1337",
    len: "16",
    addr: "0x0",
    chip: "STM32F401RETx",
    ...toolParams,
  });
  let streamed = false;
  const result = await runLabwired(argv, {
    timeoutMs: tool.timeoutMs || 120_000,
    onDelta: (stream, text) => {
      streamed = true;
      notify("chat/toolDelta", { name: tool.name, stream, text });
    },
  });
  const detail =
    (result.stdout || "") + (result.stderr ? (result.stdout ? "\n" : "") + result.stderr : "");
  // streamed=true tells the client the body already arrived as deltas, so it
  // renders the verdict instead of appending `detail` a second time.
  notify("chat/toolResult", {
    name: tool.name,
    code: result.code,
    detail: detail.slice(0, 100_000),
    streamed,
  });
  return {
    name: tool.name,
    code: result.code,
    stdout: result.stdout,
    stderr: result.stderr,
    timedOut: !!result.timedOut,
  };
}

function whichSync(bin) {
  try {
    const r = spawnSync(process.platform === "win32" ? "where" : "which", [bin], {
      encoding: "utf8",
    });
    if (r.status !== 0) return null;
    return (r.stdout || "").trim().split(/\r?\n/)[0] || null;
  } catch {
    return null;
  }
}

/** probe-rs path, resolved by lib/resolve-probe.sh — the CLI's own resolver.
 *  Do NOT re-implement the candidate list here: a second list drifts, and it did
 *  (the old JS missed $LABWIRED_HOME, prefix/bin, and ~/.cargo/bin, so a
 *  cargo-installed probe-rs worked in the terminal and was "missing" in the editor).
 *  Sourcing the lib costs ~2ms; cached per session because the path cannot move
 *  while the server runs. Returns null when probe-rs is absent. */
let probeRsCached;
function resolveProbeRs() {
  if (probeRsCached !== undefined) return probeRsCached;
  const lib = join(AGENT_ROOT, "lib", "resolve-probe.sh");
  if (existsSync(lib)) {
    try {
      const r = spawnSync("bash", ["-c", `source "$1"; labwired_resolve_probe_rs`, "_", lib], {
        encoding: "utf8",
      });
      const out = (r.stdout || "").trim().split(/\r?\n/)[0] || "";
      probeRsCached = r.status === 0 && out ? out : null;
      return probeRsCached;
    } catch {
      /* fall through to the degraded lookup below */
    }
  }
  // Degraded: server running without the Agent kit beside it (copied server, tests).
  // PATH only — never a second candidate list.
  probeRsCached = whichSync("probe-rs");
  return probeRsCached;
}

/** Hardware claim shape via `labwired-agent claim-shape` (lib/claim-shape.sh).
 *  The rules are NOT duplicated here: a second claim engine is how the editor
 *  and the terminal end up disagreeing about what counts as hardware_observed. */
async function hwClaimShape(params = {}) {
  const argv = [
    "claim-shape",
    "--status", String(params.status ?? ""),
    "--marker-matched", String(params.marker_matched ?? "0"),
    "--flashed", String(params.flashed ?? "0"),
  ];
  const r = await runLabwired(argv, { timeoutMs: 20_000 });
  let extra = {};
  try {
    extra = JSON.parse(r.stdout || "{}");
  } catch {
    // Refusal path prints to stderr only, so there is no payload to parse.
    extra = { status: "refused", reason: "model_verified_from_hw" };
  }
  return { code: r.code, stdout: r.stdout, stderr: r.stderr, extra };
}

async function runSpecialTool(tool, params) {
  const kind = tool.argv[0];
  const op = tool.argv[1];

  if (kind === "__plot__") {
    if (op === "clear") {
      plotSeries.series = {};
      notify("plot/clear", {});
      return { code: 0, stdout: "plot series cleared\n", stderr: "" };
    }
    const keys = Object.keys(plotSeries.series);
    const summary = keys.map((k) => {
      const a = plotSeries.series[k];
      const last = a.length ? a[a.length - 1] : null;
      return `${k}: n=${a.length} last=${last}`;
    });
    return {
      code: 0,
      stdout: summary.length ? summary.join("\n") + "\n" : "(no series yet — stream UART lines like temp=23.5)\n",
      stderr: "",
      extra: { series: plotSeries.series },
    };
  }

  // No "__hw__ claim" branch: hw_claim_shape is a plain argv tool now
  // (`claim-shape`), so it never reaches runSpecialTool.

  if (kind === "__hw__" && op === "promote") {
    // Desk/virtual promote: flash → optional serial marker → claim (never model_verified)
    const elf = String(params.elf || "");
    const chip = String(params.chip || "esp32c3");
    const target = String(params.target || "virtual").toLowerCase();
    const port = String(params.port || "");
    const marker = String(params.marker || "LABWIRED_OK");
    const baud = String(params.baud || "115200");
    const timeout = String(params.timeout || "8");
    const confirm = String(params.confirm || "").toLowerCase();
    const confirmed = confirm === "1" || confirm === "yes" || confirm === "true";
    const isVirtual = target === "virtual" || target === "sim" || target === "twin";

    if (!isVirtual && !confirmed && process.env.LABWIRED_FLASH_AUTO !== "1") {
      return {
        code: 2,
        stdout: "",
        stderr:
          "hw_promote: physical target requires confirm=1 after user approval (or target=virtual).\n",
        extra: { status: "needs_confirm" },
      };
    }
    if (!elf && !params.dry_run && params.dry_run !== "1") {
      // allow dry_run without elf for claim pipeline test
      if (String(params.dry_run || "") !== "1") {
        return {
          code: 2,
          stdout: "",
          stderr: "hw_promote: elf path required (or dry_run=1 for claim-shape dry run)\n",
        };
      }
    }

    let flashed = false;
    let flashOut = "";
    if (String(params.dry_run || "") === "1") {
      flashed = String(params.flashed || "1") !== "0";
      flashOut = "[dry_run] flash skipped\n";
    } else {
      const flashParams = {
        elf,
        chip,
        target: isVirtual ? "virtual" : target,
        confirm: isVirtual ? "0" : "1",
      };
      // re-enter labwired flash via nested toolRun path
      const flashTool = TOOLS.find((t) => t.name === "probe_flash");
      const argv = expandArgv(flashTool.argv, flashParams);
      const fr = await runLabwired(argv, {
        timeoutMs: 120_000,
        onDelta: (stream, text) => notify("chat/toolDelta", { name: "hw_promote", stream, text }),
      });
      flashOut = (fr.stdout || "") + (fr.stderr || "");
      flashed = fr.code === 0;
    }

    let marker_matched = false;
    let captureOut = "";
    if (String(params.dry_run || "") === "1") {
      marker_matched = String(params.marker_matched || "1") !== "0";
      captureOut = `[dry_run] marker ${marker} assumed matched=${marker_matched}\n`;
    } else if (port && !isVirtual) {
      const cap = TOOLS.find((t) => t.name === "serial_capture");
      const argv = expandArgv(cap.argv, {
        port,
        baud,
        marker,
        timeout,
      });
      const cr = await runLabwired(argv, {
        timeoutMs: 60_000,
        onDelta: (stream, text) => notify("chat/toolDelta", { name: "hw_promote", stream, text }),
      });
      captureOut = (cr.stdout || "") + (cr.stderr || "");
      marker_matched =
        cr.code === 0 ||
        captureOut.includes(marker) ||
        /observed|matched|found/i.test(captureOut);
    } else if (isVirtual) {
      // Virtual: treat successful flash as not enough for hardware_observed;
      // twin claims stay model_verified path. For promote dry, use capture sim text if any.
      marker_matched = false;
      captureOut =
        "[virtual] flash does not yield hardware_observed; use twin verify for model_verified.\n";
    }

    const claim = await hwClaimShape({
      flashed: flashed ? "1" : "0",
      marker_matched: marker_matched ? "1" : "0",
    });
    const body = [
      "=== flash ===",
      flashOut.trim(),
      "=== capture ===",
      captureOut.trim(),
      "=== claim ===",
      claim.stdout.trim(),
    ].join("\n");
    return {
      code: claim.code,
      stdout: body + "\n",
      stderr: claim.stderr || "",
      extra: {
        ...(claim.extra || {}),
        flashed,
        marker_matched,
        target,
        dry_run: String(params.dry_run || "") === "1",
      },
    };
  }

  if (kind === "__debug__") {
    return runDebugOp(op, params);
  }

  return { code: 1, stdout: "", stderr: `unknown special tool ${kind}` };
}

function runDebugOp(op, params) {
  const probeRs = resolveProbeRs();

  if (op === "info") {
    const lines = [
      `mode: ${state.mode}`,
      `probe-rs: ${probeRs || "(missing — labwired probe install-backend)"}`,
      `gdb.running: ${gdbState.running}`,
      `gdb.chip: ${gdbState.chip || "-"}`,
      `gdb.port: ${gdbState.port}`,
      `gdb.pid: ${gdbState.pid || "-"}`,
      `connect: target remote 127.0.0.1:${gdbState.port}`,
    ];
    // probe list via labwired if possible — fire and forget summary
    return {
      code: probeRs ? 0 : 1,
      stdout: lines.join("\n") + "\n",
      stderr: probeRs ? "" : "Install probe-rs for physical GDB.\n",
      extra: { ...gdbState, probeRs: probeRs || null, child: undefined },
    };
  }

  if (op === "gdb_stop") {
    stopGdbServer();
    return { code: 0, stdout: "GDB server stopped\n", stderr: "" };
  }

  if (op === "gdb_start") {
    const chip = String(params.chip || "STM32F401RETx");
    const port = Number(params.port || 1337) || 1337;
    if (!probeRs) {
      return {
        code: 127,
        stdout: "",
        stderr: "probe-rs not found. Run: labwired probe install-backend\n",
      };
    }
    stopGdbServer();
    const attempts = [
      ["gdb", "--chip", chip, "--gdb-connection", `127.0.0.1:${port}`],
      ["gdb", "--chip", chip, "--gdb-connection-string", `127.0.0.1:${port}`],
      ["gdb", "--chip", chip],
    ];
    let started = false;
    let lastErr = "";
    for (const args of attempts) {
      try {
        const child = spawn(probeRs, args, {
          cwd: state.workspacePath,
          env: process.env,
          shell: false,
        });
        gdbState.child = child;
        gdbState.running = true;
        gdbState.chip = chip;
        gdbState.port = port;
        gdbState.pid = child.pid;
        gdbState.lastLog = "";
        child.stdout?.on("data", (d) => {
          gdbState.lastLog += d.toString();
        });
        child.stderr?.on("data", (d) => {
          gdbState.lastLog += d.toString();
        });
        child.on("exit", () => {
          gdbState.running = false;
          gdbState.child = null;
          gdbState.pid = null;
          notify("debug/gdbState", { running: false, chip, port });
        });
        notify("debug/gdbState", { running: true, chip, port, pid: child.pid });
        started = true;
        return {
          code: 0,
          stdout: [
            `probe-rs GDB server starting for ${chip}`,
            `  connect: target remote 127.0.0.1:${port}`,
            `  args: probe-rs ${args.join(" ")}`,
            `  (use arm-none-eabi-gdb or gdb-multiarch)`,
          ].join("\n") + "\n",
          stderr: "",
          extra: { running: true, chip, port },
        };
      } catch (e) {
        lastErr = String(e?.message || e);
      }
    }
    return {
      code: 1,
      stdout: "",
      stderr: started ? "" : `Failed to start GDB: ${lastErr}\n`,
    };
  }

  if (op === "read") {
    // probe-rs 0.32+: `probe-rs read --chip CHIP --probe VID:PID b32 <ADDRESS> <WORDS>`
    // Must pass --probe when multiple probes exist (--non-interactive alone fails parse).
    const addr = String(params.addr || "0x20000000");
    const byteLen = Math.max(4, Number(params.len || 16) || 16);
    const words = Math.max(1, Math.ceil(byteLen / 4));
    const chip = String(params.chip || gdbState.chip || "STM32F401RETx");
    const width = String(params.width || "b32");
    if (!probeRs) {
      return {
        code: 127,
        stdout: "",
        stderr: "probe-rs missing for debug_read\n",
        extra: { addr, len: byteLen, hex: null },
      };
    }
    const probeSel =
      String(params.probe || process.env.PROBE_RS_PROBE || "").trim() ||
      detectProbeSelector(probeRs, chip);
    return new Promise((resolve) => {
      // Do NOT set PROBE_RS_NON_INTERACTIVE=1 — clap may reject "1" as invalid.
      const base = ["read", "--chip", chip];
      if (probeSel) base.push("--probe", probeSel);
      const tries = [[...base, width, addr, String(words)]];
      let i = 0;
      let lastErr = "";
      const attempt = () => {
        if (i >= tries.length) {
          resolve({
            code: 1,
            stdout: "",
            stderr:
              `debug_read failed for ${chip} @ ${addr}` +
              (probeSel ? ` probe=${probeSel}` : "") +
              `.\nLast: ${lastErr}\n` +
              `Hint: match chip to probe (ESP-JTAG→esp32c3, J-Link→STM32), or set PROBE_RS_PROBE=VID:PID:Serial.\n`,
            extra: { addr, len: byteLen, words, hex: null, chip, probe: probeSel, caveat: "probe_or_chip" },
          });
          return;
        }
        const args = tries[i++];
        const env = { ...process.env };
        delete env.PROBE_RS_NON_INTERACTIVE;
        const child = spawn(probeRs, args, { env });
        let out = "";
        let err = "";
        const timer = setTimeout(() => {
          try {
            child.kill("SIGTERM");
          } catch {
            /* */
          }
        }, 10_000);
        child.stdout?.on("data", (d) => (out += d.toString()));
        child.stderr?.on("data", (d) => (err += d.toString()));
        child.on("close", (code) => {
          clearTimeout(timer);
          const text = (out || "").trim();
          if (code === 0 && text && !/error:/i.test(text)) {
            resolve({
              code: 0,
              stdout: out.endsWith("\n") ? out : out + "\n",
              stderr: err,
              extra: { addr, len: byteLen, words, hex: text, chip, probe: probeSel, args },
            });
            return;
          }
          lastErr = (err || out || `exit ${code}`).slice(0, 500);
          attempt();
        });
        child.on("error", (e) => {
          clearTimeout(timer);
          lastErr = String(e?.message || e);
          attempt();
        });
      };
      attempt();
    });
  }

  return { code: 1, stdout: "", stderr: `unknown debug op ${op}` };
}

function stopGdbServer() {
  if (gdbState.child) {
    try {
      gdbState.child.kill("SIGTERM");
    } catch {
      /* */
    }
    gdbState.child = null;
  }
  gdbState.running = false;
  gdbState.pid = null;
}

/**
 * Pick probe selector from `probe-rs list`.
 * Prefer ESP JTAG for esp chips, J-Link/ST-Link for STM32, else first listed.
 */
function detectProbeSelector(probeRsPath, chip = "") {
  try {
    const env = { ...process.env };
    delete env.PROBE_RS_NON_INTERACTIVE;
    const r = spawnSync(probeRsPath, ["list"], {
      encoding: "utf8",
      timeout: 5000,
      env,
    });
    const text = (r.stdout || "") + (r.stderr || "");
    // [0]: J-Link -- 1366:0101:004294967295 (J-Link)
    const lines = text.split("\n").filter((l) => /\[\d+\]:/.test(l));
    const parsed = lines.map((l) => {
      // Hex VID:PID (not \d-only — ESP uses 303a:1001:…)
      const id = (l.match(
        /([0-9a-fA-F]{4}:[0-9a-fA-F]{4}(?::[0-9A-Fa-f:.-]+)?)/,
      ) || [])[1];
      return {
        line: l,
        id,
        esp: /ESP|EspJtag|303a/i.test(l),
        jlink: /J-Link|1366|ST-Link|0483/i.test(l),
      };
    }).filter((p) => p.id);
    if (!parsed.length) return null;
    const c = String(chip).toLowerCase();
    if (/esp|c3|c6|s3/.test(c)) {
      const esp = parsed.find((p) => p.esp);
      if (esp) return esp.id;
    }
    if (/stm32|nrf|samd|rp2040/.test(c)) {
      const jl = parsed.find((p) => p.jlink);
      if (jl) return jl.id;
    }
    return parsed[0].id;
  } catch {
    return null;
  }
}

/** Parse UART line into plot series (temp=1.2 or csv numbers) */
function ingestPlotLine(line) {
  let changed = false;
  // key=value numbers
  const re = /([A-Za-z_][\w]*)\s*[=:]\s*(-?\d+(?:\.\d+)?)/g;
  let m;
  while ((m = re.exec(line))) {
    const key = m[1];
    const val = Number(m[2]);
    if (!plotSeries.series[key]) plotSeries.series[key] = [];
    plotSeries.series[key].push(val);
    if (plotSeries.series[key].length > plotSeries.maxPoints) {
      plotSeries.series[key].shift();
    }
    changed = true;
  }
  // pure csv numbers → series s0,s1,...
  if (!changed && /^-?\d/.test(line.trim())) {
    const parts = line.split(/[,\s]+/).filter(Boolean);
    const nums = parts.map(Number).filter((n) => !Number.isNaN(n));
    if (nums.length) {
      nums.forEach((val, i) => {
        const key = `s${i}`;
        if (!plotSeries.series[key]) plotSeries.series[key] = [];
        plotSeries.series[key].push(val);
        if (plotSeries.series[key].length > plotSeries.maxPoints) {
          plotSeries.series[key].shift();
        }
      });
      changed = true;
    }
  }
  if (changed) {
    notify("plot/update", { series: plotSeries.series });
  }
}

/**
 * Freeform chat: try opencode run, else OpenAI-compat, else tool-hint text.
 * Streams via notifications; method result is final summary.
 */
async function chatSend(params) {
  const text = String(params.text || params.prompt || params.message || "").trim();
  if (!text) throw new Error("chat/send requires text");

  // Slash tool shortcuts: /doctor, /smoke, /probe list, …
  const slash = text.match(/^\/(\w[\w-]*)(?:\s+(.*))?$/);
  if (slash) {
    const cmd = slash[1].toLowerCase();
    const rest = (slash[2] || "").trim();
    const mapped = mapSlashToTool(cmd, rest);
    if (mapped) {
      notify("chat/textDelta", { text: `Running tool \`${mapped.name}\`…\n` });
      const out = await toolRun(mapped);
      const body =
        (out.stdout || out.stderr || `(exit ${out.code})`).trim() || `(exit ${out.code})`;
      notify("chat/textDelta", { text: body + "\n" });
      notify("chat/done", { source: "tool" });
      return { source: "tool", tool: mapped.name, code: out.code };
    }
  }

  chatStop();

  // 1) opencode run
  const oc = await tryOpencode(text);
  if (oc) return oc;

  // 2) OpenAI-compatible (LABWIRED_MODEL_URL or api.labwired.com style)
  const api = await tryOpenAI(text);
  if (api) return api;

  const hint = [
    "No LLM backend available for freeform chat.",
    "Set LABWIRED_MODEL_URL + LABWIRED_MODEL_KEY, install opencode, or use slash tools:",
    "/doctor  /smoke  /version  /probe list  /gdb info  /plot  /help",
  ].join("\n");
  notify("chat/textDelta", { text: hint + "\n" });
  notify("chat/done", { source: "fallback" });
  return { source: "fallback", text: hint };
}

function mapSlashToTool(cmd, rest) {
  const table = {
    doctor: { name: "doctor", params: {} },
    smoke: { name: "smoke", params: {} },
    version: { name: "version", params: {} },
    help: { name: "help", params: {} },
    deps: { name: "install_deps", params: {} },
    "install-deps": { name: "install_deps", params: {} },
  };
  if (table[cmd]) return table[cmd];
  if (cmd === "probe") {
    const parts = rest.split(/\s+/).filter(Boolean);
    const sub = parts[0] || "list";
    if (sub === "list") return { name: "probe_list", params: {} };
    if (sub === "doctor") return { name: "probe_doctor", params: {} };
    if (sub === "chips")
      return { name: "probe_chips", params: { query: parts.slice(1).join(" ") || "stm32" } };
  }
  if (cmd === "score" && rest)
    return { name: "score_verify", params: { file: rest } };
  // Part 1: /gdb info|start|stop|read
  if (cmd === "gdb" || cmd === "debug") {
    const parts = rest.split(/\s+/).filter(Boolean);
    const sub = (parts[0] || "info").toLowerCase();
    if (sub === "info" || sub === "status") return { name: "debug_info", params: {} };
    if (sub === "stop") return { name: "debug_gdb_stop", params: {} };
    if (sub === "start") {
      return {
        name: "debug_gdb_start",
        params: { chip: parts[1] || "STM32F401RETx", port: parts[2] || "1337" },
      };
    }
    if (sub === "read") {
      return {
        name: "debug_read",
        params: {
          addr: parts[1] || "0x20000000",
          len: parts[2] || "16",
          chip: parts[3] || "",
        },
      };
    }
    return { name: "debug_info", params: {} };
  }
  if (cmd === "plot") {
    const sub = (rest.split(/\s+/)[0] || "status").toLowerCase();
    if (sub === "clear") return { name: "plot_clear", params: {} };
    return { name: "plot_status", params: {} };
  }
  if (cmd === "promote") {
    // dry-run claim pipeline for chat quick check; full promote needs elf/port
    return {
      name: "hw_promote",
      params: { dry_run: "1", flashed: "1", marker_matched: "1", target: "virtual" },
    };
  }
  return null;
}

function chatStop() {
  if (chatChild) {
    try {
      chatChild.kill("SIGTERM");
    } catch {
      /* */
    }
    chatChild = null;
  }
  return { stopped: true };
}

function tryOpencode(prompt) {
  return new Promise((resolveOc) => {
    const args = ["run", "--format", "json", "--agent", "labwired", "--auto", prompt];
    let settled = false;
    const finish = (ok, result) => {
      if (settled) return;
      settled = true;
      chatChild = null;
      resolveOc(ok ? result : null);
    };

    let child;
    try {
      child = spawn("opencode", args, {
        cwd: state.workspacePath,
        env: {
          ...process.env,
          LABWIRED_MODE: state.mode,
          LABWIRED_EDITOR: "1",
        },
        shell: false,
      });
    } catch {
      finish(false);
      return;
    }
    chatChild = child;
    let gotAny = false;
    let full = "";

    child.stdout.on("data", (d) => {
      const s = d.toString();
      // Try line-delimited JSON events; else plain text
      for (const line of s.split("\n")) {
        const t = line.trim();
        if (!t) continue;
        try {
          const ev = JSON.parse(t);
          if (ev.type === "text" || ev.part?.type === "text") {
            const piece = ev.text || ev.part?.text || "";
            if (piece) {
              gotAny = true;
              full += piece;
              notify("chat/textDelta", { text: piece });
            }
          } else if (ev.type === "tool" || ev.tool) {
            gotAny = true;
            notify("chat/toolCall", {
              name: ev.name || ev.tool || "tool",
              detail: JSON.stringify(ev).slice(0, 2000),
            });
          } else if (ev.message?.content) {
            const piece =
              typeof ev.message.content === "string"
                ? ev.message.content
                : JSON.stringify(ev.message.content);
            gotAny = true;
            full += piece;
            notify("chat/textDelta", { text: piece });
          }
        } catch {
          gotAny = true;
          full += t + "\n";
          notify("chat/textDelta", { text: t + "\n" });
        }
      }
    });
    child.stderr.on("data", (d) => {
      // opencode often logs to stderr; only surface if no stdout
      if (!gotAny) {
        const s = d.toString();
        if (s.includes("not found") || s.includes("Error")) {
          // don't flood
        }
      }
    });
    child.on("error", () => finish(false));
    child.on("close", (code) => {
      if (!gotAny) {
        finish(false);
        return;
      }
      notify("chat/done", { source: "opencode", code });
      finish(true, { source: "opencode", code, text: full });
    });
  });
}

async function tryOpenAI(prompt) {
  const base = (process.env.LABWIRED_MODEL_URL || "").replace(/\/$/, "");
  const key = process.env.LABWIRED_MODEL_KEY || process.env.OPENAI_API_KEY || "local";
  const model = process.env.LABWIRED_MODEL || "default";
  const project = process.env.LABWIRED_PROJECT || "";
  if (!base) return null;

  const url = base.includes("/chat/completions")
    ? base
    : `${base}/chat/completions`;

  const system = [
    `You are LabWired firmware agent. Mode: ${state.mode}.`,
    "Prefer twin verification; never claim model_verified without labwired_verify / score tools.",
    "IDE slash tools: /doctor /smoke /probe /version /help",
    "Be concise and cite evidence when making hardware claims.",
  ].join("\n");

  try {
    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    };
    if (project) headers["X-LabWired-Project"] = project;

    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        stream: true,
        messages: [
          { role: "system", content: system },
          { role: "user", content: prompt },
        ],
      }),
    });
    if (!res.ok || !res.body) return null;

    let full = "";
    // Node 18+ ReadableStream
    const reader = res.body.getReader?.();
    if (!reader) {
      const j = await res.json();
      const text = j.choices?.[0]?.message?.content || "";
      if (!text) return null;
      notify("chat/textDelta", { text });
      notify("chat/done", { source: "openai" });
      return { source: "openai", text };
    }

    const dec = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += dec.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith("data:")) continue;
        const data = t.slice(5).trim();
        if (data === "[DONE]") continue;
        try {
          const j = JSON.parse(data);
          const piece = j.choices?.[0]?.delta?.content || "";
          if (piece) {
            full += piece;
            notify("chat/textDelta", { text: piece });
          }
        } catch {
          /* */
        }
      }
    }
    if (!full) return null;
    notify("chat/done", { source: "openai" });
    return { source: "openai", text: full };
  } catch {
    return null;
  }
}

async function listSerialPorts() {
  const ports = [];
  if (process.platform === "darwin" || process.platform === "linux") {
    try {
      const dir = "/dev";
      const names = await readdir(dir);
      for (const n of names) {
        if (
          n.startsWith("cu.") ||
          n.startsWith("tty.usb") ||
          n.startsWith("ttyACM") ||
          n.startsWith("ttyUSB")
        ) {
          ports.push({ path: join(dir, n), manufacturer: "local" });
        }
      }
    } catch {
      /* */
    }
  }
  return { ports };
}

function serialStatus() {
  return {
    port: serialLive.port,
    baud: serialLive.baud,
    open: serialLive.open,
    bytesIn: serialLive.bytesIn,
    bytesOut: serialLive.bytesOut,
  };
}

function runStty(port, baud) {
  return new Promise((resolveStty) => {
    const args =
      process.platform === "darwin"
        ? ["-f", port, String(baud), "raw", "-echo"]
        : ["-F", port, String(baud), "raw", "-echo"];
    const child = spawn("stty", args, { stdio: "ignore" });
    child.on("close", () => resolveStty());
    child.on("error", () => resolveStty());
  });
}

async function serialDisconnect() {
  if (serialLive.stream) {
    try {
      serialLive.stream.destroy();
    } catch {
      /* */
    }
    serialLive.stream = null;
  }
  if (serialLive.fd != null) {
    try {
      fs.closeSync(serialLive.fd);
    } catch {
      /* */
    }
    serialLive.fd = null;
  }
  const wasOpen = serialLive.open;
  serialLive.open = false;
  if (wasOpen) {
    notify("serial/connectionState", { open: false, port: serialLive.port });
  }
  return serialStatus();
}

async function serialConnect(params) {
  const port = String(params.port || "");
  const baud = Number(params.baud || 115200) || 115200;
  if (!port) throw new Error("serial/connect requires port");
  await serialDisconnect();

  if (process.platform === "darwin" || process.platform === "linux") {
    await runStty(port, baud);
  }

  try {
    serialLive.fd = fs.openSync(port, "r+");
  } catch (e) {
    throw new Error(`Failed to open ${port}: ${e?.message || e}`);
  }

  serialLive.stream = fs.createReadStream("", {
    fd: serialLive.fd,
    autoClose: false,
    encoding: "utf8",
    highWaterMark: 4096,
  });
  serialLive.port = port;
  serialLive.baud = baud;
  serialLive.open = true;
  serialLive.bytesIn = 0;
  serialLive.bytesOut = 0;

  serialLive.stream.on("data", (chunk) => {
    const s = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    serialLive.bytesIn += Buffer.byteLength(s);
    notify("serial/data", { data: s, port: serialLive.port });
    // Part 3: feed plot parser line-by-line
    for (const line of s.split(/\r?\n/)) {
      if (line.trim()) ingestPlotLine(line);
    }
  });
  serialLive.stream.on("error", (err) => {
    notify("serial/error", { message: String(err?.message || err), port: serialLive.port });
    void serialDisconnect();
  });
  serialLive.stream.on("close", () => {
    serialLive.open = false;
    notify("serial/connectionState", { open: false, port: serialLive.port });
  });

  notify("serial/connectionState", { open: true, port, baud });
  return serialStatus();
}

function serialSend(params) {
  if (serialLive.fd == null || !serialLive.open) {
    throw new Error("Serial not open");
  }
  let text = String(params.data ?? params.text ?? "");
  if (!text.endsWith("\n")) text += "\n";
  const buf = Buffer.from(text, "utf8");
  fs.writeSync(serialLive.fd, buf);
  serialLive.bytesOut += buf.length;
  return { ok: true, bytes: buf.length };
}

// ——— main ———

// Keep stderr free for logs; protocol on stdout only
process.stderr.write(
  `labwired-agent rpc-server ${PROTOCOL} cwd=${state.workspacePath}\n`
);

process.stdin.on("data", onData);
process.stdin.on("end", () => process.exit(0));
process.stdin.resume();
