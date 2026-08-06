# Changelog

## 0.3.7 — 2026-08-06 — Close top gaps (knowledge, ship-gate, compose, start-here)

1. **Knowledge heroes** — `kit-heroes.json` + `scripts/knowledge-top-parts.py` (local catalog + MCP probe)
2. **Ship gate** — `./scripts/ship-gate.sh` (doctor, assert, live twin, compose, knowledge, golden-path-first)
3. **Observe CLI** — `labwired compose uart|capture` for agent-callable element assembly
4. **Start-here** — README single door (OpenCode + packs); Architect secondary
5. **Golden-path first** — AGENTS + opencode agent description; Superpowers secondary on firmware

## 0.3.6 — 2026-08-06 — Drop legacy skill interfaces

### Breaking (skill names)
- Removed old micro-skill dirs: `verify-firmware`, `part-knowledge`, `board-bringup`, etc.
- **Only** domain packs remain: `golden-path`, `bringup`, `prove`, `observe`, `desk-hw`
- Superpowers process skills still prepacked
- OpenCode allowlists cleaned; stale aliases deleted on prepare/sync

## 0.3.5 — 2026-08-06 — Superpowers prepacked + MCP knowledge

### Process + domain in one kit
- **Superpowers** skills prepacked under `skills/` (TDD, plans, systematic-debugging, …)
- LabWired-adapted **`using-superpowers`**: claim rules + **`labwired_part` / `labwired_datasheet`** win over generic process advice
- OpenCode allowlists include domain packs **and** Superpowers
- `skills/README.md` documents both layers + MCP knowledge plane

```bash
labwired   # prepare copies all skills into ~/.config/opencode/skills
```

## 0.3.4 — 2026-08-06 — Skill packs (5 primary, not 12)

### Organize skills
- **5 packs:** `golden-path` · `bringup` · `prove` · `observe` · `desk-hw`
- **11 thin aliases** keep old names (`verify-firmware`, `part-knowledge`, …) → redirect to packs
- `skills/README.md` map; AGENTS.md + doctor check primary packs only
- Full content lives in packs (claim rules unchanged)

```text
bringup → prove → optional observe → optional desk-hw
# or just: golden-path
```

## 0.3.3 — 2026-08-06 — Remaining automatable Wave B/C

### Knowledge / coverage
- `scripts/coverage-ratchet.sh` — top-20 vs catalog-facts + twin systems
- Published `share/catalog/coverage-latest.json` + `.md` (local kit count)

### Evidence / dual-claim
- `scripts/report-evidence.py` — dual-claim markdown; optional `--require-evidence-on-green`
- `verify-firmware` hands off to report-evidence on green

### Observability
- `scripts/compose-from-capture.py` — LA CaptureObject / edge CSV → elements
- Sample fixture `fixtures/observability/sample-capture.json`

### Docs
- `docs/REVERSE_STEP_DEMO.md` — same-binary twin green + F5 reverse-step

### Smoke
- `./scripts/smoke-remaining.sh` — Wave A + coverage + report + LA compose

```bash
./scripts/smoke-remaining.sh
./scripts/coverage-ratchet.sh
```

## 0.3.2 — 2026-08-05 — Wave A automated close-out

### Proven (automated smoke)
- **`scripts/smoke-wave-a.sh`** — doctor, offline assert, **live-gate1** twin red→green, E3 compose
- **`scripts/compose-elements.py`** + `share/observability/element-catalog.json`
- **`labwired_cloud_ensure_project`** — heal empty project_id after login
- **`share/catalog/coverage-top20.json`** — knowledge coverage ratchet list
- Doctor checks golden-path / part-knowledge / compose-observability skills
- Sim still optional; debugger first-class

### Run
```bash
./scripts/smoke-wave-a.sh
./scripts/live-gate1.sh
python3 scripts/compose-elements.py --uart fixtures/gate1-live/evidence/fixed/uart.log
```

