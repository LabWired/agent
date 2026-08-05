# Golden path — stranger → twin green

**Goal:** Cold machine, no tribal knowledge: sign in → agent → blinky (or UART hello) → **`model_verified`**. Optional: compose LED vs UART from **elements**.

**Product plan:** monorepo `docs/strategy/2026-08-05-embedder-offerings-sota-plan.md` **Wave A**.

---

## 5-minute path (CLI)

```bash
# Install (or update)
curl -fsSL https://labwired.com/install | bash

# Shared tools + model gateway
labwired login
labwired whoami
labwired doctor

# Agent (OpenCode + skills + labwired_* MCP)
labwired
```

In the agent, say:

> Blink the LED on this board and **prove** it on the twin. Then plot LED vs UART from real run output.

Expected skill chain (agent-internal):

`golden-path` → `part-knowledge` / `board-bringup` → `scaffold-firmware` →
`labwired_compile` / `labwired_run` → `verify-firmware` → (if red) `firmware-repair-loop` →
`report-evidence` → `compose-observability` (E3 recipe)

### Pass criteria

| Check | Pass |
|-------|------|
| Login | `whoami` shows project; token present |
| Tools | Agent can call `labwired_list` / verify (hosted after login) |
| Green | `labwired_verify` → `status: model_verified` |
| Serial | UART or run serial visible for the hello/blink markers |
| Plot | Composed elements only — no invented series; not a ready-made Open Plot |
| Claims | No hardware claim unless `hw-promote` actually ran |

---

## VS Code path

| SKU | Path |
|-----|------|
| **Debugger (MIT)** | Install LabWired vscode → Sign In / Configure Agent Tools → Start OpenCode Agent (or external MCP) → same tools |
| **Agent workbench** | Log in → Start agent → same `labwired_*` + skills |

Do **not** require a physical board for twin green.

---

## Local-only (no login)

```bash
labwired doctor
labwired
```

**Sim is not required.** Paths:

| Available | Path |
|-----------|------|
| Hosted after `labwired login` | Twin `labwired_run` / `labwired_verify` → `model_verified` |
| Local sim | Same twin tools via local MCP |
| **No sim** | **LabWired debugger** (F5 / probe-rs) + serial — fully supported; do **not** claim `model_verified` unless twin verify ran |

Hosted knowledge (`labwired_part` / datasheet breadth) may be thinner offline; still **never invent** pins.

---

## Embedder offerings covered by this path

| # | Offering | How this path beats it |
|---|----------|------------------------|
| 1–2 | Datasheet / register grounding | `part-knowledge` + tools |
| 3 | Driver / bring-up gen | Scaffold + **verify** |
| 5–6 | Plan / Act | Skills + verify gate |
| 8 | Serial | Run serial + element |
| 9 | Open Plot | `compose-observability` elements |
| 10 | Closed-loop repair | `firmware-repair-loop` max 3 |
| 14–18 | Agent shell / login / thin CLI | `labwired login` + OpenCode |
| 20 | “Must run on HW” | Twin oracle is model-green |

---

## Automated smoke (no browser)

```bash
./scripts/smoke-wave-a.sh
```

**PASS proves:** doctor · offline assert · live twin red→green · E3 UART compose · skills · element catalog · session project.

## Human / marketing checklist (optional)

- [x] Session + project (`whoami` after heal)  
- [x] Live twin `model_verified` (`live-gate1` / smoke-wave-a)  
- [x] Plot/compose from real UART (`compose-elements.py`)  
- [ ] Fresh device-code login on a **new** machine  
- [ ] NL OpenCode chat “blink and prove” (hosted MCP edge UA)  
- [ ] 3-minute marketing recording  
- [x] Sim not forced; debugger first-class (AGENTS + golden-path)  
- [x] HW never upgrades twin green (skills)

Wave A **engineering exit** = automated smoke PASS (2026-08-05).
