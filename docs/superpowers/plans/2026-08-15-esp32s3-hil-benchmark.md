# ESP32-S3 HIL Benchmark Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one reproducible ESP-IDF repair task and an automated evaluator that scores a connected ESP32-S3 using both a nonce-tagged USB-serial observation and hidden GPIO register assertions read through USB-JTAG.

**Architecture:** Keep model execution separate from physical evaluation. A Python standard-library benchmark package owns typed results, bounded subprocesses, board locking, UART/JTAG evidence, and manifest generation; a small CLI composes those units. PlatformIO supplies the pinned ESP-IDF build/flash path, while fixture executables make every orchestration branch testable without hardware.

**Tech Stack:** Python 3 standard library, PlatformIO with Espressif32/ESP-IDF, Espressif OpenOCD, macOS USB serial, Bash test registration, JSON task/oracle manifests.

---

## File Map

- Create `benchmarks/twin2silicon/hil/__init__.py`: package marker and public result types.
- Create `benchmarks/twin2silicon/hil/process.py`: timeout-bounded subprocess execution and captured command evidence.
- Create `benchmarks/twin2silicon/hil/esp32s3.py`: board identity validation, lock lifecycle, UART capture, flash, OpenOCD reads, and register evaluation.
- Create `benchmarks/twin2silicon/hil/results.py`: canonical status/result dataclasses, hashing, and atomic JSON output.
- Create `benchmarks/twin2silicon/run_hil.py`: CLI that loads the task, prepares a run, optionally invokes the Agent, and evaluates the candidate.
- Create `benchmarks/twin2silicon/tasks/esp32s3-gpio-hil-001/task.json`: public metadata and budgets.
- Create `benchmarks/twin2silicon/tasks/esp32s3-gpio-hil-001/hidden/hil-oracle.json`: GPIO register assertions and transport settings.
- Create `benchmarks/twin2silicon/tasks/esp32s3-gpio-hil-001/public/README.md`: repair prompt.
- Create `benchmarks/twin2silicon/tasks/esp32s3-gpio-hil-001/public/firmware/platformio.ini`: pinned ESP-IDF project configuration.
- Create `benchmarks/twin2silicon/tasks/esp32s3-gpio-hil-001/public/firmware/sdkconfig.defaults`: USB Serial/JTAG console configuration.
- Create `benchmarks/twin2silicon/tasks/esp32s3-gpio-hil-001/public/firmware/src/main.c`: deliberately faulty GPIO firmware.
- Create `tests/twin2silicon-hil.py`: offline unit/integration tests with fixture executables and pseudo-terminals.
- Create `tests/twin2silicon-hil.sh`: shell entrypoint for the offline suite.
- Create `tests/twin2silicon-hil-live.sh`: explicit destructive live acceptance test.
- Modify `tests/all.sh`: register only the offline HIL suite.
- Modify `package.json`: add `test:twin2silicon-hil` and `test:twin2silicon-hil:live` commands.
- Modify `docs/TESTING.md`: document offline and destructive live commands.

### Task 1: Define result and process contracts

**Files:**
- Create: `benchmarks/twin2silicon/hil/__init__.py`
- Create: `benchmarks/twin2silicon/hil/results.py`
- Create: `benchmarks/twin2silicon/hil/process.py`
- Create: `tests/twin2silicon-hil.py`

- [ ] **Step 1: Write failing tests for statuses, atomic evidence, hashing, timeout, and process-group cleanup**

Add tests that import `CommandResult`, `RunResult`, `sha256_file`, `write_json_atomic`, and `run_command`. Assert that:

