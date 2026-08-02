import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function waitForExit(child, timeoutMs = 2_000) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolveExit) => {
    const timer = setTimeout(resolveExit, timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolveExit();
    });
  });
}

function startRpcServer(env) {
  const child = spawn(process.execPath, ["server/rpc-server.mjs"], {
    cwd: REPOSITORY_ROOT,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const messages = [];
  let buffer = Buffer.alloc(0);
  let stderr = "";
  let nextId = 1;

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
    messages,
    async request(method, params = {}) {
      const id = nextId++;
      const start = messages.length;
      const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, method, params }), "utf8");
      child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
      child.stdin.write(body);
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        const response = messages.slice(start).find((message) => message.id === id);
        if (response) return response;
        await delay(10);
      }
      throw new Error(`timed out waiting for ${method}: ${stderr}`);
    },
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGTERM");
      await waitForExit(child);
    },
  };
}

function desktopEnvironment(overrides = {}) {
  const env = { ...process.env };
  delete env.LABWIRED_MODEL_URL;
  delete env.LABWIRED_MODEL_KEY;
  delete env.OPENAI_API_KEY;
  delete env.LABWIRED_EDITOR;
  delete env.LABWIRED_VSCODE;
  Object.assign(env, overrides);
  return env;
}

async function withRpc(env, action) {
  const rpc = startRpcServer(env);
  try {
    return await action(rpc);
  } finally {
    await rpc.stop();
  }
}

async function initializeDesktop(rpc) {
  const response = await rpc.request("initialize", {
    workspacePath: REPOSITORY_ROOT,
    clientName: "labwired-editor",
  });
  assert.ok(response.result, JSON.stringify(response));
}

async function createFakeLabwired() {
  const directory = await mkdtemp(join(tmpdir(), "labwired-rpc-safety-"));
  const marker = join(directory, "labwired-invoked");
  const executable = join(directory, "labwired");
  await writeFile(
    executable,
    "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$LABWIRED_TEST_MARKER\"\n",
    "utf8",
  );
  await chmod(executable, 0o755);
  return { directory, executable, marker };
}

test("recognized desktop clients advertise desktop safety capability", async () => {
  await withRpc(desktopEnvironment(), async (rpc) => {
    const initialized = await rpc.request("initialize", {
      workspacePath: REPOSITORY_ROOT,
      clientName: "labwired-editor",
    });
    assert.ok(initialized.result, JSON.stringify(initialized));
    assert.equal(initialized.result.capabilities?.desktopSafetyV1, true);
  });
});

test("desktop sessions default to explicit confirmation for every physical flash target", async () => {
  const fake = await createFakeLabwired();
  try {
    await withRpc(
      desktopEnvironment({ LABWIRED_CLI_PATH: fake.executable, LABWIRED_TEST_MARKER: fake.marker }),
      async (rpc) => {
        await initializeDesktop(rpc);
        for (const target of ["physical", "probe", "hardware", "auto", "custom-probe"]) {
          const flash = await rpc.request("tool/run", {
            name: "probe_flash",
            params: { elf: "firmware.elf", chip: "test-chip", target },
          });
          assert.match(flash.error?.message || "", /physical flash requires confirm=1/i, target);
        }
        assert.equal(existsSync(fake.marker), false, "the flash command must not be launched");
      },
    );
  } finally {
    await rm(fake.directory, { recursive: true, force: true });
  }
});

test("desktop autoConfirm/set never enables auto confirmation", async () => {
  await withRpc(desktopEnvironment(), async (rpc) => {
    await initializeDesktop(rpc);
    const confirmation = await rpc.request("autoConfirm/set", { enabled: true });
    assert.deepEqual(confirmation.result, { enabled: false });
  });
});

test("editor-spawned servers reject auto confirmation before RPC initialization", async () => {
  await withRpc(desktopEnvironment({ LABWIRED_EDITOR: "1" }), async (rpc) => {
    const confirmation = await rpc.request("autoConfirm/set", { enabled: true });
    assert.deepEqual(confirmation.result, { enabled: false });
  });
});

test("desktop clients ignore LABWIRED_FLASH_AUTO for physical flash and promote", async () => {
  const fake = await createFakeLabwired();
  try {
    await withRpc(
      desktopEnvironment({
        LABWIRED_CLI_PATH: fake.executable,
        LABWIRED_TEST_MARKER: fake.marker,
        LABWIRED_FLASH_AUTO: "1",
      }),
      async (rpc) => {
        await initializeDesktop(rpc);
        const flash = await rpc.request("tool/run", {
          name: "probe_flash",
          params: { elf: "firmware.elf", chip: "test-chip", target: "probe" },
        });
        assert.match(flash.error?.message || "", /confirmation required|confirm=1/i);
        assert.equal(existsSync(fake.marker), false, "the flash bypass must not reach the CLI");

        const promote = await rpc.request("tool/run", {
          name: "hw_promote",
          params: { dry_run: "1", target: "probe" },
        });
        assert.equal(promote.result?.code, 2);
        assert.equal(promote.result?.extra?.status, "needs_confirm");
      },
    );
  } finally {
    await rm(fake.directory, { recursive: true, force: true });
  }
});

