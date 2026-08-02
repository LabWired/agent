import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";

import { listTargets, runTarget } from "../server/target-runtime.mjs";

const REPOSITORY_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const ORACLE_REF = "labwired.gate1-esp32c3/v1#uart:LABWIRED_OK";
const originalSimulatorEnv = {
  LABWIRED_CLI: process.env.LABWIRED_CLI,
  LABWIRED_SIM: process.env.LABWIRED_SIM,
};

let fakeRoot = "";
let fakeSimulator = "";
let fakeSimulatorProgram = "";

function setEnv(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

async function withEnv(values, action) {
  const beforeValues = Object.fromEntries(Object.keys(values).map((name) => [name, process.env[name]]));
  try {
    for (const [name, value] of Object.entries(values)) setEnv(name, value);
    return await action();
  } finally {
    for (const [name, value] of Object.entries(beforeValues)) setEnv(name, value);
  }
}

async function workspace(label) {
  return mkdtemp(join(tmpdir(), `labwired-target-${label}-`));
}

async function evidenceRunIds(workdir) {
  try {
    return (await readdir(join(workdir, ".labwired", "evidence"))).sort();
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

function evidenceDirectory(workdir, run) {
  return join(workdir, ".labwired", "evidence", run.runId);
}

function relativeEvidencePath(run, file) {
  return `.labwired/evidence/${run.runId}/${file}`;
}

async function assertDurableRunBundle(workdir, response, { claim = false } = {}) {
  const directory = evidenceDirectory(workdir, response.run);
  const required = ["test.yaml", "result.json", "uart.log", "run-manifest.json", "run.log"];
  if (claim) required.push("claim.json");
  for (const file of required) {
    assert.equal(existsSync(join(directory, file)), true, `${file} should persist in the run bundle`);
  }
  assert.deepEqual(response.resultRef, {
    path: relativeEvidencePath(response.run, "result.json"),
    sha256: response.resultRef.sha256,
  });
  assert.match(response.resultRef.sha256, /^[a-f0-9]{64}$/);
  assert.equal(isAbsolute(response.resultRef.path), false);
  return directory;
}

function startRpcServer() {
  const child = spawn(process.execPath, ["server/rpc-server.mjs"], {
    cwd: REPOSITORY_ROOT,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const messages = [];
  let buffer = Buffer.alloc(0);
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;
      const header = buffer.subarray(0, headerEnd).toString("ascii");
      const length = /content-length:\s*(\d+)/i.exec(header);
      if (!length) {
        buffer = buffer.subarray(headerEnd + 4);
        continue;
      }
      const bodyStart = headerEnd + 4;
      const bodyEnd = bodyStart + Number(length[1]);
      if (buffer.length < bodyEnd) return;
      messages.push(JSON.parse(buffer.subarray(bodyStart, bodyEnd).toString("utf8")));
      buffer = buffer.subarray(bodyEnd);
    }
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  return {
    child,
    messages,
    async request(id, method, params) {
      const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, method, params }), "utf8");
      child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
      child.stdin.write(body);
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const response = messages.find((message) => message.id === id);
        if (response) return response;
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
      }
      throw new Error(`timed out waiting for RPC ${method}: ${stderr}`);
    },
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGTERM");
      await new Promise((resolveStop) => {
        const timer = setTimeout(resolveStop, 1_000);
        child.once("exit", () => {
          clearTimeout(timer);
          resolveStop();
        });
      });
    },
  };
}

function stateNotifications(messages, start) {
  return messages.slice(start).filter((message) => message.method === "target/runState");
}

