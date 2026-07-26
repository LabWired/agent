# LabWired agent

A batteries-included **firmware agent**: [opencode](https://opencode.ai) (MIT) wired to LabWired's
deterministic **hardware oracle** — the MCP server, the skills, and a **local / on-prem model**.

Every AI can write firmware now. LabWired is the layer that **proves it runs** — the same binary in
sim, on the bench, and in CI, byte-exact. This agent proposes firmware and then proves it with the
oracle. It never claims firmware works on its own say-so.

> **No fork, no new agent.** This is a thin distribution layer over stock opencode: a bundled config
> that registers the `@labwired/mcp` server, points the model at a local endpoint, and ships the
> `firmware-verification` skill. The IP is the oracle and the skills — the harness stays upstream.

## Install

```bash
git clone https://github.com/LabWired/agent && cd agent
./install.sh
```

It installs opencode, drops the LabWired config + skills into `~/.config/opencode/`, and adds a
branded `labwired` launcher. You also need the LabWired simulator CLI on PATH:

```bash
curl -fsSL https://labwired.com/install.sh | sh
```

## Run

```bash
# 1. a local model — default expects Ollama + Qwen2.5-Coder
ollama pull qwen2.5-coder && ollama serve

# 2. launch
labwired
```

Verify the wiring: `opencode mcp list` should show the `labwired` server and the `labwired_*` tools.
Ask it to build something and it will drive `labwired_verify` — and refuse to call it "working" until
the oracle returns `proven: true`.

## Configuration (env)

| Var | Default | Purpose |
|---|---|---|
| `LABWIRED_MODEL_URL` | `http://127.0.0.1:11434/v1` | OpenAI-compatible model endpoint (Ollama / vLLM / llama.cpp / NIM) |
| `LABWIRED_MODEL_KEY` | `local` | API key for the endpoint (Ollama ignores it) |
| `LABWIRED_BUILDER_URL` | *(empty)* | LabWired builder for source→ELF compile + serial/register/gpio verify |
| `LABWIRED_CLI` | `labwired` | Path to the local simulator binary |

Model default is **Qwen2.5-Coder**; point `LABWIRED_MODEL_URL` at any OpenAI-compatible server to
change it (vLLM for on-prem throughput, a frontier cloud endpoint for the highest-quality Pro path).

## What runs offline vs. what needs a builder

The local `labwired` CLI + `@labwired/mcp` run **fully offline**: `describe`, `list`, `validate`,
`run`, `inspect`, `fuzz`, and **display-oracle** `verify` — against a precompiled `firmware_ref`.

**Source→ELF compile** and **serial/register/gpio-oracle verify** route to a LabWired **builder**.
For the full loop offline (ITAR / air-gapped), self-host the builder in your vault and set
`LABWIRED_BUILDER_URL`. Without it, compile/serial-verify report a clean "no builder configured" error
— never a silent internet call, and never an unverifiable pass.

## Air-gapped / ITAR profile

Use [`config/opencode.airgap.json`](./config/opencode.airgap.json): it restricts providers to the
local model (`enabled_providers`), disables autoupdate and sharing, and expects in-vault
`LABWIRED_MODEL_URL` / `LABWIRED_BUILDER_URL`. Place it at a **managed** path so users can't override
it — `/etc/opencode/opencode.json` (Linux) or `/Library/Application Support/opencode/opencode.json`
(macOS). The oracle needs **no AI in the vault**; only the model endpoint is swapped for on-prem weights.

## What's in here

```
config/opencode.json          default profile (local or cloud model)
config/opencode.airgap.json   locked on-prem / ITAR profile
config/AGENTS.md              the agent's standing rule: propose / prove, never self-report success
bin/labwired                  branded launcher over opencode
skills/firmware-verification  the oracle-gate skill (vendored; also at github.com/LabWired/skills)
install.sh
```

## Credits & license

Built on [opencode](https://github.com/anomalyco/opencode) (MIT) — not affiliated with or endorsed by
the opencode project. This distribution layer is MIT-licensed; see [LICENSE](./LICENSE). opencode
retains its own license.
