import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, mkdir, open, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const AGENT_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const TARGET_ID = "gate1-esp32c3";
const MARKER = "LABWIRED_OK";
const ORACLE_REF = "labwired.gate1-esp32c3/v1#uart:LABWIRED_OK";
const FIXTURES = Object.freeze({
  fixed: join(AGENT_ROOT, "fixtures", "gate1-live", "firmware", "gate1-fixed.elf"),
  broken: join(AGENT_ROOT, "fixtures", "gate1-live", "firmware", "gate1-broken.elf"),
});
const SYSTEM_PATH = join(AGENT_ROOT, "share", "catalog", "systems", "esp32c3.yaml");

const MANIFEST_BODY = Object.freeze({
  schemaVersion: 1,
  targetId: TARGET_ID,
  manifestId: "labwired.gate1-esp32c3/v1",
  displayName: "ESP32-C3 Gate1 UART proof",
  kind: "virtual",
  chip: "esp32c3",
  graph: {
    nodes: [
      { id: "cpu", kind: "cpu", label: "ESP32-C3 CPU" },
      { id: "uart0", kind: "uart", label: "UART0" },
      { id: "oracle", kind: "oracle", label: "LABWIRED_OK oracle" },
    ],
    edges: [
      { from: "cpu", to: "uart0" },
      { from: "uart0", to: "oracle" },
    ],
  },
  capabilities: ["run", "verify"],
});

const TARGET_DIGEST = sha256(canonicalJson(MANIFEST_BODY));
const TARGET_MANIFEST = Object.freeze({ ...MANIFEST_BODY, digest: TARGET_DIGEST });

/** Return immutable-on-the-wire target manifest copies. */
export function listTargets() {
  return [clone(TARGET_MANIFEST)];
}

/**
 * Run a bundled Gate1 fixture against the bundled ESP32-C3 system. Callers can
 * choose only the fixed/broken fixture; neither firmware nor system paths are
 * accepted from a request.
 */
