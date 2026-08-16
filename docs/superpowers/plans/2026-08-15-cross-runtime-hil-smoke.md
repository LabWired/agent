# Cross-Runtime HIL Smoke Test Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run OpenCode, Codex CLI, and Claude Code with their native/default models against identical LabWired firmware tasks, then score every candidate with the existing physical HIL oracle and emit one normalized comparison.

**Architecture:** A stdlib-only adapter module builds native commands and normalizes runtime output. A single-trial controller copies public inputs, writes runtime-native instruction/MCP files, runs one bounded agent, and emits `agent-result.json` plus `usage.json`. A matrix controller runs independent trials and invokes the existing `run_hil.py`; it never interprets or replaces the hidden oracle.

**Tech Stack:** Python 3 standard library, existing LabWired skills/MCP package, OpenCode 1.18.7, Codex CLI, Claude Code, PlatformIO, ESP-IDF, OpenOCD, UART/JTAG HIL.

---

## File Structure

- Create `benchmarks/twin2silicon/runtime_adapters.py`: runtime command construction and output normalization only.
- Create `benchmarks/twin2silicon/run_agent.py`: one fresh candidate-generation trial and its evidence.
- Create `benchmarks/twin2silicon/run_matrix.py`: sequential cross-runtime execution, HIL invocation, and summary output.
- Create `benchmarks/twin2silicon/shared-agent-instructions.md`: model-neutral firmware repair instructions mapped into each runtime.
- Create `benchmarks/twin2silicon/runtime-config/opencode.json`: existing local LabWired MCP profile with no model override.
- Create `benchmarks/twin2silicon/runtime-config/claude-mcp.json`: local LabWired MCP registration for Claude Code.
- Modify `tests/twin2silicon-hil.py`: offline adapter, trial, normalization, and matrix tests using fake executables.
- Create `tests/twin2silicon-runtime-smoke.sh`: opt-in connected-board entry point.
- Modify `package.json`: expose offline and connected smoke commands.
- Modify `benchmarks/twin2silicon/README.md` or create it if absent: document the matrix contract and usage.

### Task 1: Define the normalized runtime contract

**Files:**
- Create: `benchmarks/twin2silicon/runtime_adapters.py`
- Modify: `tests/twin2silicon-hil.py`

- [ ] **Step 1: Write failing command-construction tests**

Add `RuntimeAdapterTests` that creates an `AdapterContext` and asserts:

```python
self.assertEqual(
    build_runtime_command("codex", context)[:2],
    ["codex", "exec"],
)
self.assertNotIn("--model", build_runtime_command("codex", context))
self.assertEqual(build_runtime_command("claude", context)[:2], ["claude", "--print"])
self.assertNotIn("--model", build_runtime_command("claude", context))
self.assertEqual(build_runtime_command("opencode", context)[:2], ["opencode", "run"])
self.assertNotIn("--model", build_runtime_command("opencode", context))
```

Also assert each command selects structured output and the supplied workspace without embedding a hidden-oracle path.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
python3 tests/twin2silicon-hil.py -k RuntimeAdapterTests
```

Expected: import failure for `benchmarks.twin2silicon.runtime_adapters`.

- [ ] **Step 3: Implement the minimal adapter types and commands**

Define frozen dataclasses:

```python
@dataclass(frozen=True)
class AdapterContext:
    runtime: Literal["opencode", "codex", "claude"]
    executable: str
    workspace: Path
    prompt: str
    config_dir: Path
    stdout_path: Path
    stderr_path: Path

@dataclass(frozen=True)
class NormalizedUsage:
    requests: int | None
    fresh_input: int | None
    cached_input: int | None
    reasoning: int | None
    output: int | None
    estimated_cost_usd: float | None
    unavailable_reason: str | None
