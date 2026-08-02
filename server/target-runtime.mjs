import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep, win32 } from "node:path";
import { fileURLToPath } from "node:url";

const AGENT_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const TARGET_ID = "gate1-esp32c3";
const MARKER = "LABWIRED_OK";
const ORACLE_REF = "labwired.gate1-esp32c3/v1#uart:LABWIRED_OK";
const DEFAULT_TIMEOUT_MS = 120_000;
const MIN_TIMEOUT_MS = 25;
const MAX_TIMEOUT_MS = 600_000;
const FORCE_KILL_DELAY_MS = 500;
const SETTLE_AFTER_KILL_MS = 1_500;
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
 * accepted from a request. Simulator work happens in a private staging
 * directory; only verified, no-follow writes enter the workspace bundle.
 */
export async function runTarget(request) {
  const onState = typeof request?.onState === "function" ? request.onState : null;
  const input = await validateRequest(request);
  const run = {
    runId: randomUUID(),
    targetId: TARGET_ID,
    manifestDigest: TARGET_DIGEST,
    phase: "queued",
  };
  const script = testScript(input.fixture);
  const bundle = await createSafeBundle(input.workspacePath, run.runId);
  const bundleScriptPath = join(bundle.path, "test.yaml");
  let stagingPath = null;
  let queued = false;
  let terminal = false;

  try {
    // Prepare the durable artifact before exposing the run ID to a client.
    await writeNewFile(bundleScriptPath, script);
    stagingPath = await mkdtemp(join(tmpdir(), "labwired-target-stage-"));
    const stagingScriptPath = join(stagingPath, "test.yaml");
    await writeFile(stagingScriptPath, script, { encoding: "utf8", mode: 0o600 });

    reportState(onState, run);
    queued = true;
    transition(run, "running", onState);
    // Re-check after the event: a renderer/process must not redirect an artifact.
    await assertSafeBundle(bundle);
    await assertSafeRegularFile(bundleScriptPath);

    let runner = failedRunner("simulator did not start");
    try {
      await ensureTrustedInputs(input.fixture);
      const simulator = await resolveSimulator();
      runner = await runSimulator(simulator, stagingScriptPath, stagingPath, {
        signal: request?.signal,
        timeoutMs: targetTimeoutMs(),
      });
    } catch (error) {
      runner = failedRunner(error instanceof Error ? error.message : String(error));
    }

    const parsed = await parseRunArtifacts(stagingPath, runner);
    transition(run, "evaluating", onState);
    await assertSafeBundle(bundle);
    await assertSafeRegularFile(bundleScriptPath);
    await writeBundleFile(bundle, "run.log", runLogText(runner));
    await writeBundleFile(bundle, "result.json", parsed.resultBytes);
    await copyStagedArtifactIfPresent(stagingPath, bundle, "uart.log");
    await copyStagedArtifactIfPresent(stagingPath, bundle, "run-manifest.json");

    const result = {
      status: parsed.status,
      assertions: parsed.assertions,
      uart: parsed.uart,
      exitCode: runner.code,
    };
    const resultRef = {
      path: workspaceRelativePath(bundle.workspacePath, join(bundle.path, "result.json")),
      sha256: sha256(parsed.resultBytes),
    };

    if (!input.verify) {
      transition(run, parsed.status === "pass" ? "completed" : "failed", onState);
      terminal = true;
      return { run: clone(run), result, resultRef };
    }

    const evidence = await createEvidenceNode({
      bundle,
      run,
      status: proofStatus(parsed),
    });
    await writeBundleFile(bundle, "claim.json", `${JSON.stringify(evidence, null, 2)}\n`);
    transition(run, evidence.status === "model_verified" ? "completed" : "failed", onState);
    terminal = true;
    return { run: clone(run), result, resultRef, evidence };
  } catch (error) {
    if (queued && !terminal) {
      if (run.phase !== "evaluating" && run.phase !== "failed") transition(run, "evaluating", onState);
      if (run.phase !== "failed") transition(run, "failed", onState);
    }
    throw error;
  } finally {
    if (stagingPath) await rm(stagingPath, { recursive: true, force: true });
  }
}

async function validateRequest(request) {
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw new Error("target request must be an object");
  }
  if (typeof request.targetId !== "string" || request.targetId.length === 0) {
    throw new Error("targetId is required");
  }
  if (request.targetId !== TARGET_ID) throw new Error(`Unknown targetId: ${request.targetId}`);
  if (typeof request.manifestDigest !== "string" || request.manifestDigest.length === 0) {
    throw new Error("manifestDigest is required");
  }
  if (request.manifestDigest !== TARGET_DIGEST) {
    throw new Error("Stale manifestDigest for target gate1-esp32c3");
  }
  if (request.fixture !== "fixed" && request.fixture !== "broken") {
    throw new Error("fixture must be fixed or broken");
  }
  if (typeof request.verify !== "boolean") throw new Error("verify must be a boolean");
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
  if (!workspaceInfo.isDirectory()) throw new Error(`workspacePath must be a directory: ${workspacePath}`);
  return { fixture: request.fixture, verify: request.verify, workspacePath };
}

