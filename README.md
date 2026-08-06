# LabWired Agent

<p align="left">
  <img src="branding/logo.svg" alt="LabWired" width="32" height="32" />
</p>

**Write firmware. Prove it on a digital twin.** Shared MCP tools (including part + datasheet knowledge).

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![version](https://img.shields.io/badge/version-0.3.7-blue)](CHANGELOG.md)

---

## Start here (only door you need)

```bash
curl -fsSL https://labwired.com/install | bash
labwired login
labwired doctor
labwired
```

In the agent:

> **Blink the LED and prove it on the twin.**

That loads **`golden-path`**: `bringup` → `prove` → optional `observe` / `desk-hw`.

| Step | What |
|------|------|
| 1 | Install kit + OpenCode |
| 2 | Login → hosted MCP + model (`labwired_*` tools) |
| 3 | Doctor → packs present |
| 4 | Chat prove → `labwired_verify` → `model_verified` |

**Playground Architect** ([app.labwired.com](https://app.labwired.com/)) is **optional / secondary** — same MCP tools, different UI.

More detail: [docs/GOLDEN_PATH.md](docs/GOLDEN_PATH.md) · [docs/KNOWLEDGE.md](docs/KNOWLEDGE.md)

---

## Ship / QA gates

```bash
./scripts/ship-gate.sh          # doctor + assert + live twin + compose + knowledge heroes
./scripts/smoke-wave-a.sh       # core twin + E3 compose
./scripts/knowledge-top-parts.py
```

---

## Skills (clear interfaces)

**Domain (firmware first):**

| Pack | Job |
|------|-----|
| `golden-path` | **Default** end-to-end loop |
| `bringup` | Knowledge MCP + diagram + scaffold |
| `prove` | Twin verify / repair / evidence |
| `observe` | Plots from elements (`labwired compose`) |
| `desk-hw` | Flash + `hardware_observed` |

**Process:** Superpowers (TDD, plans, …) — **secondary** on firmware; never mints green.

**Knowledge:** one path — `labwired_part` then `labwired_datasheet` (MCP). Never invent.

---

## Commands

| | |
|--|--|
| `labwired` | Start OpenCode (**golden-path** first) |
| `labwired login` / `whoami` | Hosted session |
| `labwired doctor` | Install health |
| `labwired compose uart\|capture …` | Assemble plot **elements** |
| `labwired probe …` | Physical / virtual flash |
| `labwired assert-status …` | Claim gate |

---

## How claims work

1. Describe any board/task  
2. Agent uses **bringup** knowledge tools (not invent)  
3. Twin **`labwired_verify`** → only path to **`model_verified`**  
4. Debugger/probe if no sim — honest observe, not fake green  
5. Optional desk HW → **`hardware_observed`** only  

---

## Other surfaces (same tools, not the start-here)

| Surface | Role |
|---------|------|
| VS Code debugger | F5 reverse-step twin |
| Claude / Cursor MCP | `claude mcp add labwired --transport http https://api.labwired.com/mcp` |
| Playground | Secondary UI |

---

## License

MIT — see [LICENSE](LICENSE).