```

Construct native/default commands without model flags:

```python
codex exec --json --ephemeral --skip-git-repo-check -s workspace-write -C WORKSPACE PROMPT
claude --print --output-format stream-json --no-session-persistence --permission-mode acceptEdits --mcp-config CONFIG PROMPT
opencode run --format json --dir WORKSPACE PROMPT
```

Use runtime-specific environment variables only for config discovery; do not copy credentials into evidence.

- [ ] **Step 4: Write failing usage-normalization tests**

Use compact fixtures for:

- OpenCode `step_finish.part.tokens` and `part.cost` events;
- Codex JSONL token-usage events;
- Claude stream-json `result` usage and `total_cost_usd`;
- malformed output and successful output with no accounting.

Expected normalized behavior:

```python
self.assertEqual(usage.output, 1076)
self.assertEqual(usage.estimated_cost_usd, 0.007476282)
self.assertIsNone(missing.estimated_cost_usd)
self.assertEqual(missing.unavailable_reason, "runtime did not expose usage")
```

- [ ] **Step 5: Implement streaming parsers and GREEN the tests**

Parse line-by-line with bounded integer/float validation. Sum OpenCode step costs, use Codex totals from the final usage event, and use Claude's final result object. Never infer subscription cost from token counts.

Run:

```bash
python3 tests/twin2silicon-hil.py -k RuntimeAdapterTests
```

Expected: all adapter tests pass.

- [ ] **Step 6: Commit Task 1**

```bash
git add benchmarks/twin2silicon/runtime_adapters.py tests/twin2silicon-hil.py
git commit -m "feat(bench): define native runtime adapters"
```

### Task 2: Add shared instructions and runtime-native MCP configuration

**Files:**
- Create: `benchmarks/twin2silicon/shared-agent-instructions.md`
- Create: `benchmarks/twin2silicon/runtime-config/opencode.json`
- Create: `benchmarks/twin2silicon/runtime-config/claude-mcp.json`
- Modify: `tests/twin2silicon-hil.py`

- [ ] **Step 1: Write failing configuration-contract tests**

Assert that shared instructions:

- require the smallest firmware repair;
- permit only public workspace access;
- prohibit hidden-oracle access and self-grading;
- require compile evidence;
- cap repair attempts at the task budget;
- name LabWired MCP tools as optional context/compile aids, not as the final oracle.

Parse both JSON configs and assert they launch exactly:

```json
{"command": "npx", "args": ["-y", "@labwired/mcp"]}
```

Assert the OpenCode config declares no `model` key. Codex MCP is supplied through isolated TOML generated by `run_agent.py`, so the contract test checks the generated TOML rather than a third static config.

- [ ] **Step 2: Run focused tests and verify RED**

```bash
python3 tests/twin2silicon-hil.py -k RuntimeConfigurationTests
```

Expected: missing instruction/config files.

- [ ] **Step 3: Add the minimal shared instruction file**

Keep it below 700 words and reuse the behavioral substance of `skills/develop/SKILL.md`: inspect, ground, edit, compile, report evidence, do not claim hardware success.

- [ ] **Step 4: Add native MCP configs**

OpenCode config uses a local `labwired` MCP entry and existing permission allowlist, but omits provider/model declarations so the installed native default remains authoritative. Claude config uses `mcpServers.labwired.command = "npx"` and `args = ["-y", "@labwired/mcp"]`.

Generate Codex TOML in the trial config directory:

```toml
[mcp_servers.labwired]
command = "npx"
args = ["-y", "@labwired/mcp"]
```

- [ ] **Step 5: Run tests and commit Task 2**

```bash
python3 tests/twin2silicon-hil.py -k RuntimeConfigurationTests
git add benchmarks/twin2silicon/shared-agent-instructions.md benchmarks/twin2silicon/runtime-config tests/twin2silicon-hil.py
git commit -m "feat(bench): share LabWired instructions across runtimes"
```

### Task 3: Implement one bounded agent trial

**Files:**
- Create: `benchmarks/twin2silicon/run_agent.py`
- Modify: `tests/twin2silicon-hil.py`

- [ ] **Step 1: Write failing end-to-end fake-runtime tests**

Create one fake executable per runtime. Each fake:

- validates its expected native argv;
- confirms the candidate starts with `GPIO_MODE_INPUT`;
- changes only that token to `GPIO_MODE_OUTPUT`;
- emits representative native JSON usage;
- exits zero.

Invoke `run_agent.py` and assert:

```python
self.assertEqual(result["status"], "completed")
self.assertEqual(result["runtime"], runtime)
self.assertIsNone(result["model_override"])
self.assertIn("GPIO_MODE_OUTPUT", candidate_source)
self.assertTrue((trial / "agent.stdout.log").is_file())
self.assertTrue((trial / "agent.stderr.log").is_file())
self.assertTrue((trial / "usage.json").is_file())
```

Add cases for nonzero exit, timeout, missing executable, malformed JSON, and an existing output directory. Assert none exposes or copies the hidden oracle.

- [ ] **Step 2: Run focused tests and verify RED**

```bash
python3 tests/twin2silicon-hil.py -k RunAgentTests
```

Expected: `run_agent.py` missing.

- [ ] **Step 3: Implement the single-trial CLI**

CLI:

```text
run_agent.py RUNTIME --task TASK --output TRIAL_DIR
             [--executable PATH] [--timeout-seconds N]
