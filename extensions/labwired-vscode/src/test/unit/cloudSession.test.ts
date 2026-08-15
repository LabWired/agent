import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  HOSTED_DISCLOSURE,
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
    assert.strictEqual(isHostedLabWiredEnv({ LABWIRED_ACCESS_TOKEN: "lwd_test" }), true);
    assert.strictEqual(isHostedLabWiredEnv({ LABWIRED_MODEL_URL: "http://127.0.0.1:11434/v1", LABWIRED_MODEL_KEY: "local" }), false);
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