test("desktop freeform chat does not launch unattended OpenCode", async () => {
  const directory = await mkdtemp(join(tmpdir(), "labwired-opencode-safety-"));
  const marker = join(directory, "opencode-invoked");
  const executable = join(directory, "opencode");
  await writeFile(
    executable,
    "#!/bin/sh\nprintf '%s\\n' \"$*\" > \"$LABWIRED_TEST_OPENCODE_MARKER\"\nprintf '%s\\n' '{\"type\":\"text\",\"text\":\"unattended output\"}'\n",
    "utf8",
  );
  await chmod(executable, 0o755);
  try {
    await withRpc(
      desktopEnvironment({
        PATH: `${directory}:${process.env.PATH || ""}`,
        LABWIRED_TEST_OPENCODE_MARKER: marker,
      }),
      async (rpc) => {
        await initializeDesktop(rpc);
        const chat = await rpc.request("chat/send", { text: "summarize this firmware" });
        assert.equal(chat.result?.source, "fallback");
        assert.equal(existsSync(marker), false, "desktop chat must not spawn opencode --auto");
        assert.match(chat.result?.text || "", /\/doctor\b/);
        assert.doesNotMatch(chat.result?.text || "", /\/smoke\b/);
      },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("desktop slash chat blocks mutating actions and retains read-only diagnostics", async () => {
  const fake = await createFakeLabwired();
  try {
    await withRpc(
      desktopEnvironment({ LABWIRED_CLI_PATH: fake.executable, LABWIRED_TEST_MARKER: fake.marker }),
      async (rpc) => {
        await initializeDesktop(rpc);
        for (const text of ["/deps", "/gdb start", "/gdb stop", "/promote", "/plot clear"]) {
          const before = rpc.messages.length;
          const chat = await rpc.request("chat/send", { text });
          assert.equal(chat.result?.source, "safety", text);
          assert.equal(chat.result?.code, 2, text);
          assert.equal(
            rpc.messages.slice(before).some((message) => message.method === "chat/toolCall"),
            false,
            `${text} must not invoke a tool`,
          );
        }
        assert.equal(existsSync(fake.marker), false, "desktop slash commands must not run the CLI");

        const diagnostic = await rpc.request("chat/send", { text: "/gdb info" });
        assert.equal(diagnostic.result?.source, "tool");
        assert.equal(diagnostic.result?.tool, "debug_info");
      },
    );
  } finally {
    await rm(fake.directory, { recursive: true, force: true });
  }
});

test("non-desktop clients retain explicit opt-in auto confirmation", async () => {
  await withRpc(desktopEnvironment(), async (rpc) => {
    const initialized = await rpc.request("initialize", {
      workspacePath: REPOSITORY_ROOT,
      clientName: "standalone-cli",
    });
    assert.ok(initialized.result, JSON.stringify(initialized));
    const confirmation = await rpc.request("autoConfirm/set", { enabled: true });
    assert.deepEqual(confirmation.result, { enabled: true });
  });
});

test("standalone clients retain the explicitly opted-in physical flash bypass", async () => {
  const fake = await createFakeLabwired();
  try {
    await withRpc(
      desktopEnvironment({
        LABWIRED_CLI_PATH: fake.executable,
        LABWIRED_TEST_MARKER: fake.marker,
        LABWIRED_FLASH_AUTO: "1",
      }),
      async (rpc) => {
        const initialized = await rpc.request("initialize", {
          workspacePath: REPOSITORY_ROOT,
          clientName: "standalone-cli",
        });
        assert.ok(initialized.result, JSON.stringify(initialized));
        assert.deepEqual((await rpc.request("autoConfirm/set", { enabled: true })).result, {
          enabled: true,
        });
        const flash = await rpc.request("tool/run", {
          name: "probe_flash",
          params: { elf: "firmware.elf", chip: "test-chip", target: "probe" },
        });
        assert.equal(flash.result?.code, 0);
        assert.equal(existsSync(fake.marker), true, "the standalone bypass must reach the CLI");
      },
    );
  } finally {
    await rm(fake.directory, { recursive: true, force: true });
  }
});
