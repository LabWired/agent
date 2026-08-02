import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const AGENT_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const TARGET_ID = "gate1-esp32c3";
const MARKER = "LABWIRED_OK";
const FIXTURES = Object.freeze({
  fixed: join(AGENT_ROOT, "fixtures", "gate1-live", "firmware", "gate1-fixed.elf"),
  broken: join(AGENT_ROOT, "fixtures", "gate1-live", "firmware", "gate1-broken.elf"),
});
const SYSTEM_PATH = join(AGENT_ROOT, "share", "catalog", "systems", "esp32c3.yaml");

const MANIFEST_BODY = Object.freeze({
  schemaVersion: 1,
  manifestId: "labwired.gate1-esp32c3/v1",
  targetId: TARGET_ID,
  kind: "virtual",
  chip: "esp32c3",
  platform: {
    cpu: { id: "cpu", model: "ESP32-C3", architecture: "riscv32" },
    uart: { id: "uart0", model: "UART0" },
  },
  graph: {
    nodes: [
      { id: "cpu", type: "cpu", model: "ESP32-C3" },
      { id: "uart0", type: "uart", model: "UART0" },
      { id: "oracle", type: "oracle", marker: MARKER },
    ],
    edges: [
      { from: "cpu", to: "uart0" },
      { from: "uart0", to: "oracle" },
    ],
  },
  capabilities: ["run", "verify"],
});

const MANIFEST_DIGEST = `sha256:${sha256(canonicalJson(MANIFEST_BODY))}`;
const TARGET_MANIFEST = Object.freeze({ ...MANIFEST_BODY, manifestDigest: MANIFEST_DIGEST });

/** Return the agent-owned virtual targets without exposing mutable runtime state. */
export function listTargets() {
  return [clone(TARGET_MANIFEST)];
}

/**
 * Run the fixed Gate1 virtual target. The only selectable input is the bundled
 * red/green fixture; callers cannot supply an arbitrary ELF or system file.
 */
