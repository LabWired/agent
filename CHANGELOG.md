# Changelog

## 0.1.0 — 2026-07-28

### Product
- Public Firmware Agent kit: install, skills, claim rules
- Tagline: *the easiest way to write firmware*
- One-command install: `curl -fsSL https://labwired.com/agent-install.sh | sh`
- Six skills (verify, diagnose, inspect, board-bringup, scaffold, report)
- Gate 1 red→green demo fixtures and claim artifacts
- Dual path: turnkey agent or Claude/Codex via MCP

### Packaging
- `scripts/agent-install.sh` bootstrap into `~/.labwired/agent`
- npm package `@labwired/agent` (install wrapper)
- Plain-language README and product packaging doc