## 0.3.1 — 2026-08-05 — Embedder offerings coverage (Wave A/B skills)

### Skills / SOTA loop
- **`golden-path`** — stranger path: knowledge → scaffold → verify → report → optional plot
- **`part-knowledge`** — pin/part/datasheet via tools only; never invent
- **`compose-observability`** — E3 LED vs UART recipe; plots = elements
- AGENTS.md default loop + tool allowlist for part/datasheet/compile
- OpenCode skill allowlist (local + hosted) includes new skills
- **Sim not forced:** debugger / probe is first-class when twin missing; never rename debug success to `model_verified`

### Docs
- `docs/GOLDEN_PATH.md` — install → login → prove walkthrough
- README skills table + golden-path pointer

### CLI
- Soft notes when no local sim (login / debugger options); doctor warn stays non-fatal

### Tests
- skills-inventory / harness / fw-usecase skill lists updated

## 0.3.0 — 2026-08-05 — First product release

### Ship
- **Hosted OpenCode path:** `labwired login` → device-code auth → remote MCP (`api.labwired.com/mcp`) + model gateway (`labwired-default`)
- **Shared tools:** same `labwired_*` surface as playground and VS Code
- **Agent workbench extension** tracked under `extensions/labwired-vscode` (Embedder-class chrome + twin verify)
- OpenCode skills refresh on start; `labwired agent` alias; doctor reports cloud session

### Reliability
- Prefer kit next to `bin/` over stale install prefix
- Fix `labwired help` recursive hang (quoted heredoc)
- Hosted config + session unit tests

### Install
```bash
curl -fsSL https://labwired.com/install | bash
labwired doctor
labwired login   # optional hosted
labwired         # OpenCode agent
```


## 0.2.9 — 2026-07-30

### One-line install (really easy)
- Public install always refreshes kit (re-run = update)
- Success banner: only `labwired` / `labwired doctor`
- Windows: zip download (no git required) + `install.ps1` one-liner
- README leads with a single command per OS
- Install copies `share/` catalog into the prefix

## 0.2.8 — 2026-07-30

### Live twin catalog + Gate 1
- `share/catalog/` — thin system YAMLs (chip names bundled in labwired-sim; no monorepo)
- `lib/resolve-catalog.sh` + `scripts/sync-catalog.sh`
- `scripts/live-gate1.sh` — real twin red→green on bare-metal UART0 ELFs
- `fixtures/gate1-live/` — fixed/broken prebuilt ELFs (copy of core C3 blinky path)

## 0.2.7 — 2026-07-29

### Board-agnostic product surface
- Generic `scripts/dev-cycle.sh` driven by `LABWIRED_HW_*` (ws, port, marker, chip, system)
- ESP32-C3 is an **example profile** only (`examples/esp32c3-serial`, `scripts/profiles/`)
- Default serial marker `LABWIRED_OK`; fixture `fixtures/hw-serial-esp32c3`
- AGENTS + skills use generic HW env (no C3-as-product wording)
- Compat shim: `scripts/c3-dev-cycle.sh` → profile

## 0.2.6 — 2026-07-29

### Keep the product tree clean
- Drop machine-local twin yamls from C3 canary workspace (matrix system lives in core)
- Remove internal design/research dumps under `docs/superpowers` and `docs/plans`
- Test-matrix workflow reports via result only (no report files in-repo)
- Tighter `.gitignore` for evidence, build products, secrets

## 0.2.5 — 2026-07-29

### Test matrix
- `tests/all.sh` — harness, skills, public-install, prefix-unit, install-smoke, optional LLM
- `tests/llm-deepinfra.sh` — DeepInfra OpenAI-compatible chat (`moonshotai/Kimi-K2.5`)
- `config/opencode.deepinfra.json` — auto-selected when `DEEPINFRA_API_KEY` is set at install
- CI: unit + install-smoke + optional llm job (repo secret)
- Workflow: `.grok/workflows/agent-test-matrix.rhai`
- Docs: `docs/TESTING.md`