export async function runTarget(request) {
  const onState = typeof request?.onState === "function" ? request.onState : null;
  const input = await validateRequest(request);
  const runId = randomUUID();
  const run = {
    runId,
    targetId: TARGET_ID,
    manifestDigest: MANIFEST_DIGEST,
    fixture: input.fixture,
    verify: input.verify,
    state: "terminal",
  };
  const evidenceDir = input.verify
    ? join(input.workspacePath, ".labwired", "evidence", runId)
    : null;
  const outputDir = evidenceDir || (await mkdtemp(join(tmpdir(), "labwired-target-run-")));
  const scriptPath = join(outputDir, "test.yaml");
  let removeTemporaryOutput = !evidenceDir;
  let terminalReported = false;

  reportState(onState, run, "queued");

  try {
    await mkdir(outputDir, { recursive: true });
    await ensureTrustedInputs();
    await writeFile(scriptPath, testScript(input.fixture), "utf8");

    const simulator = await resolveSimulator();
    reportState(onState, run, "running");
    const runner = await runSimulator(simulator, scriptPath, outputDir);
    await writeFile(
      join(outputDir, "run.log"),
      [runner.stdout, runner.stderr].filter(Boolean).join(runner.stdout && runner.stderr ? "\n" : ""),
      "utf8",
    );

    const parsed = await parseOutput(outputDir, runner);
    const status = input.verify
      ? verifiedStatus(parsed)
      : parsed.simulationPassed
        ? "passed"
        : "failed";
    const result = {
      status,
      simulationStatus: parsed.simulationStatus,
      assertions: parsed.assertions,
      uart: parsed.uart,
      exitCode: runner.code,
      stderr: runner.stderr,
      raw: parsed.raw,
    };
    const resultRef = `sha256:${sha256(parsed.resultBytes)}`;
    if (!evidenceDir) {
      const response = { run, result, resultRef, evidence: null };
      reportState(onState, run, "terminal", { status });
      terminalReported = true;
      return response;
    }

    const claim = {
      schemaVersion: 1,
      type: "twin",
      status,
      targetId: TARGET_ID,
      manifestId: TARGET_MANIFEST.manifestId,
      manifestDigest: MANIFEST_DIGEST,
      runId,
      fixture: input.fixture,
      resultRef,
      simulationStatus: parsed.simulationStatus,
      assertions: parsed.assertions,
      marker: MARKER,
      markerObserved: parsed.uart.includes(MARKER),
    };
    await writeFile(join(evidenceDir, "claim.json"), `${JSON.stringify(claim, null, 2)}\n`, "utf8");
    const response = {
      run,
      result,
      resultRef,
      evidence: {
        type: "twin",
        status,
        path: evidenceDir,
        claim,
      },
    };
    reportState(onState, run, "terminal", { status });
    terminalReported = true;
    return response;
  } catch (error) {
    if (!terminalReported) {
      reportState(onState, run, "terminal", {
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
    }
    throw error;
  } finally {
    if (removeTemporaryOutput) {
      await rm(outputDir, { recursive: true, force: true });
    }
  }
}

function reportState(callback, run, state, extra = {}) {
  if (!callback) return;
  callback({
    runId: run.runId,
    targetId: run.targetId,
    fixture: run.fixture,
    verify: run.verify,
    state,
    ...extra,
  });
}

async function validateRequest(request) {
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw new Error("target request must be an object");
  }
  if (typeof request.targetId !== "string" || request.targetId.length === 0) {
    throw new Error("targetId is required");
  }
  if (request.targetId !== TARGET_ID) {
    throw new Error(`Unknown targetId: ${request.targetId}`);
  }
  if (typeof request.manifestDigest !== "string" || request.manifestDigest.length === 0) {
    throw new Error("manifestDigest is required");
  }
  if (request.manifestDigest !== MANIFEST_DIGEST) {
    throw new Error("Stale manifestDigest for target gate1-esp32c3");
  }
  if (request.fixture !== "fixed" && request.fixture !== "broken") {
    throw new Error("fixture must be fixed or broken");
  }
  if (typeof request.verify !== "boolean") {
    throw new Error("verify must be a boolean");
  }
  if (typeof request.workspacePath !== "string" || !isAbsolute(request.workspacePath)) {
    throw new Error("workspacePath must be an absolute path");
  }
  const workspacePath = resolve(request.workspacePath);
  let workspaceInfo;
  try {
    workspaceInfo = await stat(workspacePath);
  } catch {
    throw new Error(`workspacePath does not exist: ${workspacePath}`);
  }
  if (!workspaceInfo.isDirectory()) {
    throw new Error(`workspacePath must be a directory: ${workspacePath}`);
  }
  return {
    fixture: request.fixture,
    verify: request.verify,
    workspacePath,
  };
}

async function ensureTrustedInputs() {
  await Promise.all([
    access(FIXTURES.fixed, fsConstants.R_OK),
    access(FIXTURES.broken, fsConstants.R_OK),
    access(SYSTEM_PATH, fsConstants.R_OK),
  ]);
}

function testScript(fixture) {
  return [
    'schema_version: "1.0"',
    "inputs:",
    `  firmware: ${JSON.stringify(FIXTURES[fixture])}`,
    `  system: ${JSON.stringify(SYSTEM_PATH)}`,
    "limits:",
    "  max_steps: 5000000",
    "  stop_when_assertions_pass: true",
    "assertions:",
    `  - uart_contains: ${JSON.stringify(MARKER)}`,
    "",
  ].join("\n");
}

async function resolveSimulator() {
  const configured = [process.env.LABWIRED_CLI, process.env.LABWIRED_SIM].filter(Boolean);
  for (const candidate of configured) {
    if (await executable(candidate)) return candidate;
  }
  const local = join(process.env.HOME || "", ".labwired", "tools", "sim", "labwired-sim");
  if (await executable(local)) return local;
  for (const name of ["labwired-sim", "labwired-cli"]) {
    const onPath = await resolveCommand(name);
    if (onPath) return onPath;
  }
  throw new Error("labwired-sim not found; set LABWIRED_SIM or install the simulator");
}

async function executable(path) {
  try {
    await access(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function resolveCommand(name) {
  const pathEntries = String(process.env.PATH || "").split(process.platform === "win32" ? ";" : ":");
  const suffixes = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  for (const directory of pathEntries) {
    for (const suffix of suffixes) {
      const candidate = join(directory || ".", `${name}${suffix}`);
      if (await executable(candidate)) return candidate;
    }
  }
  return null;
}

function runSimulator(simulator, scriptPath, outputDir) {
  const args = [
    "test",
    "--script",
    scriptPath,
    "--output-dir",
    outputDir,
    "--no-uart-stdout",
    "--run-manifest",
  ];
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(simulator, args, { cwd: AGENT_ROOT, shell: false });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.once("error", rejectRun);
    child.once("close", (code) => {
      resolveRun({ code: code ?? 1, stdout, stderr });
    });
  });
}

async function parseOutput(outputDir, runner) {
  const resultPath = join(outputDir, "result.json");
  const uartPath = join(outputDir, "uart.log");
  let resultBytes = "";
  let raw = null;
  let parseError = null;
  try {
    resultBytes = await readFile(resultPath, "utf8");
    raw = JSON.parse(resultBytes);
  } catch (error) {
    parseError = error instanceof Error ? error.message : String(error);
  }
  let uart = "";
  try {
    uart = await readFile(uartPath, "utf8");
  } catch {
    // A failed runner can omit UART output. This is evidence of a failed claim.
  }
  const assertions = normalizeAssertions(raw);
  const simulationStatus = simulationStatusOf(raw);
  return {
    raw,
    assertions,
    uart,
    resultBytes: resultBytes || canonicalJson({ simulationStatus, parseError, stderr: runner.stderr }),
    simulationStatus,
    simulationPassed: simulationStatus === "pass",
  };
}

function normalizeAssertions(raw) {
  const source = Array.isArray(raw?.assertions)
    ? raw.assertions
    : Array.isArray(raw?.oracle_results)
      ? raw.oracle_results
      : [];
  return source.map((assertion, index) => ({
    ...assertion,
    id: assertion?.id || assertion?.name || `assertion-${index + 1}`,
    passed: assertion?.passed === true,
  }));
}

function simulationStatusOf(raw) {
  if (raw?.status === "pass" || raw?.status === "passed" || raw?.passed === true) return "pass";
  if (raw?.status === "failed" || raw?.status === "fail" || raw?.passed === false) return "failed";
  return "failed";
}

function verifiedStatus(parsed) {
  const assertionsPassed =
    parsed.assertions.length > 0 && parsed.assertions.every((assertion) => assertion.passed === true);
  return parsed.simulationPassed && assertionsPassed && parsed.uart.includes(MARKER)
    ? "model_verified"
    : "failed";
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}
