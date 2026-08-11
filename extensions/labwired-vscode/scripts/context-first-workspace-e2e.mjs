#!/usr/bin/env node
/**
 * Extension workspace e2e: write .labwired like a mint, assert context twin_ready.
 * Uses generated flag engine only (no vscode).
 */
import fs from "fs";
import path from "path";
import os from "os";
import { fileURLToPath, pathToFileURL } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const genPath = path.join(__dirname, "../src/board/contextFlags.generated.ts");
const { buildLabwiredContext } = await import(pathToFileURL(genPath).href);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lw-ctx-e2e-"));
const lab = path.join(tmp, ".labwired");
fs.mkdirSync(lab, { recursive: true });

const diagram = {
  version: 1,
  board: "esp32-c3-supermini",
  parts: [
    { id: "mcu", type: "esp32-c3-supermini" },
    { id: "led1", type: "led", attrs: { color: "green" } },
  ],
  wires: [
    { from: { part: "mcu", pin: "GPIO8" }, to: { part: "led1", pin: "A" } },
    { from: { part: "mcu", pin: "GND" }, to: { part: "led1", pin: "C" } },
  ],
};

fs.writeFileSync(path.join(lab, "diagram.json"), JSON.stringify(diagram, null, 2));
fs.writeFileSync(
  path.join(lab, "board.json"),
  JSON.stringify({
    version: 1,
    board: "esp32-c3-supermini",
    mint_ok: true,
    supported_part_count: 2,
    supportedPartCount: 2,
    ok: true,
  }),
);

// Mimic loadWorkspacePack without vscode
const pack = {
  board: "esp32-c3-supermini",
  diagram,
  mint_ok: true,
  supported_part_count: 2,
};
const ctx = buildLabwiredContext({
  goal: "Blink the LED and prove it on the twin.",
  pack,
});

if (ctx.mode !== "twin_ready" || !ctx.twin_buildable) {
  console.error("FAIL workspace e2e", ctx);
  process.exit(1);
}

const thin = buildLabwiredContext({ pack: { user_context: "x" } });
if (thin.mode !== "empty" || thin.quality !== "thin") {
  console.error("FAIL thin", thin);
  process.exit(1);
}

console.log("WORKSPACE_E2E_OK", ctx.summary);
fs.rmSync(tmp, { recursive: true, force: true });