before(async () => {
  fakeRoot = await mkdtemp(join(tmpdir(), "labwired-target-fake-sim-"));
  fakeSimulatorProgram = join(fakeRoot, "labwired-sim.mjs");
  await writeFile(
    fakeSimulatorProgram,
    `#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";

const args = process.argv.slice(2);
const valueAfter = (flag) => args[args.indexOf(flag) + 1] || "";
const outputDir = valueAfter("--output-dir");
const scriptPath = valueAfter("--script");
const script = await readFile(scriptPath, "utf8");
const mode = process.env.LABWIRED_TARGET_TEST_RESULT_MODE || "";
let result = "";
let uart = "LABWIRED_OK";
if (mode === "status-passed") {
  result = '{"status":"passed","assertions":[{"id":"uart-marker","passed":true}]}';
} else if (mode === "bare-passed") {
  result = '{"passed":true,"assertions":[{"id":"uart-marker","passed":true}]}';
} else if (mode === "omit-result") {
  result = "";
} else if (script.includes("gate1-fixed.elf")) {
  result = '{"status":"pass","assertions":[{"id":"uart-marker","passed":true}]}';
} else {
  result = '{"status":"failed","assertions":[{"id":"uart-marker","passed":false}]}';
  uart = "BOOT";
}
await mkdir(outputDir, { recursive: true });
if (result) await writeFile(outputDir + "/result.json", result + "\\n", "utf8");
await writeFile(outputDir + "/uart.log", uart + "\\n", "utf8");
await writeFile(outputDir + "/run-manifest.json", '{"runner":"fake"}\\n', "utf8");
console.log("fake labwired-sim run");
`,
    "utf8",
  );
  if (process.platform === "win32") {
    fakeSimulator = join(fakeRoot, "labwired-sim.cmd");
    await writeFile(
      fakeSimulator,
      `@echo off\r\n"${process.execPath}" "${fakeSimulatorProgram}" %*\r\n`,
      "utf8",
    );
  } else {
    fakeSimulator = fakeSimulatorProgram;
    await chmod(fakeSimulator, 0o755);
  }
  setEnv("LABWIRED_CLI", fakeSimulator);
  setEnv("LABWIRED_SIM", undefined);
});

after(async () => {
  setEnv("LABWIRED_CLI", originalSimulatorEnv.LABWIRED_CLI);
  setEnv("LABWIRED_SIM", originalSimulatorEnv.LABWIRED_SIM);
  await rm(fakeRoot, { recursive: true, force: true });
});

test("published Gate1 target is the approved digest wire contract", () => {
  const [target] = listTargets();
  const [again] = listTargets();

  assert.deepEqual(Object.keys(target).sort(), [
    "capabilities",
    "chip",
    "digest",
    "displayName",
    "graph",
    "kind",
    "manifestId",
    "schemaVersion",
    "targetId",
  ]);
  assert.equal(target.schemaVersion, 1);
  assert.equal(target.targetId, "gate1-esp32c3");
  assert.equal(target.manifestId, "labwired.gate1-esp32c3/v1");
  assert.equal(target.displayName, "ESP32-C3 Gate1 UART proof");
  assert.equal(target.kind, "virtual");
  assert.equal(target.chip, "esp32c3");
  assert.match(target.digest, /^[a-f0-9]{64}$/);
  assert.equal(target.digest, again.digest);
  assert.equal("manifestDigest" in target, false);
  assert.deepEqual(target.capabilities, ["run", "verify"]);
  assert.deepEqual(target.graph.edges, [
    { from: "cpu", to: "uart0" },
    { from: "uart0", to: "oracle" },
  ]);
  assert.deepEqual(
    target.graph.nodes.map((node) => Object.keys(node).sort()),
    [
      ["id", "kind", "label"],
      ["id", "kind", "label"],
      ["id", "kind", "label"],
    ],
  );
  assert.deepEqual(
    target.graph.nodes.map((node) => [node.id, node.kind]),
    [
      ["cpu", "cpu"],
      ["uart0", "uart"],
      ["oracle", "oracle"],
    ],
  );
});