## 0.2.4 — 2026-07-29

### Fast portable install + install→run loop
- One-liner prefers **tarball** (no git required); git fallback
- Default **fast**: sim + probe, **PIO off** (`--with-pio` / `LABWIRED_INSTALL_PIO=1`)
- Skip slow cargo probe-rs in fast mode
- Portable shim activates full prefix (no manual `source` required)
- Soft PATH hook into shell rc
- **`labwired smoke`** — claim gate + sim + skills + opencode
- Install ends with smoke PASS and clear `labwired` run instructions
- Relocatable: `LABWIRED_HOME=/any/path ./install.sh` verified

## 0.2.3 — 2026-07-29

### Cursor-style install + self-update
- Public entry: `scripts/public/install` → `curl -fsSL https://labwired.com/install | bash`
- Windows entry: `scripts/public/install.ps1` → `irm 'https://labwired.com/install?win32=true' | iex`
- `labwired update` / `self-update` / `upgrade` (like Cursor `agent update`)
- `labwired update --check` / `--tools-only`
- Windows: `labwired update` in `labwired.ps1`
- Deploy notes: `scripts/public/DEPLOY.md`

## 0.2.2 — 2026-07-29

### Windows + easy multi-platform install
- Native Windows installer: `scripts/install.ps1`, bootstrap `scripts/agent-install.ps1`
- One-liner: `irm https://labwired.com/agent-install.ps1 | iex`
- Launchers: `bin/labwired.ps1`, `bin/labwired.cmd`
- `npx @labwired/agent` routes to bash **or** PowerShell by OS
- Same portable prefix on Windows (`%USERPROFILE%\.labwired`)
- probe-rs from official Windows zip; sim auto-installs when core ships Windows assets
- Until then: hosted MCP twin path (documented) + optional WSL for local sim
- Docs: `docs/PORTABLE_INSTALL.md` platform matrix

## 0.2.1 — 2026-07-29

### Portable / contained install (multi-platform)
- Single managed prefix: `LABWIRED_HOME` (default `~/.labwired`) with `agent/`, `tools/`, `bin/`, `env.sh`, `MANIFEST.json`
- `./install.sh --prefix DIR` for USB / CI / `/opt` / project-local roots
- Tools install **into the prefix** (not scatter-only cargo/global bins)
- Platforms: darwin/linux × x86_64/aarch64 prebuilt sim; WSL for Windows
- `labwired package info|path|env|uninstall` for manageability
- `scripts/pack-portable.sh` + `docs/PORTABLE_INSTALL.md`
- Thin user PATH shim only (`~/.local/bin/labwired`)

### Full stack + skills
- Bootstrap **labwired-sim**, **probe-rs**, PlatformIO when missing
- `labwired install-deps` / `doctor --strict`
- Skills: `firmware-repair-loop`, `hw-promote`
- Libs: `score-verify`, `serial-capture`; `hardware_observed` claim

## 0.2.0 — 2026-07-28

### Boards
- `labwired probe` — physical multi-probe (probe-rs: ST-Link, J-Link, CMSIS-DAP, …) + virtual LabWired validation devices (sim)
- Skill `flash-firmware`
- Install documents probe backend (optional cargo install)
- Not OpenOCD-first

## 0.1.0 — 2026-07-28

### Product
- Public LabWired Agent kit: install, skills, claim rules
- One-command install: `curl -fsSL https://labwired.com/agent-install.sh | sh`
- Skills: verify, diagnose, inspect, board-bringup, scaffold, report
- Gate 1 red→green demo fixtures
- Dual path: turnkey agent or Claude/Codex via MCP

### Packaging
- `scripts/agent-install.sh` bootstrap into `~/.labwired/agent`
- npm package `@labwired/agent` (install wrapper)

