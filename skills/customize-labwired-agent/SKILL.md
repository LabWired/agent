---
name: customize-labwired-agent
description: >-
  Use when the user is editing LabWired Agent configuration under
  ~/.config/labwired-agent/ (or LABWIRED_AGENT_CONFIG_DIR): agent.json-equivalent
  runtime files, tui.json, themes, plugins, skills, AGENTS.md, MCP (labwired),
  providers/models, permissions, or install/login. Prefer product names
  (LabWired Agent, Hosted / Default / Fast, labwired agent login). Do not use
  for the user's firmware/application code.
license: MIT
compatibility: opencode
metadata:
  labwired: "true"
  pack: "product"
---

# Customize LabWired Agent

Product-facing skill for changing **LabWired Agent** itself — not the user's firmware project.

## What this skill owns

| Path / surface | Role |
|----------------|------|
| `~/.config/labwired-agent/opencode.json` | Agent runtime config (MCP, provider, model, permissions) |
| `~/.config/labwired-agent/tui.json` | Theme + brand plugin |
| `~/.config/labwired-agent/plugins/labwired-brand.tsx` | Home logo / product chrome |
| `~/.config/labwired-agent/themes/labwired.json` | Theme |
| `~/.config/labwired-agent/skills/` | Skills packs |
| `~/.config/labwired-agent/AGENTS.md` | Agent instructions / claim rules |
| `labwired agent login` / session | Hosted auth (not engine connect) |

Kit sources live under the install prefix, e.g. `~/.labwired/agent/config/`, `plugins/`, `skills/`.

## Product names (always)

- Product: **LabWired Agent** (`labwired agent`)
- Hosted provider label: **Hosted** · models **Default** / **Fast**
- Auth: **`labwired agent login`** (LabWired account) — never engine /connect or third-party marketplaces
- Config dir: **`~/.config/labwired-agent/`** (product path). Runtime file may still be named `opencode.json` inside that dir (engine filename).

## Hard rules

1. Prefer LabWired wording in any user-visible copy you edit.  
2. Keep hosted MCP as remote `https://api.labwired.com/mcp` with Bearer from session unless the user explicitly wants local/airgap.  
3. Do not seed engine `auth.json` for LabWired — session is `~/.labwired/session/cloud.json`.  
4. Do not invent pinouts or green claims in AGENTS.md — preserve oracle vocabulary (`model_verified` only via `labwired_verify`).  
5. After config changes, remind: restart with `labwired agent` (and `labwired agent login` if hosted).

## Common edits

### Switch model SKU
Hosted: `labwired/labwired-default` or `labwired/labwired-fast` in `opencode.json` `model`.

### Local / BYO model
User sets `LABWIRED_MODEL_URL` + `LABWIRED_MODEL_KEY` and uses local config profile — do not force Ollama defaults.

### Permissions / skills
Use `permission.skill` allow/deny. Built-in skill id `customize-opencode` stays **deny** (product uses this skill instead).

### Branding
Logo/theme via `tui.json` plugin `labwired-brand.tsx` and theme `labwired`.

## Out of scope

- Writing the user's embedded firmware  
- Upstream marketing features (Zen, Go, share)  
- Changing the engine's internal filename `opencode.json` (engine requirement)
