# Golden path — stranger → twin green

**Goal:** Cold machine: sign in → agent → blinky (or UART hello) → **`model_verified`**.  
Optional: compose LED vs UART from **elements**.

Skill packs only (no legacy names):

```text
golden-path → bringup → prove → optional observe → optional desk-hw
```

Knowledge: one MCP path — see `docs/KNOWLEDGE.md`.

---

## 5-minute path (CLI)

```bash
curl -fsSL https://labwired.com/install | bash
labwired login
labwired doctor
labwired
```

In the agent:

> Blink the LED and **prove** it on the twin. Then plot LED vs UART from real run output.

---

## Same path in VS Code / Cursor

Workbench extension (`extensions/labwired-vscode`) is chrome only — same `labwired` entry:

| Step | Command Palette |
|------|-----------------|
| Install | **LabWired: Install LabWired CLI** |
| Login | **LabWired: Log in (Pro)** → *labwired login* (writes `~/.labwired/session/cloud.json`) |
| Doctor | **LabWired: Run Doctor** |
| Agent | **LabWired: Start Agent (Terminal)** → bare `labwired` (prepare + OpenCode + packs + MCP) |
| Prove | Same chat prompt as CLI |

Hosted env is loaded from cloud.json into the agent terminal. Do **not** use a second parallel agent stack.

### Pass criteria

| Check | Pass |
|-------|------|
| Login | `whoami` shows project |
| Tools | Agent can call `labwired_*` after login |
| Green | `labwired_verify` → `model_verified` |
| Serial | UART / markers visible |
| Plot | Composed **elements** only (`observe`) |
| Claims | No HW claim unless **`desk-hw`** ran |

---

## Automated smoke

```bash
./scripts/smoke-wave-a.sh
./scripts/smoke-remaining.sh
```

---

## Paths

| Available | Path |
|-----------|------|
| Hosted / local twin | **`prove`** → `model_verified` |
| No sim | Debugger / probe — honest observe only |
| Physical board | **`desk-hw`** → `hardware_observed` |

Sim is **not** required for all work.