test("runTarget validates the request digest and workspace before starting a run", async () => {
  const [target] = listTargets();
  const workdir = await workspace("validation");
  try {
    await assert.rejects(
      runTarget({
        targetId: "unknown-target",
        manifestDigest: target.digest,
        fixture: "fixed",
        verify: false,
        workspacePath: workdir,
      }),
      /unknown targetId/i,
    );
    await assert.rejects(
      runTarget({
        targetId: target.targetId,
        fixture: "fixed",
        verify: false,
        workspacePath: workdir,
      }),
      /manifestDigest.*required/i,
    );
    await assert.rejects(
      runTarget({
        targetId: target.targetId,
        manifestDigest: `sha256:${target.digest}`,
        fixture: "fixed",
        verify: false,
        workspacePath: workdir,
      }),
      /stale manifestDigest/i,
    );
    await assert.rejects(
      runTarget({
        targetId: target.targetId,
        manifestDigest: target.digest,
        fixture: "other",
        verify: false,
        workspacePath: workdir,
      }),
      /fixture.*fixed.*broken/i,
    );
    await assert.rejects(
      runTarget({
        targetId: target.targetId,
        manifestDigest: target.digest,
        fixture: "fixed",
        verify: false,
        workspacePath: "relative-workspace",
      }),
      /workspacePath.*absolute/i,
    );
  } finally {
    await rm(workdir, { recursive: true, force: true });
  }
});

test("ordinary runs persist a bundle but omit proof evidence", async () => {
  const [target] = listTargets();
  const workdir = await workspace("ordinary");
  try {
    const response = await runTarget({
      targetId: target.targetId,
      manifestDigest: target.digest,
      fixture: "fixed",
      verify: false,
      workspacePath: workdir,
    });

    assert.deepEqual(Object.keys(response).sort(), ["result", "resultRef", "run"]);
    assert.equal(response.run.manifestDigest, target.digest);
    assert.equal(response.run.phase, "completed");
    assert.equal(response.result.status, "pass");
    await assertDurableRunBundle(workdir, response);
  } finally {
    await rm(workdir, { recursive: true, force: true });
  }
});

test("verification returns an immutable typed twin EvidenceNode", async () => {
  const [target] = listTargets();
  const workdir = await workspace("verify");
  try {
    const response = await runTarget({
      targetId: target.targetId,
      manifestDigest: target.digest,
      fixture: "fixed",
      verify: true,
      workspacePath: workdir,
    });
    const directory = await assertDurableRunBundle(workdir, response, { claim: true });
    const expectedRefs = [
      "test.yaml",
      "result.json",
      "uart.log",
      "run-manifest.json",
      "run.log",
      "claim.json",
    ].map((file) => relativeEvidencePath(response.run, file));

    assert.equal(response.run.phase, "completed");
    assert.equal(response.result.status, "pass");
    assert.equal(response.evidence.evidenceId.startsWith("evidence-"), true);
    assert.deepEqual(response.evidence.parentIds, []);
    assert.equal(response.evidence.runId, response.run.runId);
    assert.equal(response.evidence.targetId, target.targetId);
    assert.equal(response.evidence.path, "twin");
    assert.equal(response.evidence.status, "model_verified");
    assert.equal(response.evidence.tool, "target/verify");
    assert.equal(response.evidence.oracleRef, ORACLE_REF);
    assert.deepEqual(response.evidence.artifactRefs, expectedRefs);
    assert.equal(Number.isNaN(Date.parse(response.evidence.ts)), false);
    assert.deepEqual(
      JSON.parse(await readFile(join(directory, "claim.json"), "utf8")),
      response.evidence,
    );
  } finally {
    await rm(workdir, { recursive: true, force: true });
  }
});

test("failed observations keep both run phase and verification evidence failed", async () => {
  const [target] = listTargets();
  const workdir = await workspace("broken");
  try {
    const response = await runTarget({
      targetId: target.targetId,
      manifestDigest: target.digest,
      fixture: "broken",
      verify: true,
      workspacePath: workdir,
    });

    assert.equal(response.run.phase, "failed");
    assert.equal(response.result.status, "failed");
    assert.equal(response.evidence.status, "failed");
    await assertDurableRunBundle(workdir, response, { claim: true });
  } finally {
    await rm(workdir, { recursive: true, force: true });
  }
});