```

Behavior:

1. reject an existing output path;
2. read `task.json` only to locate `public_dir` and budgets;
3. copy only `public_dir` to `TRIAL_DIR/candidate`;
4. combine the model-neutral task prompt with shared instructions;
5. write runtime-native config under `TRIAL_DIR/runtime-config`, copy the same
   shared instruction text to `candidate/AGENTS.md` for Codex/OpenCode and
   `candidate/CLAUDE.md` for Claude Code;
6. invoke `run_command` with the adapter's argv and bounded timeout;
7. parse usage without failing the trial when accounting is unavailable;
8. atomically write `agent-result.json` and `usage.json`.

Set `agent-result.status` to `completed`, `failed`, `timeout`, or `infrastructure_error`. Record monotonic elapsed time, exit code, and executable version. Do not run HIL here.

- [ ] **Step 4: Run focused and full offline tests**

```bash
python3 tests/twin2silicon-hil.py -k RunAgentTests
python3 tests/twin2silicon-hil.py
```

Expected: all tests pass.

- [ ] **Step 5: Commit Task 3**

```bash
git add benchmarks/twin2silicon/run_agent.py tests/twin2silicon-hil.py
git commit -m "feat(bench): run one native agent trial"
```

### Task 4: Add the sequential runtime matrix and normalized summary

**Files:**
- Create: `benchmarks/twin2silicon/run_matrix.py`
- Modify: `tests/twin2silicon-hil.py`

- [ ] **Step 1: Write failing matrix tests**

Use fake adapters and a fake HIL executable to assert:

- runtime order is `opencode`, `codex`, `claude`;
- each receives byte-identical public input hashes;
- one adapter failure does not prevent later trials;
- HIL runs only for completed candidates;
- the hidden-oracle path appears only in HIL argv, never adapter argv/logs;
- summary rows retain unknown usage as `null` plus a reason.

Expected summary skeleton:

```json
{
  "schema_version": "1.0",
  "task_id": "esp32s3-gpio-hil-001",
  "trials": [
    {"runtime": "opencode", "agent_status": "completed", "hil_status": "pass"},
    {"runtime": "codex", "agent_status": "failed", "hil_status": "not_run"},
    {"runtime": "claude", "agent_status": "completed", "hil_status": "fail"}
  ]
}
```

- [ ] **Step 2: Run focused tests and verify RED**

```bash
python3 tests/twin2silicon-hil.py -k RuntimeMatrixTests
```

Expected: `run_matrix.py` missing.

- [ ] **Step 3: Implement the matrix CLI**

CLI:

```text
run_matrix.py --task TASK --output MATRIX_DIR
              --jtag-serial SERIAL --uart-device DEVICE --openocd PATH
              [--runtime opencode --runtime codex --runtime claude]
              [--agent-only]