async function createSafeBundle(workspacePath, runId) {
  const canonicalWorkspace = await realpath(workspacePath);
  const labwiredPath = await ensureSafeDirectory(join(canonicalWorkspace, ".labwired"), canonicalWorkspace);
  const evidencePath = await ensureSafeDirectory(join(labwiredPath, "evidence"), canonicalWorkspace);
  const bundlePath = join(evidencePath, runId);
  try {
    await mkdir(bundlePath, { mode: 0o700 });
  } catch (error) {
    if (error?.code === "EEXIST") throw unsafePathError(bundlePath);
    throw error;
  }
  const info = await lstat(bundlePath);
  if (!info.isDirectory() || info.isSymbolicLink()) throw unsafePathError(bundlePath);
  const canonicalBundle = await realpath(bundlePath);
  assertPathInside(canonicalWorkspace, canonicalBundle);
  const bundle = { workspacePath: canonicalWorkspace, path: canonicalBundle };
  await assertSafeBundle(bundle);
  return bundle;
}

async function ensureSafeDirectory(path, workspacePath) {
  try {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) throw unsafePathError(path);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    await mkdir(path, { mode: 0o700 });
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) throw unsafePathError(path);
  }
  const canonicalPath = await realpath(path);
  assertPathInside(workspacePath, canonicalPath);
  return canonicalPath;
}

function assertPathInside(workspacePath, candidatePath) {
  const pathFromWorkspace = relative(workspacePath, candidatePath);
  if (pathFromWorkspace === "" || pathFromWorkspace === ".") return;
  if (pathFromWorkspace === ".." || pathFromWorkspace.startsWith(`..${sep}`) || isAbsolute(pathFromWorkspace)) {
    throw unsafePathError(candidatePath);
  }
}

async function assertSafeRegularFile(path) {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") throw unsafePathError(path);
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink()) throw unsafePathError(path);
}

