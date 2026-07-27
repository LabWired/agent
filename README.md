# LabWired agent

**OpenCode harness** for LabWired’s deterministic firmware oracle.

This repository is the product surface for “agent + verification,” not the platform monorepo.

| Repo | Role |
|------|------|
| **[LabWired/agent](https://github.com/LabWired/agent)** (this repo) | Thin OpenCode distribution: launcher, config, skills, install |
| **[LabWired/skills](https://github.com/LabWired/skills)** | Shared skill sources (vendored here for offline install) |
| **w1ne/labwired** (platform monorepo) | MCP server, builder, board-config, Studio — **not** the agent shell |

> **No OpenCode fork.** Stock [OpenCode](https://opencode.ai) (MIT) + bundled config that registers `@labwired/mcp`, skills, and a local/on-prem model. The IP is the oracle and the claim rules; the harness stays upstream.

## Install → demo

```bash
git clone https://github.com/LabWired/agent && cd agent
./install.sh          # pin OpenCode, install launcher + config + skills
labwired doctor       # all ok, or exact install commands
./demo.sh             # structure + claim-gate tests; optional live verify if sim+MCP ready
labwired              # OpenCode
```

`install.sh` installs **pinned** `opencode-ai@1.18.7` (exact pin — bump deliberately), copies config + skills into `~/.config/opencode/`, and installs the `labwired` launcher to `~/.local/bin`.

Air-gapped / offline MCP:

```bash
# vendor @labwired/mcp into mcp/vendor/ (see mcp/README.md), then:
./install.sh --airgap
```

### Binary story

| Binary / env | Meaning |
|---|---|
| `labwired` (this repo) | OpenCode **agent launcher** |
| `LABWIRED_CLI` / auto-resolved sim | **Simulator** the MCP calls |
| `LABWIRED_MCP_ENTRY` / `mcp/vendor` | MCP server entry (airgap) |
| `opencode` | Pinned OpenCode CLI |

You also need the **simulator** binary for MCP `run` / `verify` (separate from this launcher):

```bash
curl -fsSL https://labwired.com/install.sh | sh
# If needed, point the harness at the real sim binary:
export LABWIRED_CLI=/path/to/labwired-simulator
```

The launcher **never** invents a fictional `labwired-cli` default and **never** treats itself as the simulator. Resolution order: `LABWIRED_CLI`, `LABWIRED_SIM`, then real PATH names (`labwired` if not this agent, `labwired-sim`, `labwired-cli`) only when they exist.

## Run

```bash
# 1. local model (default: Ollama + Qwen2.5-Coder)
ollama pull qwen2.5-coder && ollama serve

# 2. launch OpenCode with LabWired harness
labwired
```

Commands:

| Command | Purpose |
|---------|---------|
| `labwired` | Start OpenCode |
| `labwired doctor` | Preflight pin, simulator, config, skills |
| `labwired version` | Print harness + OpenCode pin |
| `labwired assert-status <status> [file]` | Hard claim gate on verify JSON (stdin or file) |
| `labwired help` | Usage |
| `./demo.sh` | One-command unit smoke (doctor soft-fail unless `DEMO_REQUIRE_DOCTOR=1`) |

`opencode mcp list` should show the `labwired` server and `labwired_*` tools.

## Skills (Gate 1)

| Skill | Job |
|-------|-----|
| `verify-firmware` | Mandatory-oracle model verification |
| `diagnose-firmware` | Fail first, patch, re-verify |
| `inspect-evidence` | Explain `evidence_ref` / status (read-only) |

**Claim vocabulary (fail-closed):**

- **model-verified** only when `labwired_verify.status === "model_verified"`
- **failed** / **inconclusive** / **unsupported** as typed by the oracle
- Never upgrade `proven: true` to hardware confirmation
- Humans/CI: `labwired assert-status model_verified < verify.json`

## Configuration (env)

| Var | Default | Purpose |
|---|---|---|
| `LABWIRED_MODEL_URL` | `http://127.0.0.1:11434/v1` | OpenAI-compatible model endpoint |
| `LABWIRED_MODEL_KEY` | `local` | API key (Ollama ignores it) |
| `LABWIRED_BUILDER_URL` | *(empty)* | Builder for source→ELF + some verify paths |
| `LABWIRED_CLI` / `LABWIRED_SIM` | *(resolved if present)* | Simulator binary the MCP shells out to |
| `LABWIRED_MCP_ENTRY` | *(optional)* | Absolute path to MCP `index.js` (airgap) |
| `OPENCODE_PIN` | `1.18.7` | Expected OpenCode version for `doctor` |

## Layout

```
bin/labwired                 branded launcher + doctor/version/assert-status
config/opencode.json         default profile
config/opencode.airgap.json  on-prem / ITAR profile
config/AGENTS.md             standing claim rules + assert-status gate
skills/                      three Gate 1 skills (verify / diagnose / inspect)
fixtures/gate1/              red→green oracle demo sources
lib/                         resolve-sim, resolve-mcp, assert-status
tests/harness.sh             shell unit tests for the harness
demo.sh                      one-command smoke
install.sh                   pin OpenCode + install config/skills/launcher
mcp/                         airgap vendor notes (+ optional vendor/)
```

## Air-gapped / ITAR

```bash
./install.sh --airgap   # requires LABWIRED_MCP_ENTRY or mcp/vendor/index.js
```

Or place a managed `opencode.json` (`/etc/opencode/opencode.json` or macOS Application Support). Restricts providers to the local model; set in-vault `LABWIRED_MODEL_URL` / `LABWIRED_BUILDER_URL`. The oracle needs **no AI** in the vault. See [mcp/README.md](mcp/README.md).

## What is intentionally not here

- Platform MCP/builder implementation (monorepo)
- Studio / Playground UI
- Hardware confirmation gateway
- Enterprise Helm / SSO

Those are separate products and gates. This repo is **only** the OpenCode harness.