```python
def test_run_result_keeps_infrastructure_separate_from_candidate_failure(self):
    result = RunResult.infrastructure_error("board_identity", "wrong adapter")
    self.assertEqual(result.hardware_status, "not_run")
    self.assertEqual(result.infrastructure_status, "error")
    self.assertEqual(result.failure_category, "board_identity")

def test_run_command_times_out_and_captures_evidence(self):
    result = run_command(
        [sys.executable, "-c", "import time; time.sleep(10)"],
        cwd=self.tmp,
        timeout_seconds=0.1,
        stdout_path=self.tmp / "stdout.log",
        stderr_path=self.tmp / "stderr.log",
    )
    self.assertTrue(result.timed_out)
    self.assertIsNotNone(result.duration_seconds)
    self.assertNotEqual(result.returncode, 0)
```

- [ ] **Step 2: Run the tests and verify RED**

Run: `python3 tests/twin2silicon-hil.py -k 'run_result or run_command'`

Expected: import failure because `benchmarks.twin2silicon.hil` does not exist.

- [ ] **Step 3: Implement minimal typed results and bounded command execution**

Use frozen dataclasses and literal string statuses. `run_command()` must use `subprocess.Popen(..., start_new_session=True)`, `communicate(timeout=...)`, then `os.killpg(process.pid, signal.SIGTERM)` followed by a bounded SIGKILL fallback. It returns command, sanitized cwd, return code, timeout flag, start/end UTC timestamps, duration, and log paths. `write_json_atomic()` writes a sibling temporary file, fsyncs it, and replaces the destination.

The constructors must encode these exact distinctions:

```python
@classmethod
def infrastructure_error(cls, category: str, detail: str) -> "RunResult":
    return cls(
        model_status="not_run",
        compile_status="not_run",
        simulator_status="not_supported",
        hardware_status="not_run",
        infrastructure_status="error",
        failure_category=category,
        detail=detail,
    )
```

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `python3 tests/twin2silicon-hil.py -k 'run_result or run_command or atomic or sha256'`

Expected: all selected tests pass and the timeout test completes in under two seconds.

- [ ] **Step 5: Commit**

```bash
git add benchmarks/twin2silicon/hil tests/twin2silicon-hil.py
git commit -m "feat(bench): add bounded HIL result primitives"
```

### Task 2: Add the ESP32-S3 task fixture

**Files:**
- Create: `benchmarks/twin2silicon/tasks/esp32s3-gpio-hil-001/task.json`
- Create: `benchmarks/twin2silicon/tasks/esp32s3-gpio-hil-001/hidden/hil-oracle.json`
- Create: `benchmarks/twin2silicon/tasks/esp32s3-gpio-hil-001/public/README.md`
- Create: `benchmarks/twin2silicon/tasks/esp32s3-gpio-hil-001/public/firmware/platformio.ini`
- Create: `benchmarks/twin2silicon/tasks/esp32s3-gpio-hil-001/public/firmware/sdkconfig.defaults`
- Create: `benchmarks/twin2silicon/tasks/esp32s3-gpio-hil-001/public/firmware/src/main.c`
- Test: `tests/twin2silicon-hil.py`

- [ ] **Step 1: Write a failing fixture-contract test**

Load both JSON files and assert schema `1.0`, task id `esp32s3-gpio-hil-001`, board `esp32-s3-devkitc-1`, framework `espidf`, a 50,000-token cap, zero diagnostic HIL calls for the model, UART prefix `LABWIRED_READY:`, and exactly these GPIO2 assertions:

```json
[
  {"name":"gpio2_output_enabled","address":"0x60004020","mask":"0x00000004","expected":"0x00000004"},
  {"name":"gpio2_output_high","address":"0x60004004","mask":"0x00000004","expected":"0x00000004"}
]
```

Also assert that the public tree contains no expected register values or JTAG commands, and that `main.c` initially calls `gpio_set_direction(TEST_GPIO, GPIO_MODE_INPUT)`.

- [ ] **Step 2: Run the fixture test and verify RED**

Run: `python3 tests/twin2silicon-hil.py -k fixture_contract`

Expected: failure because the task directory is absent.

- [ ] **Step 3: Create the minimal ESP-IDF fixture**