async function assertSafeBundle(bundle) {
  const info = await lstat(bundle.path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw unsafePathError(bundle.path);
  const canonicalPath = await realpath(bundle.path);
  if (canonicalPath !== bundle.path) throw unsafePathError(bundle.path);
  assertPathInside(bundle.workspacePath, canonicalPath);
}

async function writeBundleFile(bundle, name, data) {
  await assertSafeBundle(bundle);
  await writeNewFile(join(bundle.path, name), data);
}

async function writeNewFile(path, data) {
  const noFollow = Number.isInteger(fsConstants.O_NOFOLLOW) ? fsConstants.O_NOFOLLOW : 0;
  const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow;
  let handle;
  try {
    handle = await open(path, flags, 0o600);
    await handle.writeFile(data, "utf8");
  } catch (error) {
    if (error?.code === "EEXIST" || error?.code === "ELOOP") throw unsafePathError(path);
    throw error;
  } finally {
    await handle?.close();
  }
}

async function copyStagedArtifactIfPresent(stagingPath, bundle, name) {
  const sourcePath = join(stagingPath, name);
  let info;
  try {
    info = await lstat(sourcePath);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink()) throw unsafePathError(sourcePath);
  await writeBundleFile(bundle, name, await readFile(sourcePath));
  return true;
}

function unsafePathError(path) {
  return new Error(`unsafe artifact path (symlink or unexpected file): ${path}`);
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

function failedRunner(error) {
  return { code: 1, stdout: "", stderr: "", error, timedOut: false, aborted: false };
}

function runLogText(runner) {
  return [
    runner.stdout,
    runner.stderr,
    runner.error ? `error: ${runner.error}\n` : "",
    runner.timedOut ? "error: simulator timed out\n" : "",
    runner.aborted ? "error: simulator cancelled\n" : "",
  ]
    .filter(Boolean)
    .join(runner.stdout && (runner.stderr || runner.error || runner.timedOut || runner.aborted) ? "\n" : "");
}

async function parseRunArtifacts(stagingPath, runner) {
  const resultPath = join(stagingPath, "result.json");
  let resultBytes = "";
  let raw = null;
  let fallbackReason = runner.error || "";
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
  }
  if (raw.status !== "pass" || runner.code !== 0 || runner.timedOut || runner.aborted) {
    raw = {
      ...raw,
      status: "failed",
      error:
        raw.error ||
        runner.error ||
        (runner.timedOut
          ? "simulator timed out"
          : runner.aborted
            ? "simulator cancelled"
            : runner.code !== 0
              ? `simulator exited with code ${runner.code}`
              : "simulator did not report status pass"),
      exitCode: runner.code,
    };
  }
  resultBytes = `${JSON.stringify(raw, null, 2)}\n`;

  let uart = "";
  try {
    const uartInfo = await lstat(join(stagingPath, "uart.log"));
    if (uartInfo.isFile() && !uartInfo.isSymbolicLink()) {
      uart = await readFile(join(stagingPath, "uart.log"), "utf8");
    }
  } catch {
    // A failed runner can omit UART output; the failed result remains durable.
  }
  return {
    resultBytes,
    assertions: normalizeAssertions(raw),
    uart,
    status: raw.status === "pass" && runner.code === 0 && !runner.timedOut && !runner.aborted ? "pass" : "failed",
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

async function createEvidenceNode({ bundle, run, status }) {
  await assertSafeBundle(bundle);
  const artifactFiles = ["test.yaml", "result.json"];
  for (const file of ["uart.log", "run-manifest.json"]) {
    if (await safeRegularFileExists(join(bundle.path, file))) artifactFiles.push(file);
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
    artifactRefs: artifactFiles.map((file) => workspaceRelativePath(bundle.workspacePath, join(bundle.path, file))),
    ts: new Date().toISOString(),
  };
}

async function safeRegularFileExists(path) {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw unsafePathError(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function workspaceRelativePath(workspacePath, artifactPath) {
  const artifactRef = relative(workspacePath, artifactPath).split(sep).join("/");
  if (!artifactRef || artifactRef === ".." || artifactRef.startsWith("../") || isAbsolute(artifactRef)) {
    throw unsafePathError(artifactPath);
  }
  return artifactRef;
}

function targetTimeoutMs(env = process.env) {
  const configured = Number(env.LABWIRED_TARGET_TIMEOUT_MS);
  if (!Number.isFinite(configured) || configured <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.trunc(configured)));
}

/** Exposed for platform-independent Windows-prefix coverage. */
export function simulatorCandidates({
  prefixHome = process.env.LABWIRED_HOME || join(homedir(), ".labwired"),
  platform = process.platform,
  env = process.env,
} = {}) {
  const pathApi = platform === "win32" ? win32 : { join };
  const suffixes = platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  const prefixBases = [
    pathApi.join(prefixHome, "tools", "sim", "labwired-sim"),
    pathApi.join(prefixHome, "bin", "labwired-sim"),
  ];
  return [
    env.LABWIRED_CLI,
    env.LABWIRED_SIM,
    ...prefixBases.flatMap((base) => suffixes.map((suffix) => `${base}${suffix}`)),
    "labwired-sim",
    "labwired-cli",
    "labwired",
  ].filter(Boolean);
}

async function resolveSimulator() {
  for (const candidate of simulatorCandidates()) {
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
    (await safePathExists(join(candidateRoot, "lib", "resolve-sim.sh"))) &&
    ((await safePathExists(join(candidateRoot, "branding", "banner.txt"))) ||
      (await safePathExists(join(candidateRoot, "skills"))))
  );
}

async function safePathExists(path) {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
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

function runSimulator(simulator, scriptPath, outputDir, { signal, timeoutMs } = {}) {
  const args = [
    "test",
    "--script",
    scriptPath,
    "--output-dir",
    outputDir,
    "--no-uart-stdout",
    "--run-manifest",
  ];
  return new Promise((resolveRun) => {
    const child = spawnSimulatorProcess(simulator, args);
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let aborted = false;
    let forceKillTimer = null;
    let settleTimer = null;
    const finish = (code, error = "") => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      clearTimeout(forceKillTimer);
      clearTimeout(settleTimer);
      signal?.removeEventListener("abort", onAbort);
      resolveRun({
        code: timedOut ? 124 : aborted ? 130 : code ?? 1,
        stdout,
        stderr,
        error,
        timedOut,
        aborted,
      });
    };
    const stop = (reason) => {
      if (settled) return;
      if (reason === "timeout") timedOut = true;
      else aborted = true;
      terminateSimulatorProcess(child, "SIGTERM");
      forceKillTimer = setTimeout(() => terminateSimulatorProcess(child, "SIGKILL"), FORCE_KILL_DELAY_MS);
      settleTimer = setTimeout(() => finish(reason === "timeout" ? 124 : 130, `simulator ${reason}`), SETTLE_AFTER_KILL_MS);
    };
    const onAbort = () => stop("cancelled");
    const timeoutTimer = setTimeout(() => stop("timeout"), timeoutMs || targetTimeoutMs());
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.once("error", (error) => finish(1, error instanceof Error ? error.message : String(error)));
    child.once("close", (code) => finish(code));
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function spawnSimulatorProcess(simulator, args) {
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(simulator)) {
    const command = [simulator, ...args].map(quoteWindowsCommandPart).join(" ");
    return spawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", command], {
      cwd: AGENT_ROOT,
      detached: false,
      shell: false,
      windowsHide: true,
    });
  }
  return spawn(simulator, args, {
    cwd: AGENT_ROOT,
    detached: process.platform !== "win32",
    shell: false,
    windowsHide: true,
  });
}

function terminateSimulatorProcess(child, signal) {
  if (!child?.pid) return;
  if (process.platform === "win32") {
    try {
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      return;
    } catch {
      // Fall back to the direct child below.
    }
  } else {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // The child can exit between the pid check and the group kill.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // Already gone.
  }
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
