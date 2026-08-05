# LabWired for VS Code / Cursor — Pro workbench v0.2

**Full Embedder-class surface**, redesigned for LabWired (twin evidence, never self-grade).

See **[FEATURE_PARITY.md](./FEATURE_PARITY.md)** for the complete matrix of every Embedder feature and our status.

## Surfaces

| View | Role |
|------|------|
| **Agent** | Multi-tab chat · Plan / Act / Debug / Verify · doctor/smoke · `@file` · `!shell` |
| **History** | Conversation list · restore |
| **Plan** | Plan review · save `.labwired/plan.md` · Approve → Act |
| **Evidence** | Twin/oracle verify JSON · score/assert |
| **Monitor** | Multi-tab UART · capture · probe list · send stub |
| **Plot** | Serial series plot (live plot RPC with `--server`) |
| **Schematic** | Custom editor for `.kicad_sch` / `.kicad_pcb` |

## Commands (Command Palette → “LabWired”)

All Embedder-equivalent commands are registered, including:

- Open Chat / Chat in Editor / New·Close tab  
- Switch Mode / Model / Team / Project  
- Install CLI · Restart bridge · Logs · Build info  
- Monitor / Plot / Evidence / Plan / Schematics  
- Clear · Compress · Undo · Rewind checkpoints  
- Usage & billing · Web console · Login  
- Diff approval demo · GitHub daemon docs · MCP setup  

## Install

```bash
cd extensions/labwired-vscode
npm install && npm run package
cursor --install-extension ./labwired-vscode.vsix --force
```

Reload window. Open **LabWired** in the activity bar.

CLI:

```bash
curl -fsSL https://labwired.com/install | bash
```

## Architecture

```
Webviews + Custom Editors + Commands
            │
     LabWiredBridge ── labwired CLI (doctor, smoke, serial-capture, agent terminal)
            │
  ConversationStore · SessionState · DiffService · Checkpoints
```

`labwired --server` JSON-RPC (true streaming parity) is the next backend step; UI already assumes that shape.

## Settings

`labwired.cliPath`, `autoInstallCli`, `model`, `team`, `project`, `appUrl`, `installUrl`, `defaultBaud`, `showReasoningSummaries`, `telemetry` (default off), `logLevel`, layout flags — see package.json configuration.