Pin PlatformIO's `espressif32` platform to the installed, lockable version selected by `pio pkg list`; set `board = esp32-s3-devkitc-1`, `framework = espidf`, `monitor_speed = 115200`, and `board_upload.flash_size = 4MB`. Configure USB Serial/JTAG as the primary console in `sdkconfig.defaults`.

In `main.c`, define `TEST_GPIO GPIO_NUM_2`, include generated `run_nonce.h`, set the initial deliberate defect to input mode, call `gpio_set_level(TEST_GPIO, 1)`, print `LABWIRED_READY:%s\n`, flush stdout, and remain alive. The intended one-line repair is `GPIO_MODE_OUTPUT`.

- [ ] **Step 4: Verify the fixture starts red semantically and builds**

Run:

```bash
python3 tests/twin2silicon-hil.py -k fixture_contract
pio run -d benchmarks/twin2silicon/tasks/esp32s3-gpio-hil-001/public/firmware
```

Expected: contract passes and PlatformIO reports `SUCCESS`; the source still configures GPIO2 as input.

- [ ] **Step 5: Commit**

```bash
git add benchmarks/twin2silicon/tasks/esp32s3-gpio-hil-001 tests/twin2silicon-hil.py
git commit -m "test(bench): add ESP32-S3 GPIO repair fixture"
```

### Task 3: Implement board identity, locking, UART, and JTAG evaluation

**Files:**
- Create: `benchmarks/twin2silicon/hil/esp32s3.py`
- Modify: `tests/twin2silicon-hil.py`

- [ ] **Step 1: Write failing offline hardware-adapter tests**

Use temporary executable fixtures and `pty.openpty()` to cover:

- exactly one configured JTAG serial succeeds;
- absent, wrong, or duplicate serials return `board_identity` infrastructure errors before flash;
- a second evaluator cannot acquire the same board lock;
- UART accepts only `LABWIRED_READY:<current nonce>` and rejects absent, wrong, and stale nonces;
- flash nonzero exit is a candidate failure only after identity succeeds;
- OpenOCD text is parsed only for explicitly named `@@REG <name> <address> <value>` records;
- masked register mismatch returns hardware `fail`;
- all assertions matching returns hardware `pass`;
- timeouts close the pseudo-terminal, terminate children, and release the lock.

- [ ] **Step 2: Run the adapter tests and verify RED**

Run: `python3 tests/twin2silicon-hil.py -k 'identity or lock or uart or jtag or register or flash'`

Expected: import failure for `hil.esp32s3`.

- [ ] **Step 3: Implement the adapter with dependency-injected commands**

Define `Esp32S3Config`, `RegisterAssertion`, `BoardLock`, `validate_identity()`, `capture_uart_nonce()`, `flash_firmware()`, `read_registers()`, and `evaluate_registers()`. Commands come from the hidden descriptor or explicit CLI overrides; no shell interpolation is permitted.

Identity validation consumes a command returning one serial per line and requires `matches == [expected_serial]`. OpenOCD receives:

```text
adapter serial <serial>; adapter speed 4000; init; reset run; sleep 750;
halt; echo "@@REG gpio2_output_enabled 0x60004020"; mdw 0x60004020 1;
echo "@@REG gpio2_output_high 0x60004004"; mdw 0x60004004 1; exit
```

The parser pairs each marker only with the immediately following OpenOCD memory word line and rejects missing, duplicate, or unrequested observations.

- [ ] **Step 4: Run adapter tests and verify GREEN**

Run: `python3 tests/twin2silicon-hil.py -k 'identity or lock or uart or jtag or register or flash'`

Expected: all selected tests pass without accessing `/dev` or a network.

- [ ] **Step 5: Commit**

```bash
git add benchmarks/twin2silicon/hil/esp32s3.py tests/twin2silicon-hil.py
git commit -m "feat(bench): evaluate ESP32-S3 UART and JTAG evidence"
```

### Task 4: Compose the benchmark CLI and evidence manifest

