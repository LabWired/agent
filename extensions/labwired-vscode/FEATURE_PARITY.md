# Embedder → LabWired feature parity (workbench chrome)

**Goal:** Match Embedder’s *extension surfaces* where they matter, without abandoning LabWired’s wedge (twin oracle + shared MCP tools + **composable observability elements**).

**Updated:** 2026-08-05

**Product-level scorecard (path / knowledge / plots / kill):**  
[`labwired` monorepo `docs/strategy/2026-08-05-product-parity-scorecard.md`](../../../labwired/docs/strategy/2026-08-05-product-parity-scorecard.md)  
(adjust relative path if this clone sits outside the monorepo tree.)

**Plots rule:** we do **not** match Embedder **Open Plot** as a ready-made product. We ship **elements** the agent assembles into any plot the user wants.  
→ [`2026-08-05-composable-observability-elements.md`](../../../labwired/docs/strategy/2026-08-05-composable-observability-elements.md)

## Two LabWired products (do not confuse them)

| Product | Repo / path | Job | vs Embedder |
|---------|-------------|-----|-------------|
| **Debugger (MIT)** | `w1ne/labwired-vscode` (monorepo `vscode/`) | F5 twin debug + **Configure Agent Tools** + **Start OpenCode Agent** | Different product — we win on sim debug |
| **Agent workbench** | `LabWired/agent` → `extensions/labwired-vscode` | Embedder-class chrome: chat, plan/act, monitor, evidence | **This** matrix |

Embedder ships **one** fat extension (UI + 115 MB CLI). We ship **chrome here** + **`labwired` OpenCode** as the brain (same tools as playground MCP).

Legend: ✅ working · 🔶 stub / partial · ⬜ missing · ★ LabWired-only advantage · ⛔ refuse clone (see product scorecard)

## Start-here parity (CLI ↔ VS Code) — v0.6.1

| CLI | VS Code |
|-----|---------|
| `curl install \| bash` | LabWired: Install CLI |
| `labwired login` | LabWired: Log in → terminal `labwired login` |
| `~/.labwired/session/cloud.json` | Loaded into agent terminal env (`envForAgent`) |
| `labwired doctor` | LabWired: Run Doctor |
| `labwired` (prepare + OpenCode + packs) | LabWired: Start Agent (Terminal) |
| golden-path / MCP knowledge / compose | Same — not a second agent stack |

## Matrix (agent workbench v0.6.1)

| Embedder feature | LabWired surface | Status |
|------------------|------------------|--------|
| Activity bar product icon | LabWired activity bar | ✅ |
| Chat sidebar | `labwired.chat` / openChat | ✅ |
| Chat in editor tab | `labwired.openChatInEditor` | ✅ |
| Multi chat tabs | newTab / closeTab | ✅ |
| Conversation history | history view | ✅ |
| Sessions sidebar | history + session state | ✅ |
| Plan mode | switchToPlan + plan panel | ✅ |
| Act mode | switchToAct | ✅ |
| Debug mode | switchToDebug | ✅ |
| Verify mode (ours) | switchToVerify + Evidence | ✅ ★ |
| Switch model | switchModel + settings | ✅ |
| Switch team / project | commands + settings | 🔶 |
| Usage & billing | viewUsage / billingStatus | 🔶 |
| Web console | openConsole → app.labwired.com | 🔶 |
| Install CLI | installCli → curl install | ✅ |
| Restart CLI / bridge | restartCli / restartBridge | ✅ |
| CLI logs / process output | openLogs / showCliProcessOutput | ✅ |
| Build / startup info | showBuildInfo / showStartupProfile | ✅ |
| Clear / compress / undo | clear / compress / undo / rewind | ✅ / 🔶 |
| Stop generation | stopGeneration | ✅ |
| Serial monitor | openSerial / toggle / editor | ✅ |
| Baud + ports | monitor + defaultBaud | ✅ |
| Serial capture / marker | `labwired serial-capture` via tools | ✅ |
| RTT / J-Link | probe tools / debug_* | 🔶 |
| **Open Plot (ready-made)** | ⛔ not a product clone | ⛔ |
| **“Show me a plot of X”** | **Elements** + agent compose; glass = **reuse** existing Plot panel / plot RPC / (playground) LA export strips — not a new plot builder | 🔶 ★ job parity via elements (E1–E3); E4 adopt path |
| Schematics (KiCad) | schematic custom editor | 🔶 |
| Walkthrough | Getting Started + replay | ✅ |
| Layout secondary sidebar | moveChatToSecondarySidebar | 🔶 |
| Telemetry toggle | setting (off by default) | ✅ |
| CLI path / auto-install | settings | ✅ |
| MCP / BYO agent | openMcpDocs + **shared hosted MCP** | ✅ ★ |
| Twin evidence | Evidence + loadVerify JSON | ✅ ★ |
| Doctor / smoke | doctor / smoke commands | ✅ ★ |
| **Start agent = OpenCode** | startAgent → `labwired` (skills + labwired_*) | ✅ ★ |
| **Hosted session from CLI login** | cloud.json → envForAgent (+ auto-refresh) | ✅ ★ |
| **Walkthrough = start-here** | login → doctor → agent → prove | ✅ ★ |
| **Visual overview (Playground glass)** | Overview: topology · OLED · serial · elements · evidence | ✅ ★ |
| Subagents / instruments | skills + future | ⬜ |
| Headless `--server` streaming | bridge tryStartServer | 🔶 |

## Sprint priorities (feature parity that ships value)

1. **Keep workbench packageable** — restore `package.json`, compile green, ship VSIX.  
2. **Agent start = OpenCode path** — same as marketplace “Start OpenCode Agent” (done in bridge env + CLI).  
3. **Hosted tools after login** — `labwired login` / extension Log in → `LABWIRED_ACCESS_TOKEN` + project → remote MCP.  
4. **Honest stubs only** where backend missing (team/billing already open URLs).  
5. **Do not** re-implement Embedder instrument suite or **Open Plot** before golden path: login → chat → twin verify green.  
6. **Observability:** element catalog + compose skill + one E2E composed view — not a library of ready plots.

## Product rule

If Embedder has a **command, view, mode, or setting** that maps to a **user job we keep**, the **agent workbench** should expose an equivalent under **LabWired**. Missing backend = honest stub (URL, terminal, or “needs labwired login / --server”).

**Exception — plots:** job parity (“show series / overlay X”) via **composable elements**, not command/widget parity with `openPlot`.

The **debugger** extension does **not** need full chat parity — it needs twin debug + MCP/OpenCode handoff (already on `feat/agent-tools-mcp`).
