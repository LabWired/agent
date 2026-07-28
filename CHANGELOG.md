# Changelog

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

