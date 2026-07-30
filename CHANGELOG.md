# Changelog

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