**Files:**
- Create: `benchmarks/twin2silicon/run_hil.py`
- Modify: `tests/twin2silicon-hil.py`

- [ ] **Step 1: Write failing end-to-end fixture tests**

Run the CLI against fake identity, PlatformIO, UART, and OpenOCD endpoints. Assert:

- `--evaluate-only` copies a candidate, injects a 128-bit nonce header, and never exposes `hidden/` beneath the workspace;
- complete evidence yields exit 0 with hardware `pass`;
- a valid model failure also yields exit 0 with hardware `fail`;
- infrastructure failure yields exit 2 and is excluded from valid aggregate counts;
- manifest paths are relative, environment values are allowlisted, and secret-looking values never appear;
- every raw artifact listed in `run.json` has a matching SHA-256;
- rerunning into an existing run directory is refused;
- model budgets and provider usage supplied through `--usage-json` are preserved and cost arithmetic is exact.

- [ ] **Step 2: Run CLI tests and verify RED**

Run: `python3 tests/twin2silicon-hil.py -k 'cli or manifest or secret or cost'`

Expected: failure because `run_hil.py` is absent.

- [ ] **Step 3: Implement the CLI**

Support these explicit modes and arguments:

```text
run_hil.py TASK --run-dir DIR --evaluate-only --candidate DIR
run_hil.py TASK --run-dir DIR --agent-bin PATH --model MODEL
  --jtag-serial SERIAL --uart-device DEVICE --openocd PATH
  --usage-json FILE
```

The Agent mode copies `public/`, injects `include/run_nonce.h`, invokes `labwired-agent agent run` in the workspace with the public README as prompt, and then evaluates the resulting candidate. `--evaluate-only` skips model invocation but uses the same build/HIL/evidence path. Require explicit `--jtag-serial` and `--uart-device` for live operation; tests may inject fixture commands.

Write `run.json` atomically after every phase so interrupted runs remain diagnosable, then finalize hashes only after all logs close. Use exit 0 for completed pass/fail and exit 2 for invalid infrastructure.

- [ ] **Step 4: Run all offline Python tests and verify GREEN**

Run: `python3 tests/twin2silicon-hil.py`

Expected: all tests pass; no test opens a real serial device, invokes real PlatformIO, or contacts a model API.

- [ ] **Step 5: Commit**

```bash
git add benchmarks/twin2silicon/run_hil.py tests/twin2silicon-hil.py
git commit -m "feat(bench): orchestrate reproducible ESP32-S3 HIL runs"
```

### Task 5: Register tests and operator documentation

**Files:**
- Create: `tests/twin2silicon-hil.sh`
- Create: `tests/twin2silicon-hil-live.sh`
- Modify: `tests/all.sh`
- Modify: `package.json`
- Modify: `docs/TESTING.md`

- [ ] **Step 1: Write the shell entrypoints and registration assertions first**

`tests/twin2silicon-hil.sh` runs `python3 tests/twin2silicon-hil.py`. `tests/twin2silicon-hil-live.sh` refuses to run unless `LABWIRED_HIL_DESTRUCTIVE=1`, `ESP32S3_SERIAL`, and `ESP32S3_UART` are set, then calls `run_hil.py --evaluate-only` with the known-good repaired fixture copy.

Add static assertions that ordinary `tests/all.sh` includes only the offline script and never the live script.

- [ ] **Step 2: Run registration assertions and verify RED**

Run: `bash tests/twin2silicon-hil.sh`

Expected: failure until package/test registration assertions are satisfied.

- [ ] **Step 3: Register the offline lane and document the destructive lane**

Add to `tests/all.sh`:

```bash
run "twin2silicon-hil" "$ROOT/tests/twin2silicon-hil.sh"
```

Add package scripts:

```json
"test:twin2silicon-hil": "bash tests/twin2silicon-hil.sh",
"test:twin2silicon-hil:live": "bash tests/twin2silicon-hil-live.sh"
```