export async function runTarget(request) {
  const onState = typeof request?.onState === "function" ? request.onState : null;
  const input = await validateRequest(request);
  const runId = randomUUID();
  const run = {
    runId,
    targetId: TARGET_ID,
    manifestDigest: TARGET_DIGEST,
    phase: "queued",
  };
  const bundleDir = join(input.workspacePath, ".labwired", "evidence", runId);
  const scriptPath = join(bundleDir, "test.yaml");
  const runLogPath = join(bundleDir, "run.log");

  await mkdir(bundleDir, { recursive: true });
  reportState(onState, run);
  await writeFile(scriptPath, testScript(input.fixture), "utf8");

  let runner = { code: 1, stdout: "", stderr: "" };
  let runnerError = null;
  try {
    await ensureTrustedInputs(input.fixture);
    const simulator = await resolveSimulator();
    transition(run, "running", onState);
    runner = await runSimulator(simulator, scriptPath, bundleDir);
  } catch (error) {
    runnerError = error instanceof Error ? error.message : String(error);
  }
  await writeFile(runLogPath, runLogText(runner, runnerError), "utf8");

  const parsed = await parseRunArtifacts(bundleDir, runner, runnerError);
  transition(run, "evaluating", onState);
  const result = {
    status: parsed.status,
    assertions: parsed.assertions,
    uart: parsed.uart,
    exitCode: runner.code,
  };
  const resultRef = {
    path: workspaceRelativePath(input.workspacePath, join(bundleDir, "result.json")),
    sha256: sha256(parsed.resultBytes),
  };

  if (!input.verify) {
    transition(run, parsed.status === "pass" ? "completed" : "failed", onState);
    return { run: clone(run), result, resultRef };
  }

  const evidence = await createEvidenceNode({
    bundleDir,
    workspacePath: input.workspacePath,
    run,
    status: proofStatus(parsed),
  });
  await writeFile(join(bundleDir, "claim.json"), `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  transition(run, evidence.status === "model_verified" ? "completed" : "failed", onState);
  return { run: clone(run), result, resultRef, evidence };
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
  if (request.manifestDigest !== TARGET_DIGEST) {
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
  return { fixture: request.fixture, verify: request.verify, workspacePath };
}

function transition(run, phase, onState) {
  run.phase = phase;
  reportState(onState, run);
}

function reportState(onState, run) {
  if (onState) onState(clone(run));
}

async function ensureTrustedInputs(fixture) {
  await Promise.all([
    access(FIXTURES[fixture], fsConstants.R_OK),
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

function runLogText(runner, runnerError) {
  return [runner.stdout, runner.stderr, runnerError ? `error: ${runnerError}\n` : ""]
    .filter(Boolean)
    .join(runner.stdout && (runner.stderr || runnerError) ? "\n" : "");
}

async function parseRunArtifacts(bundleDir, runner, runnerError) {
  const resultPath = join(bundleDir, "result.json");
  let resultBytes = "";
  let raw = null;
  let fallbackReason = runnerError;
  try {
    resultBytes = await readFile(resultPath, "utf8");
    raw = JSON.parse(resultBytes);
  } catch (error) {
    fallbackReason ||= error instanceof Error ? error.message : String(error);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    raw = {
      status: "failed",
      assertions: [],
      error: fallbackReason || "simulator omitted a structured result.json",
      exitCode: runner.code,
    };
    resultBytes = `${JSON.stringify(raw, null, 2)}\n`;
    await writeFile(resultPath, resultBytes, "utf8");
  }

  let uart = "";
  try {
    uart = await readFile(join(bundleDir, "uart.log"), "utf8");
  } catch {
    // The runner may fail before UART begins; retain the durable result artifact.
  }
  return {
    raw,
    resultBytes,
    assertions: normalizeAssertions(raw),
    uart,
    status: raw.status === "pass" ? "pass" : "failed",
  };
}

function normalizeAssertions(raw) {
  const assertions = Array.isArray(raw.assertions)
    ? raw.assertions
    : Array.isArray(raw.oracle_results)
      ? raw.oracle_results
      : [];
  return assertions.map((assertion, index) => ({
    ...assertion,
    id: assertion?.id || assertion?.name || `assertion-${index + 1}`,
    passed: assertion?.passed === true,
  }));
}

function proofStatus(parsed) {
  const allAssertionsPassed =
    parsed.assertions.length > 0 && parsed.assertions.every((assertion) => assertion.passed === true);
  return parsed.status === "pass" && allAssertionsPassed && parsed.uart.includes(MARKER)
    ? "model_verified"
    : "failed";
}

async function createEvidenceNode({ bundleDir, workspacePath, run, status }) {
  const artifactFiles = ["test.yaml", "result.json"];
  for (const file of ["uart.log", "run-manifest.json"]) {
    if (await fileExists(join(bundleDir, file))) artifactFiles.push(file);
  }
  artifactFiles.push("run.log", "claim.json");
  return {
    evidenceId: `evidence-${run.runId}`,
    parentIds: [],
    runId: run.runId,
    targetId: run.targetId,
    path: "twin",
    status,
    tool: "target/verify",
    oracleRef: ORACLE_REF,
    artifactRefs: artifactFiles.map((file) => workspaceRelativePath(workspacePath, join(bundleDir, file))),
    ts: new Date().toISOString(),
  };
}

function workspaceRelativePath(workspacePath, artifactPath) {
  const artifactRef = relative(workspacePath, artifactPath).split(sep).join("/");
  if (!artifactRef || artifactRef === ".." || artifactRef.startsWith("../")) {
    throw new Error("artifact path escaped workspace");
  }
  return artifactRef;
}

async function fileExists(path) {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function resolveSimulator() {
  const prefixHome = process.env.LABWIRED_HOME || join(homedir(), ".labwired");
  const candidates = [
    process.env.LABWIRED_CLI,
    process.env.LABWIRED_SIM,
    join(prefixHome, "tools", "sim", "labwired-sim"),
    join(prefixHome, "bin", "labwired-sim"),
    "labwired-sim",
    "labwired-cli",
    "labwired",
  ].filter(Boolean);
  for (const candidate of candidates) {
    const executablePath = await resolveExecutable(candidate);
    if (!executablePath || (await isAgentLauncher(executablePath))) continue;
    return executablePath;
  }
  throw new Error("labwired-sim not found; set LABWIRED_SIM or install the simulator");
}

async function resolveExecutable(candidate) {
  const looksLikePath = candidate.includes("/") || candidate.includes("\\") || isAbsolute(candidate);
  if (looksLikePath) {
    const absolutePath = resolve(candidate);
    return (await executable(absolutePath)) ? absolutePath : null;
  }
  return resolveCommand(candidate);
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

async function isAgentLauncher(executablePath) {
  const normalized = resolve(executablePath);
  if (normalized === join(AGENT_ROOT, "bin", "labwired")) return true;
  if (normalized.includes(`${sep}.labwired${sep}agent${sep}`)) return true;
  const head = await readHead(executablePath);
  if (/LABWIRED_AGENT_HOME|Firmware Agent|opencode-ai|OpenCode shell/.test(head)) return true;
  const candidateRoot = resolve(dirname(executablePath), "..");
  return (
    (await fileExists(join(candidateRoot, "lib", "resolve-sim.sh"))) &&
    ((await fileExists(join(candidateRoot, "branding", "banner.txt"))) ||
      (await fileExists(join(candidateRoot, "skills"))))
  );
}

async function readHead(path) {
  try {
    const handle = await open(path, "r");
    try {
      const buffer = Buffer.alloc(4096);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      return buffer.subarray(0, bytesRead).toString("utf8");
    } finally {
      await handle.close();
    }
  } catch {
    return "";
  }
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
    const child = spawnSimulatorProcess(simulator, args);
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

function spawnSimulatorProcess(simulator, args) {
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(simulator)) {
    const command = [simulator, ...args].map(quoteWindowsCommandPart).join(" ");
    return spawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", command], {
      cwd: AGENT_ROOT,
      shell: false,
    });
  }
  return spawn(simulator, args, { cwd: AGENT_ROOT, shell: false });
}

function quoteWindowsCommandPart(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
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
