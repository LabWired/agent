import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import {
  HOSTED_DISCLOSURE,
  ensurePrivateOwnedDirectory,
  hostedDisclosureMessage,
  isHostedLabWiredEnv,
} from "../../cli/cloudSession";

suite("hosted conversation disclosure", () => {
  let root: string;

  setup(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "labwired-disclosure-"));
  });

  teardown(() => fs.rmSync(root, { recursive: true, force: true }));

  test("shows once per version in agent config and redisplays a new version", () => {
    const config = path.join(root, "agent-config");
    const env = { LABWIRED_AGENT_CONFIG_DIR: config } as NodeJS.ProcessEnv;
    assert.strictEqual(hostedDisclosureMessage(env, "1"), HOSTED_DISCLOSURE);
    assert.strictEqual(hostedDisclosureMessage(env, "1"), undefined);
    assert.strictEqual(hostedDisclosureMessage(env, "2"), HOSTED_DISCLOSURE);
    assert.ok(fs.existsSync(path.join(config, "state", "hosted-disclosure-v2")));
  });

  test("uses explicit OpenCode config then agent config then XDG config", () => {
    const xdg = path.join(root, "xdg");
    assert.strictEqual(
      hostedDisclosureMessage(
        {
          HOME: path.join(root, "home"),
          XDG_CONFIG_HOME: xdg,
          LABWIRED_AGENT_CONFIG_DIR: path.join(root, "agent"),
          OPENCODE_CONFIG_DIR: path.join(root, "opencode"),
        },
        "paths"
      ),
      HOSTED_DISCLOSURE
    );
    assert.ok(fs.existsSync(path.join(root, "opencode", "state", "hosted-disclosure-vpaths")));

    assert.strictEqual(
      hostedDisclosureMessage({ XDG_CONFIG_HOME: xdg }, "xdg"),
      HOSTED_DISCLOSURE
    );
    assert.ok(fs.existsSync(path.join(xdg, "labwired-agent", "state", "hosted-disclosure-vxdg")));
  });

  test("recognizes hosted environment without classifying local BYOK", () => {
    assert.strictEqual(isHostedLabWiredEnv({ LABWIRED_MODEL_URL: "https://api.labwired.com/v1" }), true);
    assert.strictEqual(isHostedLabWiredEnv({ LABWIRED_MODEL_URL: "https://api.labwired.com/v1/" }), true);
    assert.strictEqual(isHostedLabWiredEnv({ LABWIRED_MODEL_URL: "https://api.labwired.com.evil.test/v1" }), false);
    assert.strictEqual(isHostedLabWiredEnv({ LABWIRED_MODEL_URL: "https://evil.test/v1?next=https://api.labwired.com/v1" }), false);
    assert.strictEqual(isHostedLabWiredEnv({ LABWIRED_MODEL_URL: "http://api.labwired.com/v1" }), false);
    assert.strictEqual(isHostedLabWiredEnv({ LABWIRED_MODEL_URL: "https://api.labwired.com.evil.test/v1", LABWIRED_ACCESS_TOKEN: "lwd_test" }), false);
    assert.strictEqual(isHostedLabWiredEnv({ LABWIRED_MODEL_URL: "http://127.0.0.1:11434/v1", LABWIRED_MODEL_KEY: "lwd_local" }), false);
    assert.strictEqual(isHostedLabWiredEnv({ LABWIRED_MODEL_URL: "http://127.0.0.1:11434/v1", LABWIRED_MODEL_KEY: "local" }), false);
  });

  test("uses the environment disclosure version when no explicit version is passed", () => {
    const config = path.join(root, "version-config");
    const env = {
      LABWIRED_AGENT_CONFIG_DIR: config,
      LABWIRED_HOSTED_DISCLOSURE_VERSION: "42",
    } as NodeJS.ProcessEnv;
    assert.strictEqual(hostedDisclosureMessage(env), HOSTED_DISCLOSURE);
    assert.strictEqual(hostedDisclosureMessage(env), undefined);
    assert.ok(fs.existsSync(path.join(config, "state", "hosted-disclosure-v42")));

    const unsafeConfig = path.join(root, "unsafe-version-config");
    const unsafeEnv = {
      LABWIRED_AGENT_CONFIG_DIR: unsafeConfig,
      LABWIRED_HOSTED_DISCLOSURE_VERSION: "../../escape",
    } as NodeJS.ProcessEnv;
    assert.strictEqual(hostedDisclosureMessage(unsafeEnv), HOSTED_DISCLOSURE);
    assert.ok(fs.existsSync(path.join(unsafeConfig, "state", "hosted-disclosure-v1")));
  });

  test("does not trust regular-file, symlink, or symlink-state markers", () => {
    const config = path.join(root, "hostile-config");
    const state = path.join(config, "state");
    fs.mkdirSync(state, { recursive: true });
    fs.writeFileSync(path.join(state, "hosted-disclosure-vfile"), "bogus\n");
    assert.strictEqual(
      hostedDisclosureMessage({ LABWIRED_AGENT_CONFIG_DIR: config }, "file"),
      HOSTED_DISCLOSURE
    );
    fs.symlinkSync(path.join(state, "hosted-disclosure-vfile"), path.join(state, "hosted-disclosure-vlink"));
    assert.strictEqual(
      hostedDisclosureMessage({ LABWIRED_AGENT_CONFIG_DIR: config }, "link"),
      HOSTED_DISCLOSURE
    );

    const linkedConfig = path.join(root, "linked-config");
    fs.mkdirSync(linkedConfig);
    fs.writeFileSync(
      path.join(state, "hosted-disclosure-vstate-link"),
      "labwired-hosted-disclosure:state-link\n",
      { mode: 0o600 }
    );
    fs.symlinkSync(state, path.join(linkedConfig, "state"));
    assert.strictEqual(
      hostedDisclosureMessage({ LABWIRED_AGENT_CONFIG_DIR: linkedConfig }, "state-link"),
      HOSTED_DISCLOSURE
    );
  });

  test("concurrent extension launches disclose exactly once", async () => {
    const config = path.join(root, "concurrent-config");
    const modulePath = path.resolve(__dirname, "../../cli/cloudSession");
    const script = `const m=require(${JSON.stringify(modulePath)}); const v=m.hostedDisclosureMessage(process.env); if(v) process.stdout.write(v);`;
    const run = promisify(execFile);
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        run(process.execPath, ["-e", script], {
          env: {
            ...process.env,
            LABWIRED_AGENT_CONFIG_DIR: config,
            LABWIRED_HOSTED_DISCLOSURE_VERSION: "concurrent",
          },
        })
      )
    );
    assert.strictEqual(results.filter(({ stdout }) => stdout === HOSTED_DISCLOSURE).length, 1);
  });

  test("continues when another launch wins the state-directory mkdir race", () => {
    const config = path.join(root, "mkdir-race-config");
    fs.mkdirSync(config, { mode: 0o700 });
    const state = path.join(config, "state");
    const identity = ensurePrivateOwnedDirectory(state, false, (target, options) => {
      fs.mkdirSync(target, options);
      const error = new Error("simulated concurrent mkdir") as NodeJS.ErrnoException;
      error.code = "EEXIST";
      throw error;
    });
    assert.ok(identity?.isDirectory());
    const env = { LABWIRED_AGENT_CONFIG_DIR: config } as NodeJS.ProcessEnv;
    assert.strictEqual(hostedDisclosureMessage(env, "mkdir-race"), HOSTED_DISCLOSURE);
    assert.strictEqual(hostedDisclosureMessage(env, "mkdir-race"), undefined);
  });

  test("shows honestly when acknowledgement cannot be persisted", () => {
    const blocked = path.join(root, "not-a-directory");
    fs.writeFileSync(blocked, "blocked");
    assert.strictEqual(
      hostedDisclosureMessage({ LABWIRED_AGENT_CONFIG_DIR: blocked }, "1"),
      HOSTED_DISCLOSURE
    );
  });
});