Document the exact live command, destructive warning, required board serial/UART variables, result semantics, and evidence directory.

- [ ] **Step 4: Verify offline registration and syntax**

Run:

```bash
bash -n tests/twin2silicon-hil.sh tests/twin2silicon-hil-live.sh
npm run test:twin2silicon-hil
```

Expected: syntax clean and all offline HIL tests pass.

- [ ] **Step 5: Commit**

```bash
git add tests/twin2silicon-hil.sh tests/twin2silicon-hil-live.sh tests/all.sh package.json docs/TESTING.md
git commit -m "test(bench): register ESP32-S3 HIL benchmark lanes"
```

### Task 6: Run the destructive connected-board acceptance test

**Files:**
- Runtime artifacts only: `out/twin2silicon/esp32s3-gpio-hil-001-<UTC>/`

- [ ] **Step 1: Verify prerequisites without modifying the board**

Run:

```bash
pio --version
/private/tmp/openocd-esp32/bin/openocd --version
system_profiler SPUSBDataType | grep -A20 'USB JTAG/serial debug unit'
ls -l /dev/cu.usbmodem*
```

Expected: PlatformIO and Espressif OpenOCD are available, JTAG serial `9C:CC:01:D0:98:E0` is present exactly once, and the chosen S3 UART device exists.

- [ ] **Step 2: Prove the live gate refuses implicit destructive execution**

Run: `bash tests/twin2silicon-hil-live.sh`

Expected: nonzero exit explaining `LABWIRED_HIL_DESTRUCTIVE=1` is required; no flash command runs.

- [ ] **Step 3: Run a fresh known-good physical acceptance**

Copy the public fixture to a temporary candidate, change only `GPIO_MODE_INPUT` to `GPIO_MODE_OUTPUT`, then run:

```bash
LABWIRED_HIL_DESTRUCTIVE=1 \
ESP32S3_SERIAL='9C:CC:01:D0:98:E0' \
ESP32S3_UART='/dev/cu.usbmodem11101' \
bash tests/twin2silicon-hil-live.sh
```

Expected: clean build and flash succeed, current nonce is observed, both GPIO2 masked assertions pass, `hardware_status` is `pass`, and evidence hashes validate.

- [ ] **Step 4: Run the complete offline regression suite**

Run:

```bash
npm run test:twin2silicon-hil
bash tests/twin2silicon-fixture.sh
git diff --check
```

Expected: both benchmark suites pass and the diff check is clean. If the legacy fixture requires `LABWIRED_CLI`, provide the same simulator binary used by its existing documented invocation.

- [ ] **Step 5: Record acceptance evidence without committing runtime output**

Confirm `out/` remains untracked. Report the run directory, manifest link, firmware hash, nonce assertion, JTAG observations, elapsed time, and whether any infrastructure retry occurred.

### Task 7: Final review and branch handoff

**Files:**
- Review all files changed since design commit `4cbf6eb`.

- [ ] **Step 1: Review requirements against the approved design**

Check that model execution and evaluation are separated, hidden values never enter the workspace, missing hardware is not a model failure, board identity is explicit, subprocesses and locks are bounded, evidence is hash-addressed, and the live test is absent from ordinary CI.

- [ ] **Step 2: Run final verification from a clean process**

Run:

```bash
npm run test:twin2silicon-hil
python3 -m py_compile benchmarks/twin2silicon/run_hil.py benchmarks/twin2silicon/hil/*.py tests/twin2silicon-hil.py
git diff --check 4cbf6eb..HEAD
git status --short
```

Expected: tests and compilation pass, diff is clean, and only the pre-existing untracked `out/` remains.

- [ ] **Step 3: Request code review and address only verified findings**

Review the implementation for specification compliance first and code quality second. Reproduce every blocking finding with a focused failing test before changing production behavior.

- [ ] **Step 4: Prepare PR-only handoff**

Push the feature branch and open a draft PR. Do not merge or deploy; the user previously requested PR-only delivery for repository changes.

