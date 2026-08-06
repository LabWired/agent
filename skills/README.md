# LabWired agent skills (prepacked)

Two layers, one OpenCode install:

1. **LabWired domain packs** (firmware / twin / claims)  
2. **Superpowers process skills** (TDD, plans, debugging method)

MCP tools (`labwired_*`) — including **`labwired_part`** and **`labwired_datasheet`** — are the knowledge plane. Skills teach *when* to call them.

---

## Domain packs (primary — use these for firmware)

| Pack | When | Aliases |
|------|------|---------|
| **`golden-path`** | Default stranger / “prove it” loop | — |
| **`bringup`** | Pins, parts, diagram, scaffold | part-knowledge, board-bringup, scaffold-firmware |
| **`prove`** | Twin verify, repair ≤3, evidence | verify-*, diagnose-*, report-*, inspect-* |
| **`observe`** | Plots from **elements** | compose-observability |
| **`desk-hw`** | Flash + `hardware_observed` | flash-firmware, hw-promote |

```text
golden-path → bringup → prove → optional observe → optional desk-hw
```

### Claim rules

| Claim | Source |
|-------|--------|
| `model_verified` | **Only** `labwired_verify` |
| `hardware_observed` | Flash **and** serial/RTT marker |
| Datasheet / pin facts | MCP tools — never invent |

Sim is **not** forced; debugger is first-class when twin is missing.

---

## Superpowers (process — prepacked)

| Skill | When |
|-------|------|
| **`using-superpowers`** | How process + LabWired layers combine (read first) |
| `brainstorming` | Design / ambiguous requirements |
| `writing-plans` / `executing-plans` | Multi-step plans |
| `test-driven-development` | Implementation discipline |
| `systematic-debugging` | Unknown bugs (process) |
| `verification-before-completion` | Before claiming done |
| `dispatching-parallel-agents` | Parallel work |
| `subagent-driven-development` | Subagent execution |
| `requesting-code-review` / `receiving-code-review` | Review loop |
| `finishing-a-development-branch` | Ship / merge decisions |
| `using-git-worktrees` | Isolated worktrees |
| `writing-skills` | Authoring skills |

**Priority:** LabWired claims + MCP facts **override** generic Superpowers advice when they conflict.

---

## Knowledge plane (MCP)

| Tool | Role |
|------|------|
| `labwired_list` / `labwired_describe` | Catalog + pins |
| `labwired_part` | Structured part facts |
| `labwired_datasheet` | Datasheet text search/page |
| `labwired_compile` / `run` / `verify` | Build + twin prove |
| `labwired_inspect` | State slices |

Skills do not embed datasheet PDFs; they force **tool use**.

---

## Aliases

Old LabWired micro-skill names remain as **thin stubs** pointing at packs so older prompts still work.
