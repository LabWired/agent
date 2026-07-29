# Testing LabWired Agent

## Quick

```bash
npm test                 # full matrix (tests/all.sh)
npm run test:unit        # harness + skills + public + prefix
npm run test:install     # portable install into temp prefix
npm run test:llm         # DeepInfra Kimi (needs key)
```

## Lanes

| Lane | Script | Network | Notes |
|------|--------|---------|-------|
| harness | `tests/harness.sh` | no | resolve-sim, MCP, claim gate, score, serial |
| skills | `tests/skills-inventory.sh` | no | 9 skills + AGENTS vocabulary |
| public-install | `tests/public-install.sh` | no | syntax + Cursor-style entries |
| prefix-unit | `tests/prefix-unit.sh` | no | LABWIRED_HOME isolation |
| install-smoke | `tests/install-smoke.sh` | yes | full portable install + smoke |
| llm-deepinfra | `tests/llm-deepinfra.sh` | yes | optional DeepInfra chat |

## DeepInfra + Kimi (coding)

Never commit API keys.

```bash
export DEEPINFRA_API_KEY="…"          # from deepinfra.com dashboard
# optional:
export LABWIRED_LLM_MODEL="moonshotai/Kimi-K2.5"
# or put key in:
#   ~/.local/secrets/labwired.env
#   DEEPINFRA_API_KEY=…

bash tests/llm-deepinfra.sh
```

With key set at **install** time, OpenCode uses `config/opencode.deepinfra.json`
(model `deepinfra/moonshotai/Kimi-K2.5`).

Repo secret for CI: `DEEPINFRA_API_KEY` (optional job in `.github/workflows/harness.yml`).

## Workflow

Grok workflow (local): copy `docs/workflows/agent-test-matrix.rhai` into
`.grok/workflows/` if needed. Pass **`args.root`** (absolute path to this repo).
The workflow returns a summary only — it does not write reports into the tree.
