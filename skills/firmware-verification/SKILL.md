---
name: firmware-verification
description: >-
  Verify firmware behavior against LabWired's deterministic hardware oracle before
  claiming it works — the same binary in sim, on the bench, and in CI, byte-exact.
  Use whenever you are about to report that firmware compiles, runs, boots, blinks,
  prints, or passes. Never assert firmware success from reading the code or from an
  observational run alone; only `labwired_verify` returning `proven: true` is proof.
---

# Firmware verification

The one rule:

> **You may not tell the user the firmware works until `labwired_verify` returns
> `proven: true`.** Not because the code looks right. Not because it compiled. Not
> because a plain run printed something. Proof comes from the oracle, or it doesn't exist.

This is the whole point of LabWired: the agent proposes, a **deterministic oracle disposes**.
An LLM saying "this should work" is a guess. `labwired_verify` runs the exact binary on a
register-level digital twin and checks observable evidence against an oracle **you cannot
talk your way past.**

## The three tools, and which one proves

| Tool | What it does | Proves? |
|---|---|---|
| `labwired_compile` | source → ELF on the hosted toolchain, or compiler diagnostics | ❌ compile ≠ run |
| `labwired_run` | runs the binary, returns serial / registers / diagnosis | ❌ **observational only** — it reports, it never mints a verdict |
| `labwired_verify` | runs the binary **and** checks it against a required oracle | ✅ **the only tool that mints `proven`** |

Use `run` to *observe* (what printed, where it faulted). Use `verify` to *prove*. Reporting
a `run` as success is the exact mistake this skill exists to prevent.

## The loop

1. **Write** the firmware.
2. **Verify** — call `labwired_verify` with the source (or a `firmware_ref`), the board, and an
   **oracle**. One call compiles, runs, and gates.
3. **Read the verdict.**
   - `proven: true` → you may report success. Quote the oracle clauses that held.
   - `proven: false` or an error → **do not claim success.** Read the `diagnosis` (faulting
     address, infinite loop, unmodeled-peripheral poll, bad pointer), fix the firmware, verify
     again. Loop until green.
4. Never exit the loop by lowering the bar — fix the firmware, not the oracle.

## Writing the oracle (required)

`labwired_verify` **rejects an empty oracle** with `ORACLE_REQUIRED` — verify never passes on
execution alone. Assert at least one clause of observable evidence:

- **`serial`** — `{ "contains": "READY" }` or `{ "matches": "temp=\\d+" }`. Lowered to
  stop-on-match, so a *print-then-crash* reports the fault, not a false pass.
- **`gpio`** — final pin state: `{ "pin": "PA5", "state": "high" | "low" | "toggled" }`.
- **`registers`** — final peripheral state: `{ "peripheral": "gpioa", "register": "odr",
  "equals": 32, "mask": 32 }`.
- **`display`** — a panel actually painted: `{ "painted": true, "min_ink_bytes": 1 }`.

Assert the *behavior the user actually cares about*, not an incidental side effect. "It printed
READY" is weak if the job was "toggle the relay" — assert the GPIO.

## The diagram

`verify`/`run` take a `diagram` (the virtual board + parts + wires). **Include the MCU as a
part**, using its **exact catalog type** (e.g. `esp32-c3-supermini`) — a diagram with no MCU is
rejected with `NO_MCU`, and a wrong spelling is rejected with a hint to the right one. Minimum
valid bare-board diagram:

```json
{ "board": "esp32-c3-supermini",
  "parts": [{ "id": "mcu", "type": "esp32-c3-supermini" }],
  "wires": [] }
```

If a peripheral is under test, add it as another part and wire it to the MCU's pins. Call
`labwired_validate` first (or read the rejection's `diagnostics`) whenever a diagram is refused —
it names the exact fix.

## Reading a red verdict honestly

When `proven: false`, report it as a failure with the evidence:
- Which oracle clause failed, and the actual observed value.
- The `diagnosis` string if the run faulted or hung (it names the faulting address / cause).
- Then propose the fix. Do **not** soften "it failed" into "it mostly works."

A red verdict is the skill doing its job — it caught something a self-reporting agent would
have shipped. Treat it as a win, not an embarrassment.

## Example — the shape of a verify call

Board `esp32-c3-supermini`, Arduino, printing a marker, gated on serial:

```
labwired_verify(
  diagram: { board: "esp32-c3-supermini",
             parts: [{ id: "mcu", type: "esp32-c3-supermini" }], wires: [] },
  board: "esp32-c3-supermini", language: "arduino", entryPath: "src/main.ino",
  source: `
    void setup() { Serial.begin(115200); Serial.println("LABWIRED_OK"); }
    void loop() { delay(500); }
  `,
  oracle: { serial: [{ contains: "LABWIRED_OK" }] }
)
```

A green returns `proven: true` with the matched clause; you may then report success and quote it.
Break the marker (or crash before the print) and the same call returns `proven: false` with the
serial buffer / fault diagnosis — that red→green transition **is** the loop.

> If a call returns an error (a builder/tool failure, not a verdict), that is **not** a pass
> either — surface the error and retry or report it. Only `proven: true` is success.

## Honesty checklist (before you report anything)

- [ ] Did `labwired_verify` return `proven: true`? If not, I do **not** claim it works.
- [ ] Does the oracle assert the behavior the user asked for (not an incidental one)?
- [ ] Am I quoting the actual verdict, not paraphrasing a run as a pass?
- [ ] On failure: did I report the failing clause + diagnosis, not soften it?

## Notes
- Beachhead target for the tightest loop: **nRF52840 + Zephyr** (hardware-validated); the skill
  is board-agnostic and works for every board `labwired_list` reports as runnable.
- Large firmware: `labwired_put_source` first, then pass `source_tree_ref` to `verify`.