test("only exact raw status pass can mint model_verified", async () => {
  const [target] = listTargets();
  for (const mode of ["status-passed", "bare-passed"]) {
    const workdir = await workspace(mode);
    try {
      await withEnv({ LABWIRED_TARGET_TEST_RESULT_MODE: mode }, async () => {
        const response = await runTarget({
          targetId: target.targetId,
          manifestDigest: target.digest,
          fixture: "fixed",
          verify: true,
          workspacePath: workdir,
        });
        assert.equal(response.result.status, "failed", `${mode} must not be observed as pass`);
        assert.equal(response.evidence.status, "failed", `${mode} must not mint proof`);
        assert.equal(response.run.phase, "failed");
      });
    } finally {
      await rm(workdir, { recursive: true, force: true });
    }
  }
});

test("missing simulator result is replaced by a structured failed result artifact", async () => {
  const [target] = listTargets();
  const workdir = await workspace("missing-result");
  try {
    await withEnv({ LABWIRED_TARGET_TEST_RESULT_MODE: "omit-result" }, async () => {
      const response = await runTarget({
        targetId: target.targetId,
        manifestDigest: target.digest,
        fixture: "fixed",
        verify: false,
        workspacePath: workdir,
      });
      const directory = await assertDurableRunBundle(workdir, response);
      assert.equal(response.result.status, "failed");
      assert.equal(JSON.parse(await readFile(join(directory, "result.json"), "utf8")).status, "failed");
    });
  } finally {
    await rm(workdir, { recursive: true, force: true });
  }
});

test("runTarget reports the approved run lifecycle with immutable snapshots", async () => {
  const [target] = listTargets();
  const workdir = await workspace("lifecycle");
  const updates = [];
  try {
    const response = await runTarget({
      targetId: target.targetId,
      manifestDigest: target.digest,
      fixture: "fixed",
      verify: true,
      workspacePath: workdir,
      onState: (run) => updates.push(run),
    });
    assert.deepEqual(
      updates.map((run) => run.phase),
      ["queued", "running", "evaluating", "completed"],
    );
    assert.ok(updates.every((run) => run.manifestDigest === target.digest));
    assert.equal(response.run.phase, "completed");
  } finally {
    await rm(workdir, { recursive: true, force: true });
  }
});

test("simulator resolution skips an agent launcher and preserves the simulator fallback", async () => {
  const [target] = listTargets();
  const workdir = await workspace("agent-launcher");
  const agentLauncher = join(workdir, "labwired");
  try {
    await writeFile(agentLauncher, "#!/bin/sh\n# LABWIRED_AGENT_HOME\nexit 91\n", "utf8");
    await chmod(agentLauncher, 0o755);
    await withEnv({ LABWIRED_CLI: agentLauncher, LABWIRED_SIM: fakeSimulator }, async () => {
      const response = await runTarget({
        targetId: target.targetId,
        manifestDigest: target.digest,
        fixture: "fixed",
        verify: false,
        workspacePath: workdir,
      });
      assert.equal(response.result.status, "pass");
    });
  } finally {
    await rm(workdir, { recursive: true, force: true });
  }
});

