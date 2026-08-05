# Shared tools + Desktop Agent full loop

**Date:** 2026-08-05  
**Status:** Approved (implement)  
**Shell for v1 golden path:** Desktop / CLI agent (`labwired` + Editor)  
**Backend:** One shared LabWired tool + knowledge surface

## Product definition

Every agent surface (Playground Architect, Desktop Editor, CLI `labwired`, Claude Code/Codex) uses the **same** tools and knowledge:

- MCP registry: `labwired_*` (list, describe, compile, run, verify, part, datasheet, …)
- Hosted: `https://api.labwired.com/mcp`
- Model gateway: `https://api.labwired.com/v1` (`labwired-default`)
- Oracle rule: success only when `labwired_verify` → `status: model_verified`

Shells differ (chat UI, install, auth). **Tools do not.**

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
