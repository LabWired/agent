# Shared tools + Desktop Agent full loop

**Date:** 2026-08-05  
**Status:** Approved (implement)  
**Shell for v1 golden path:** Desktop / CLI agent (`labwired` + Editor)  
**Backend:** One shared LabWired tool + knowledge surface

## Product definition

Every agent surface uses the **same** tools and knowledge — shells and brain loops differ:

| Surface | Brain / loop | Tools |
|---------|--------------|--------|
| Playground **Architect** | `/v1/agent` (browser) — keep separate product | Same LabWired verbs |
| **LabWired Agent** (this package: CLI / editor) | `/v1/chat/completions` + OpenCode | MCP `labwired_*` |
| Claude Code / Codex / Cursor | Customer’s agent | MCP only |

- MCP registry: `labwired_*` (list, describe, compile, run, verify, part, datasheet, …)
- Hosted tools: `https://api.labwired.com/mcp`
- Desk model gateway: `https://api.labwired.com/v1` (`labwired-default`)
- Oracle rule: success only when `labwired_verify` → `status: model_verified`

**Binding split:** platform `docs/strategy/two-agents.md`. Composer-shaped gateway work targets **this** package’s brain path, not Architect.

## v1 golden path (Desktop / CLI)

1. `labwired login` — device-code sign-in → Clerk → `lwd_` token  
2. Session stores token + project id under `~/.labwired/session/cloud.json`  
3. OpenCode config switches to **hosted**: remote MCP + gateway model  
4. User: “blink LED and prove it”  
5. Agent uses shared tools; claims green only after verify  

## Implementation (labwired-agent)

- `config/opencode.hosted.json` — remote MCP + `labwired/labwired-default`  
- `lib/cloud-session.sh` — save/load session, export env  
- `labwired login|logout|whoami` — device flow + project bootstrap  
- Install `--hosted` + login rewrites `~/.config/opencode/opencode.json`  
- Tests: `tests/hosted-config.sh`  

## Out of scope for this slice

- Code signing / Gatekeeper  
- Token $ metering (still request-capped on gateway)  
- Playground Architect changes (already shares MCP handlers)  
- Phase 2 private chip migration  