test("target RPC requires a valid explicitly initialized workspace", async () => {
  const [target] = listTargets();
  const rpc = startRpcServer();
  let uninitialized = null;
  const request = {
    targetId: target.targetId,
    manifestDigest: target.digest,
    fixture: "fixed",
  };
  const beforeEvidence = await evidenceRunIds(REPOSITORY_ROOT);
  try {
    uninitialized = await rpc.request(1, "target/run", request);
    assert.ok(uninitialized.error, "target/run before initialize must reject");
    assert.match(uninitialized.error.message, /target workspace.*initialize/i);
    assert.deepEqual(stateNotifications(rpc.messages, 0), []);
    assert.equal(rpc.messages.some((message) => message.method === "evidence/append"), false);
    assert.deepEqual(await evidenceRunIds(REPOSITORY_ROOT), beforeEvidence);

    const initializedWithoutWorkspace = await rpc.request(2, "initialize", {});
    assert.equal(initializedWithoutWorkspace.error, undefined);
    const beforeVerify = rpc.messages.length;
    const withoutWorkspace = await rpc.request(3, "target/verify", request);
    assert.ok(withoutWorkspace.error, "target/verify after empty initialize must reject");
    assert.match(withoutWorkspace.error.message, /target workspace.*initialize/i);
    assert.deepEqual(stateNotifications(rpc.messages, beforeVerify), []);
    assert.equal(
      rpc.messages.slice(beforeVerify).some((message) => message.method === "evidence/append"),
      false,
    );
    assert.deepEqual(await evidenceRunIds(REPOSITORY_ROOT), beforeEvidence);

    const initializedWithInvalidWorkspace = await rpc.request(4, "initialize", {
      workspacePath: "relative-workspace",
    });
    assert.equal(initializedWithInvalidWorkspace.error, undefined);
    const beforeInvalidRun = rpc.messages.length;
    const invalidWorkspace = await rpc.request(5, "target/run", request);
    assert.ok(invalidWorkspace.error, "target/run after invalid initialize must reject");
    assert.match(invalidWorkspace.error.message, /target workspace.*initialize/i);
    assert.deepEqual(stateNotifications(rpc.messages, beforeInvalidRun), []);
    assert.equal(
      rpc.messages.slice(beforeInvalidRun).some((message) => message.method === "evidence/append"),
      false,
    );
    assert.deepEqual(await evidenceRunIds(REPOSITORY_ROOT), beforeEvidence);
  } finally {
    if (uninitialized?.result?.run) {
      await rm(evidenceDirectory(REPOSITORY_ROOT, uninitialized.result.run), {
        recursive: true,
        force: true,
      });
    }
    await rpc.stop();
  }
});

test("failed simulator startup emits the complete RPC lifecycle without claim promotion", async () => {
  const [target] = listTargets();
  const workdir = await workspace("rpc-simulator-unavailable");
  let rpc = null;
  try {
    await withEnv(
      {
        LABWIRED_CLI: join(workdir, "missing-labwired-sim"),
        LABWIRED_SIM: undefined,
        LABWIRED_HOME: workdir,
        PATH: workdir,
      },
      async () => {
        rpc = startRpcServer();
        const initialized = await rpc.request(1, "initialize", { workspacePath: workdir });
        assert.equal(initialized.error, undefined);

        const beforeVerify = rpc.messages.length;
        const verified = await rpc.request(2, "target/verify", {
          targetId: target.targetId,
          manifestDigest: target.digest,
          fixture: "fixed",
        });
        assert.equal(verified.error, undefined);
        assert.equal(verified.result.run.phase, "failed");
        assert.equal(verified.result.result.status, "failed");
        assert.equal(verified.result.evidence.status, "failed");

        const runStates = stateNotifications(rpc.messages, beforeVerify);
        assert.deepEqual(
          runStates.map((message) => message.params.run.phase),
          ["queued", "running", "evaluating", "failed"],
        );
        assert.ok(
          runStates.every((message) => Object.keys(message.params).length === 1 && message.params.run),
        );

        const evidenceNotifications = rpc.messages
          .slice(beforeVerify)
          .filter((message) => message.method === "evidence/append");
        assert.equal(evidenceNotifications.length, 1);
        assert.deepEqual(Object.keys(evidenceNotifications[0].params), ["node"]);
        assert.equal(evidenceNotifications[0].params.node.status, "failed");
        assert.notEqual(evidenceNotifications[0].params.node.status, "model_verified");
      },
    );
  } finally {
    await rpc?.stop();
    await rm(workdir, { recursive: true, force: true });
  }
});

