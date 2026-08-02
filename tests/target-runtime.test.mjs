import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { listTargets, runTarget } from "../server/target-runtime.mjs";

const REPOSITORY_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

async function workspace(label) {
  return mkdtemp(join(tmpdir(), `labwired-target-${label}-`));
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
    stderr: () => stderr,
    async request(id, method, params) {
      const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, method, params }), "utf8");
      child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
      child.stdin.write(body);
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        const response = messages.find((message) => message.id === id);
        if (response) return response;
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
      }
      throw new Error(`timed out waiting for RPC ${method}: ${stderr}`);
    },
    async stop() {
      if (!child.killed) child.kill("SIGTERM");
      await new Promise((resolveStop) => {
        child.once("exit", resolveStop);
        setTimeout(resolveStop, 1_000);
      });
    },
  };
}

test("Gate1 virtual target exposes a stable signed manifest graph", () => {
  const [target] = listTargets();
  const [again] = listTargets();

  assert.equal(target.targetId, "gate1-esp32c3");
  assert.equal(target.schemaVersion, 1);
  assert.equal(target.manifestId, "labwired.gate1-esp32c3/v1");
  assert.match(target.manifestDigest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(target.manifestDigest, again.manifestDigest);
  assert.equal(target.kind, "virtual");
  assert.equal(target.chip, "esp32c3");
  assert.deepEqual(target.capabilities, ["run", "verify"]);
  assert.deepEqual(
    target.graph.nodes.map((node) => node.id),
    ["cpu", "uart0", "oracle"],
  );
  assert.deepEqual(target.graph.edges, [
    { from: "cpu", to: "uart0" },
    { from: "uart0", to: "oracle" },
  ]);
});

test("runTarget rejects invalid target requests before invoking a runner", async () => {
  const [target] = listTargets();
  const workdir = await workspace("validation");
  try {
    await assert.rejects(
      runTarget({
        targetId: "unknown-target",
        manifestDigest: target.manifestDigest,
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
        manifestDigest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
        fixture: "fixed",
        verify: false,
        workspacePath: workdir,
      }),
      /stale manifestDigest/i,
    );
    await assert.rejects(
      runTarget({
        targetId: target.targetId,
        manifestDigest: target.manifestDigest,
        fixture: "other",
        verify: false,
        workspacePath: workdir,
      }),
      /fixture.*fixed.*broken/i,
    );
    await assert.rejects(
      runTarget({
        targetId: target.targetId,
        manifestDigest: target.manifestDigest,
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

test("verification fails closed when the simulator result omits an explicit pass status", async () => {
  const [target] = listTargets();
  const workdir = await workspace("unstatused-result");
  const simulator = join(workdir, "labwired-sim");
  const previousCli = process.env.LABWIRED_CLI;
  try {
    await writeFile(
      simulator,
      `#!/bin/sh
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--output-dir" ]; then out="$2"; shift 2; continue; fi
  shift
done
mkdir -p "$out"
printf '%s' '{"assertions":[{"passed":true}]}' > "$out/result.json"
printf '%s\\n' 'LABWIRED_OK' > "$out/uart.log"
printf '%s' '{}' > "$out/run-manifest.json"
`,
      "utf8",
    );
    await chmod(simulator, 0o755);
    process.env.LABWIRED_CLI = simulator;

    const response = await runTarget({
      targetId: target.targetId,
      manifestDigest: target.manifestDigest,
      fixture: "fixed",
      verify: true,
      workspacePath: workdir,
    });

    assert.equal(response.result.simulationStatus, "failed");
    assert.equal(response.result.status, "failed");
    assert.equal(response.evidence.claim.status, "failed");
  } finally {
    if (previousCli === undefined) delete process.env.LABWIRED_CLI;
    else process.env.LABWIRED_CLI = previousCli;
    await rm(workdir, { recursive: true, force: true });
  }
});

test("ordinary target runs return real simulation results without an evidence bundle", async () => {
  const [target] = listTargets();
  const workdir = await workspace("ordinary");
  try {
    const response = await runTarget({
      targetId: target.targetId,
      manifestDigest: target.manifestDigest,
      fixture: "fixed",
      verify: false,
      workspacePath: workdir,
    });

    assert.equal(response.run.targetId, target.targetId);
    assert.equal(response.run.state, "terminal");
    assert.equal(response.result.status, "passed");
    assert.match(response.result.uart, /LABWIRED_OK/);
    assert.match(response.resultRef, /^sha256:[a-f0-9]{64}$/);
    assert.equal(response.evidence, null);
    assert.equal(existsSync(join(workdir, ".labwired", "evidence")), false);
  } finally {
    await rm(workdir, { recursive: true, force: true });
  }
});

test("fixed Gate1 verification stores a model_verified twin evidence bundle", async () => {
  const [target] = listTargets();
  const workdir = await workspace("fixed");
  try {
    const response = await runTarget({
      targetId: target.targetId,
      manifestDigest: target.manifestDigest,
      fixture: "fixed",
      verify: true,
      workspacePath: workdir,
    });

    const evidenceDir = join(workdir, ".labwired", "evidence", response.run.runId);
    assert.equal(response.run.state, "terminal");
    assert.equal(response.result.status, "model_verified");
    assert.ok(response.result.assertions.every((assertion) => assertion.passed === true));
    assert.match(response.result.uart, /LABWIRED_OK/);
    assert.match(response.resultRef, /^sha256:[a-f0-9]{64}$/);
    assert.equal(response.evidence.type, "twin");
    assert.equal(response.evidence.claim.status, "model_verified");
    assert.equal(response.evidence.path, evidenceDir);
    assert.equal(existsSync(join(evidenceDir, "result.json")), true);
    assert.equal(existsSync(join(evidenceDir, "uart.log")), true);
    assert.equal(existsSync(join(evidenceDir, "run-manifest.json")), true);
    assert.equal(existsSync(join(evidenceDir, "claim.json")), true);
    assert.equal(
      JSON.parse(await readFile(join(evidenceDir, "claim.json"), "utf8")).status,
      "model_verified",
    );
  } finally {
    await rm(workdir, { recursive: true, force: true });
  }
});

test("broken Gate1 verification remains failed and records failed twin evidence", async () => {
  const [target] = listTargets();
  const workdir = await workspace("broken");
  try {
    const response = await runTarget({
      targetId: target.targetId,
      manifestDigest: target.manifestDigest,
      fixture: "broken",
      verify: true,
      workspacePath: workdir,
    });

    assert.equal(response.run.state, "terminal");
    assert.equal(response.result.status, "failed");
    assert.ok(response.result.assertions.some((assertion) => assertion.passed !== true));
    assert.doesNotMatch(response.result.uart, /LABWIRED_OK/);
    assert.equal(response.evidence.type, "twin");
    assert.equal(response.evidence.claim.status, "failed");
    assert.equal(
      JSON.parse(
        await readFile(
          join(workdir, ".labwired", "evidence", response.run.runId, "claim.json"),
          "utf8",
        ),
      ).status,
      "failed",
    );
  } finally {
    await rm(workdir, { recursive: true, force: true });
  }
});

test("RPC exposes direct target graph methods with state and evidence notifications", async () => {
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

    const invalidWorkspace = await rpc.request(9, "target/run", {
      targetId: target.targetId,
      manifestDigest: target.manifestDigest,
      fixture: "fixed",
      workspacePath: "",
    });
    assert.match(invalidWorkspace.error.message, /workspacePath.*absolute/i);

    const beforeRun = rpc.messages.length;
    const run = await rpc.request(3, "target/run", {
      targetId: target.targetId,
      manifestDigest: target.manifestDigest,
      fixture: "fixed",
      workspacePath: workdir,
    });
    assert.equal(run.error, undefined);
    assert.equal(run.result.evidence, null);
    assert.deepEqual(
      rpc.messages
        .slice(beforeRun)
        .filter((message) => message.method === "target/runState")
        .map((message) => message.params.state),
      ["queued", "running", "terminal"],
    );
    assert.equal(
      rpc.messages.slice(beforeRun).filter((message) => message.method === "evidence/append").length,
      0,
    );

    const beforeVerify = rpc.messages.length;
    const verified = await rpc.request(4, "target/verify", {
      targetId: target.targetId,
      manifestDigest: target.manifestDigest,
      fixture: "fixed",
      workspacePath: workdir,
    });
    assert.equal(verified.error, undefined);
    assert.equal(verified.result.result.status, "model_verified");
    assert.ok(verified.result.run);
    assert.match(verified.result.resultRef, /^sha256:[a-f0-9]{64}$/);
    assert.equal(verified.result.evidence.type, "twin");
    assert.deepEqual(
      rpc.messages
        .slice(beforeVerify)
        .filter((message) => message.method === "target/runState")
        .map((message) => message.params.state),
      ["queued", "running", "terminal"],
    );
    assert.equal(
      rpc.messages.slice(beforeVerify).filter((message) => message.method === "evidence/append").length,
      1,
    );
    assert.equal(
      rpc.messages.slice(beforeVerify).some((message) => String(message.method || "").startsWith("chat/")),
      false,
    );
  } finally {
    await rpc.stop();
    await rm(workdir, { recursive: true, force: true });
  }
});
