import * as assert from "assert";
import {
  buildChatCompletionBody,
  pinHostedModelEnv,
  resolveModelForUrl,
} from "../../cli/hostedModel";

suite("hosted model routing", () => {
  test("pins direct hosted request body regardless of stale workspace model", () => {
    for (const stale of ["qwen2.5-coder", "labwired-fast", "vendor/private-model"]) {
      const body = buildChatCompletionBody(
        "https://api.labwired.com/v1",
        stale,
        "system",
        "prompt"
      );
      assert.strictEqual(body.model, "labwired-default");
    }
  });

  test("preserves local and BYOK workspace models", () => {
    assert.strictEqual(resolveModelForUrl("http://127.0.0.1:11434/v1", "qwen-local"), "qwen-local");
    assert.strictEqual(resolveModelForUrl("https://models.example.com/v1", "byok-model"), "byok-model");
  });

  test("pins bridge environment only for exact trusted hosted endpoint", () => {
    assert.strictEqual(
      pinHostedModelEnv({ LABWIRED_MODEL_URL: "https://api.labwired.com/v1", LABWIRED_MODEL: "labwired-fast" }).LABWIRED_MODEL,
      "labwired-default"
    );
    assert.strictEqual(
      pinHostedModelEnv({ LABWIRED_MODEL_URL: "https://api.labwired.com.evil.test/v1", LABWIRED_MODEL: "keep" }).LABWIRED_MODEL,
      "keep"
    );
    assert.strictEqual(
      pinHostedModelEnv({ LABWIRED_MODEL_URL: "http://127.0.0.1:11434/v1", LABWIRED_MODEL_KEY: "lwd_local", LABWIRED_MODEL: "local-model" }).LABWIRED_MODEL,
      "local-model"
    );
  });
});
