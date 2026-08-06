---
name: using-superpowers
description: >-
  Process skill router for OpenCode. Use when starting work: pick Superpowers
  process skills (TDD, plans, debug method) AND LabWired domain packs. LabWired
  claim rules and MCP tools always win over generic process advice.
license: MIT
compatibility: opencode
metadata:
  gate: "process"
  labwired: "true"
  pack: "superpowers-entry"
---

# Using Superpowers + LabWired (prepacked)

This kit ships **two layers**:

| Layer | Skills | Job |
|-------|--------|-----|
| **Domain (LabWired)** | `golden-path`, `bringup`, `prove`, `observe`, `desk-hw` | Firmware + twin + claims |
| **Process (Superpowers)** | TDD, plans, systematic-debugging, verification-before-completion, … | How to work rigorously |

## Instruction priority (non-negotiable)

1. **User explicit instructions**  
2. **LabWired claim rules** (`config/AGENTS.md`) — twin green only from `labwired_verify`  
3. **LabWired domain packs** + **MCP tools** (`labwired_part`, `labwired_datasheet`, …)  
4. **Superpowers process skills**  
5. Default model habits  

If Superpowers says “just implement” and LabWired says “verify first” → **verify first**.

## Knowledge (one path — our MCP, not invent)

Before pin/register/electrical claims or firmware that depends on them:

1. Load **`bringup`**.  
2. MCP: `list` / `describe` → **`labwired_part`** → **`labwired_datasheet`** as needed.  
3. **Never invent.** Label fact vs quote vs missing.  
4. Superpowers does **not** replace knowledge MCP. See `docs/KNOWLEDGE.md`.

## Default firmware path

Prefer **`golden-path`**:

```text
bringup → prove → optional observe → optional desk-hw
```

## When to load Superpowers process skills

| Situation | Skill |
|-----------|--------|
| Ambiguous feature / design | `brainstorming` |
| Multi-step implementation | `writing-plans` / `executing-plans` |
| Bug unknown cause | `systematic-debugging` |
| Any code change | `test-driven-development` (where tests exist) |
| About to claim “done” | `verification-before-completion` |
| Parallel workstreams | `dispatching-parallel-agents` / `subagent-driven-development` |
| Creating new skills | `writing-skills` |

## OpenCode note

Skills are folders under the OpenCode skills dir (refreshed by `labwired` prepare).  
Invoke the skill that matches the task; do not skip LabWired packs for firmware work.

See `skills/README.md`.