test("RPC owns the initialized workspace and emits exact target notifications", async () => {
  const [target] = listTargets();
  const workdir = await workspace("rpc");
  const rpc = startRpcServer();
  try {
    const initialized = await rpc.request(1, "initialize", { workspacePath: workdir });
    assert.equal(initialized.error, undefined);
    assert.equal(initialized.result.capabilities.targetGraphV1, true);

    const listed = await rpc.request(2, "target/list", {});
    assert.equal(listed.error, undefined);
    assert.deepEqual(listed.result.targets, [target]);

    const rejected = await rpc.request(3, "target/run", {
      targetId: target.targetId,
      manifestDigest: target.digest,
      fixture: "fixed",
      workspacePath: workdir,
    });
    assert.match(rejected.error.message, /workspacePath.*not allowed/i);

    const beforeRun = rpc.messages.length;
    const run = await rpc.request(4, "target/run", {
      targetId: target.targetId,
      manifestDigest: target.digest,
      fixture: "fixed",
    });
    assert.equal(run.error, undefined);
    assert.deepEqual(Object.keys(run.result).sort(), ["result", "resultRef", "run"]);
    assert.equal(run.result.run.phase, "completed");
    const runStates = stateNotifications(rpc.messages, beforeRun);
    assert.deepEqual(
      runStates.map((message) => message.params.run.phase),
      ["queued", "running", "evaluating", "completed"],
    );
    assert.ok(runStates.every((message) => Object.keys(message.params).length === 1 && message.params.run));
    assert.equal(
      rpc.messages.slice(beforeRun).filter((message) => message.method === "evidence/append").length,
      0,
    );

    const beforeVerify = rpc.messages.length;
    const verified = await rpc.request(5, "target/verify", {
      targetId: target.targetId,
      manifestDigest: target.digest,
      fixture: "fixed",
    });
    assert.equal(verified.error, undefined);
    assert.equal(verified.result.result.status, "pass");
    assert.equal(verified.result.evidence.status, "model_verified");
    const verifyStates = stateNotifications(rpc.messages, beforeVerify);
    assert.deepEqual(
      verifyStates.map((message) => message.params.run.phase),
      ["queued", "running", "evaluating", "completed"],
    );
    const evidenceNotifications = rpc.messages
      .slice(beforeVerify)
      .filter((message) => message.method === "evidence/append");
    assert.equal(evidenceNotifications.length, 1);
    assert.deepEqual(Object.keys(evidenceNotifications[0].params), ["node"]);
    assert.deepEqual(evidenceNotifications[0].params.node, verified.result.evidence);
    assert.equal(
      rpc.messages.slice(beforeVerify).some((message) => String(message.method || "").startsWith("chat/")),
      false,
    );
  } finally {
    await rpc.stop();
    await rm(workdir, { recursive: true, force: true });
  }
});

test("normal and npm package metadata include the target runtime contract", async () => {
  const allTests = await readFile(join(REPOSITORY_ROOT, "tests", "all.sh"), "utf8");
  const packageMetadata = JSON.parse(await readFile(join(REPOSITORY_ROOT, "package.json"), "utf8"));
  assert.match(allTests, /target-runtime/);
  for (const entry of [
    "server/",
    "fixtures/gate1-live/firmware/gate1-fixed.elf",
    "fixtures/gate1-live/firmware/gate1-broken.elf",
    "share/catalog/systems/esp32c3.yaml",
  ]) {
    assert.ok(packageMetadata.files.includes(entry), `package files should include ${entry}`);
  }
});

test(
  "real labwired-sim proves fixed and broken Gate1 fixtures",
  { skip: process.env.LABWIRED_TARGET_REAL_SIM !== "1" },
  async () => {
    const [target] = listTargets();
    const workdir = await workspace("real-sim");
    try {
      await withEnv(originalSimulatorEnv, async () => {
        const fixed = await runTarget({
          targetId: target.targetId,
          manifestDigest: target.digest,
          fixture: "fixed",
          verify: true,
          workspacePath: workdir,
        });
        const broken = await runTarget({
          targetId: target.targetId,
          manifestDigest: target.digest,
          fixture: "broken",
          verify: true,
          workspacePath: workdir,
        });
        assert.equal(fixed.result.status, "pass");
        assert.equal(fixed.evidence.status, "model_verified");
        assert.equal(broken.result.status, "failed");
        assert.equal(broken.evidence.status, "failed");
      });
    } finally {
      await rm(workdir, { recursive: true, force: true });
    }
  },
);
