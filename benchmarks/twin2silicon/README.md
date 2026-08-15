# Cross-runtime HIL smoke comparison

This is a runtime smoke comparison, not a leaderboard. It runs OpenCode, Codex
CLI, and Claude Code against the same public firmware task, then sends each
completed candidate to the existing physical HIL oracle.

## Interpretation

Native models are intentionally not overridden: each runtime uses its installed
default. A raw-model comparison belongs in the separate OpenCode model matrix,
not this cross-runtime smoke test. A runtime may report token usage but
subscription cost is unknown unless that runtime explicitly provides a cost;
the harness never estimates subscription cost.

The hardware command flashes the connected board. Treat it as a destructive,
opt-in operation and identify the UART and JTAG device deliberately. One smoke
run is useful only as operational evidence. Any publishable result needs
multiple tasks and repeated fresh trials before drawing a conclusion.

## Commands

Run the offline contract suite:

```bash
npm run test:runtime-smoke:offline
```

Run a connected-board comparison only with explicit hardware and output
locations. Existing authenticated runtime sessions are used as-is.
The trial instructions are noninteractive: this command authorizes inspection,
the smallest in-scope repair, and compilation without a confirmation prompt.
Before any flash, the harness checks that the selected UART's PlatformIO device
entry reports the supplied JTAG serial.

```bash
LABWIRED_HIL=1 \
LABWIRED_UART_DEVICE=/dev/cu.usbmodem11101 \
LABWIRED_JTAG_SERIAL=3C:0F:02:DF:EC:F8 \
LABWIRED_OPENOCD="$HOME/.platformio/packages/tool-openocd-esp32/bin/openocd" \
LABWIRED_MATRIX_OUTPUT=/Volumes/LabWired/hil-runs/runtime-smoke-$(date +%Y%m%d-%H%M%S) \
npm run test:runtime-smoke:hardware
```

The entry point checks OpenCode, Codex CLI, Claude Code, PlatformIO, and
OpenOCD and prints their versions before running; operators may capture stdout
with the smoke evidence. Temporary data is placed on
`/Volumes/LabWired` when that volume is available. It does not configure
runtime accounts; authenticate each native runtime before invoking it.

## Evidence

`LABWIRED_MATRIX_OUTPUT` must be a new directory. The matrix writes
`matrix.json` after each runtime, plus per-runtime trial directories under
`trials/`. Completed candidates contain runtime logs, `agent-result.json`,
and `usage.json`; HIL evidence, including `run.json`, is stored in that
trial's `hil/` directory. Preserve these records when reporting a smoke run.
