# LabWired for VS Code / Cursor — Agent workbench

**Same start-here as the CLI.** The workbench is chrome; the brain is `labwired` (OpenCode + packs + hosted MCP).

See **[FEATURE_PARITY.md](./FEATURE_PARITY.md)** for the Embedder surface matrix.

## Start-here (VS Code = CLI)

```text
Install CLI → Log in → Doctor → Start Agent → “Blink the LED and prove it on the twin.”
```

| Step | Command Palette | CLI equivalent |
|------|-----------------|----------------|
| Install | **LabWired: Install LabWired CLI** | `curl -fsSL https://labwired.com/install \| bash` |
| Login | **LabWired: Log in (Pro)** → *labwired login* | `labwired login` |
| Doctor | **LabWired: Run Doctor** | `labwired doctor` |
| Agent | **LabWired: Start Agent (Terminal)** | `labwired` |
| Prove | Chat in the terminal agent | golden-path → prove → model_verified |

Session file is shared: `~/.labwired/session/cloud.json`.  
Knowledge: MCP `labwired_part` / `labwired_datasheet`.  
Plots: **elements** via `labwired compose …` (not ready-made plots).

Packs: **golden-path · bringup · prove · observe · desk-hw** (+ Superpowers process).

## Surfaces

| View | Role |
|------|------|
| **Overview** | Playground-style glass: session, board topology, OLED/display, serial strip, element series, evidence |
| **Agent** | Multi-tab chat · Plan / Act / Debug / Verify · doctor/smoke · `@file` · `!shell` |
| **History** | Conversation list · restore |
| **Plan** | Plan review · save `.labwired/plan.md` · Approve → Act |
| **Evidence** | Twin/oracle verify JSON · score/assert |
| **Monitor** | Multi-tab UART · capture · probe list |
| **Plot** | Element-backed series (live plot RPC with `--server`) |
| **Schematic** | Custom editor for `.kicad_sch` / `.kicad_pcb` |

**LabWired: Open Overview** opens the visual dashboard in an editor tab (same story as app.labwired.com glass — topology + display + serial + elements).

### Twin display (real buffers)

Overview can paint **real** twin framebuffers (not only the demo OLED):

1. Agent / MCP: `labwired_run` → note `snapshot_id`  
2. **LabWired: Pull Twin Display → Overview** (or Overview → *Pull twin display*)  
   → `labwired_inspect` with `output=full|peripherals`  
   → `peripherals[].artifacts[]` with `bytes` (SSD1306 page, RGB565 TFT, …)  
3. Or drop / load a run JSON under `.labwired/` (also auto-saves `.labwired/display-latest.json`)

Evidence load paths that include peripherals also feed the OLED/TFT canvas.

Prefer **Start Agent (Terminal)** for the full twin + MCP path. In-panel chat is a fallback.

## Install (dev)

```bash
cd extensions/labwired-vscode
npm install && npm run package
cursor --install-extension ./labwired-vscode.vsix --force
# or: code --install-extension ./labwired-vscode.vsix --force
```

Reload window. Open **LabWired** in the activity bar → **Getting Started** walkthrough.

CLI (if not already installed):

```bash
curl -fsSL https://labwired.com/install | bash
labwired login
labwired doctor
```

## Architecture

```
Webviews + Commands
        │
 LabWiredBridge ── labwired CLI (doctor, smoke, login, bare start → OpenCode)
        │              └── ~/.labwired/session/cloud.json (hosted MCP + model)
 ConversationStore · SessionState · DiffService
```

`labwired --server` JSON-RPC is optional for plot/instrument streaming; agent start does **not** require it.

## Settings

`labwired.cliPath`, `autoInstallCli`, `model`, `modelUrl`, `modelKey`, `team`, `project`, `appUrl`, `installUrl`, `defaultBaud`, `agentArgs`, `telemetry` (off by default), `logLevel` — see package.json configuration.

Hosted credentials prefer **cloud.json** from `labwired login`; settings can override project/model when set.
