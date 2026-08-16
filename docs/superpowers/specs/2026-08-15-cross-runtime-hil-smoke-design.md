# Cross-Runtime HIL Smoke Test Design

## Goal

Measure how effectively OpenCode, Codex CLI, and Claude Code use the same
LabWired hardware context to repair one ESP32-S3 firmware defect. Each runtime
uses its native/default model. The existing physical HIL oracle, not the agent,
decides success.

## Scope

The first smoke test runs one fresh trial for each runtime on
`esp32s3-gpio-hil-001`. It proves adapter portability and produces comparable
evidence before the benchmark grows to more tasks or repeated trials.

This work does not add another orchestration framework, sandbox, scheduler,
leaderboard service, or generalized experiment engine. It does not claim model
or runtime superiority from three single trials.

## Experimental Controls

All three trials receive the same:

- public task directory and seeded defect;
- model-neutral repair prompt;
- LabWired firmware skill instructions;
- LabWired MCP server where the runtime supports MCP;
- wall-time and repair-attempt budgets;
- physical ESP32-S3, UART port, JTAG identity, nonce policy, and hidden oracle;
- build, flash, UART, and register scoring implementation.

The runtime and its native/default model are the independent variable. Built-in
runtime tools, context management, system prompts, and token accounting are
part of the runtime being measured and must be disclosed rather than hidden.

## Architecture

The implementation adds three thin candidate-generation adapters behind one
small command-line interface:

```text
fresh public task
       |
       +-- OpenCode adapter ----+
       +-- Codex adapter -------+--> candidate workspace --> existing run_hil.py
       +-- Claude adapter ------+                              |
                                                               +--> run.json
                                                               +--> cost.json
```

An adapter may prepare runtime-native skill or MCP configuration, launch the
runtime, and normalize its usage output. It must not compile, flash, inspect
hidden files, score hardware, or reinterpret the oracle result in controller
code. Runtime-native compilation during repair is allowed, but final scoring
always uses `benchmarks/twin2silicon/run_hil.py`.

## Adapter Contract

Each adapter accepts:

- runtime name;
- public task directory;
- fresh output directory;
- shared prompt file;
- wall-time limit.

Each adapter produces:

- `candidate/`: the runtime's final public workspace;
- `agent.stdout.log` and `agent.stderr.log`;
- `agent-result.json`: normalized runtime status and timing;
- `usage.json`: normalized token rates and estimated cost when the runtime
  exposes enough information; otherwise explicit `null` fields and a reason.

`agent-result.json` contains the runtime, reported native model when available,
exit status, timeout flag, elapsed seconds, repair status, and paths to raw
logs. Raw runtime output remains available for later auditing.

## Skills and MCP

The canonical LabWired firmware instructions remain in the repository. Each
adapter maps them into the runtime's supported instruction mechanism without
rewriting their substance:

- OpenCode uses the existing LabWired skills and MCP configuration.
- Codex receives repository instructions plus the LabWired MCP registration.
- Claude Code receives repository instructions plus the LabWired MCP
  registration.

Tool names may differ because runtimes namespace MCP tools differently. The
adapter may map names, but the underlying LabWired MCP server and tool behavior
must be identical.

## Evaluation Flow

For each runtime, the controller:

1. copies only the public task into a fresh workspace;
2. installs the runtime-specific instruction and MCP adapter;
3. invokes the native/default model with the shared prompt and time limit;
4. records raw output, normalized timing, usage, and cost;
5. passes the final candidate to the existing HIL runner;
6. records the authoritative compile, flash, UART, and register result;
7. emits one comparison row without changing or repairing the candidate.

An adapter failure is recorded as an infrastructure failure. A clean agent exit
with an incorrect candidate is a benchmark failure. Missing token accounting is
reported as unknown rather than estimated from unrelated data.

## Comparison Output

The smoke test emits a JSON summary and a concise table with:

- runtime and reported native model;
- agent exit/timeout status;
- compile and physical HIL status;
- final success;
- elapsed agent and HIL time;
- repair/tool-call counts when observable;
- fresh, cached, reasoning, and output tokens when observable;
- API or subscription cost when observable;
- invalid tool calls and infrastructure error category.

Values unavailable from a native runtime are `null` with a reason. Subscription
access is not converted into a fictitious per-run API price.

## Error Handling

Every trial uses a new output directory and bounded subprocess execution. A
failed adapter cannot prevent the remaining runtime trials from running. The
controller never retries a model silently; every extra model attempt would be a
new recorded trial. It refuses to overwrite an existing trial directory and
never modifies the public fixture or hidden oracle.

## Testing

Offline tests use fake runtime executables to verify:

- identical fresh candidate inputs;
- exact native/default-model behavior (no model override);
- prompt and instruction delivery;
- bounded timeout and nonzero-exit classification;
- normalized output with explicit unknown usage;
- continued execution after one adapter fails;
- invocation of the existing HIL boundary without exposing hidden files to an
  adapter.

One opt-in connected-board smoke test then runs the three installed runtimes on
the ESP32-S3 fixture. Its results are evidence, not a unit-test prerequisite.

## Acceptance Criteria

- OpenCode, Codex CLI, and Claude Code each run through a thin native adapter.
- No adapter specifies a non-native model override.
- All candidates are created from identical public bytes.
- All final candidates are scored by the unchanged HIL entry point.
- Results use one normalized schema while retaining raw logs.
- Unknown tokens or costs are explicit and never fabricated.
- Existing HIL tests remain green and `out/` remains untouched.