```

Run trials sequentially because one physical board is shared. Invoke the existing `run_hil.py` as a child process with each completed candidate. Pass `--usage-json` only when the adapter produced all numeric fields required by the existing HIL cost schema; otherwise let HIL record `cost: null` and retain the explicit unavailable reason in the matrix row. Read, do not reinterpret, each HIL `run.json`. Atomically write `matrix.json` after every trial and print a fixed-width summary at completion.

- [ ] **Step 4: Verify matrix failure isolation and full suite**

```bash
python3 tests/twin2silicon-hil.py -k RuntimeMatrixTests
python3 tests/twin2silicon-hil.py
```

Expected: all tests pass; fake matrix contains all three rows after an injected middle failure.

- [ ] **Step 5: Commit Task 4**

```bash
git add benchmarks/twin2silicon/run_matrix.py tests/twin2silicon-hil.py
git commit -m "feat(bench): compare native runtimes with one HIL oracle"
```

### Task 5: Add operator entry points and documentation

**Files:**
- Create: `tests/twin2silicon-runtime-smoke.sh`
- Create: `benchmarks/twin2silicon/README.md`
- Modify: `package.json`
- Modify: `tests/twin2silicon-hil.py`

- [ ] **Step 1: Write failing packaging/entry-point assertions**

Extend the existing contract tests to require:

```json
{
  "test:runtime-smoke:offline": "python3 tests/twin2silicon-hil.py",
  "test:runtime-smoke:hardware": "bash tests/twin2silicon-runtime-smoke.sh"
}
```

Assert the shell entry point refuses to run unless `LABWIRED_HIL=1`, requires explicit UART/JTAG/OpenOCD values, places temporary data on `/Volumes/LabWired` when available, and never contains credentials.

- [ ] **Step 2: Run tests and verify RED**

```bash
python3 tests/twin2silicon-hil.py -k RuntimePackagingTests
```

Expected: scripts and package commands missing.

- [ ] **Step 3: Implement the opt-in shell entry point**

The script validates installed `opencode`, `codex`, `claude`, `pio`, and OpenOCD; prints their versions; then invokes `run_matrix.py` with explicit hardware arguments. It never reads API secrets itself—each native runtime uses its existing authenticated session.

- [ ] **Step 4: Document experiment interpretation**

Document:

- this is a runtime smoke comparison, not a leaderboard claim;
- native models are intentionally not overridden;
- raw model comparisons require the separate OpenCode model matrix;
- missing subscription cost remains unknown;
- connected hardware is modified by flash operations;
- every publishable result needs multiple tasks and repeated fresh trials.

- [ ] **Step 5: Run offline verification and commit Task 5**

```bash
npm run test:runtime-smoke:offline
bash tests/twin2silicon-runtime-smoke.sh
```

Expected: offline suite passes; hardware script exits with a clear `LABWIRED_HIL=1 required` message when not opted in.

```bash
git add benchmarks/twin2silicon/README.md tests/twin2silicon-runtime-smoke.sh package.json tests/twin2silicon-hil.py
git commit -m "docs(bench): add cross-runtime smoke entry points"
```

### Task 6: Run the connected-board smoke matrix

**Files:**
- Runtime evidence only under an explicit matrix output directory outside tracked source.

- [ ] **Step 1: Verify authentication without exposing credentials**

Run native read-only status commands for OpenCode/LabWired, Codex, and Claude Code. Record only runtime versions and authenticated/not-authenticated status.

- [ ] **Step 2: Confirm the target S3 identity**

Use the existing serial/JTAG identification command to confirm the selected device is ESP32-S3 and record its serial. Do not select by port order alone.

- [ ] **Step 3: Run one fresh native trial per runtime**

Example:

```bash
LABWIRED_HIL=1 \
LABWIRED_UART_DEVICE=/dev/cu.usbmodem11101 \
LABWIRED_JTAG_SERIAL=3C:0F:02:DF:EC:F8 \
LABWIRED_OPENOCD="$HOME/.platformio/packages/tool-openocd-esp32/bin/openocd" \
LABWIRED_MATRIX_OUTPUT=/Volumes/LabWired/hil-runs/runtime-smoke-$(date +%Y%m%d-%H%M%S) \
bash tests/twin2silicon-runtime-smoke.sh
```

Expected: three trial directories and a parseable `matrix.json`; individual failures remain rows rather than aborting the matrix.

- [ ] **Step 4: Verify evidence and summarize honestly**

Check every completed candidate's `run.json`, artifact hashes, UART nonce, and register observations. Report success, time, tokens, cost availability, and infrastructure issues without claiming a general winner.

- [ ] **Step 5: Run final repository verification**

```bash
npm run test:runtime-smoke:offline
python3 tests/twin2silicon-hil.py
git diff --check
git status --short
```

Expected: all offline tests pass, diff check is clean, and only pre-existing `out/` remains untracked.
