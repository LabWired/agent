# Embedder → LabWired feature parity

**Goal:** Top-copy every Embedder public/editor surface into LabWired Pro.  
**Status:** Extension v0.2.0 surfaces the full matrix. Backend depth varies.

Legend: ✅ working in extension · 🔶 UI + local/CLI stub · ⬜ needs `labwired --server` / cloud

| Embedder feature | LabWired surface | Status |
|------------------|------------------|--------|
| Activity bar product icon | LabWired activity bar | ✅ |
| Chat sidebar | `labwired.chat` Agent | ✅ |
| Chat in editor tab | `labwired.openChatInEditor` | ✅ |
| Multi chat tabs | New / close tab in Agent | ✅ |
| Conversation history | `labwired.history` | ✅ |
| Sessions sidebar | History + project state | ✅ |
| Plan mode | Mode pill Plan + Plan panel | ✅ |
| Act mode | Mode pill Act | ✅ |
| Debug mode | Mode pill Debug | ✅ |
| Verify mode (ours) | Mode pill Verify + Evidence | ✅ |
| Switch model | Command + session state | ✅ |
| Switch team | Command → state + app | 🔶 |
| Switch project | Command → state + app | 🔶 |
| View usage & billing | Opens app billing URL | 🔶 |
| Web console | Opens app.labwired.com | 🔶 |
| Install CLI | Terminal install one-liner | ✅ |
| Restart CLI / bridge | Refresh + optional re-spawn | ✅ |
| CLI logs / process output | Output channel LabWired | ✅ |
| Build / startup info | Show build info command | ✅ |
| Clear conversation | Clear active tab | ✅ |
| Compress conversation | Summarize stub + keep last N | 🔶 |
| Undo last message | Checkpoint rewind | ✅ |
| Rewind / fork | Checkpoint menu | 🔶 |
| Stop generation | Dispose agent terminal | ✅ |
| Serial monitor | Monitor panel | ✅ |
| Serial in editor | Open Monitor in editor | ✅ |
| Toggle serial | Toggle Monitor | ✅ |
| Multi serial tabs | Port tabs in Monitor | ✅ |
| Baud + port select | Monitor controls | ✅ |
| Auto-detect ports | Refresh ports | ✅ |
| Serial capture / marker | `labwired serial-capture` | ✅ |
| RTT / J-Link | Probe list + notes | 🔶 |
| Plot | Plot webview | 🔶 |
| Schematics custom editor | KiCad file custom editor | 🔶 |
| Open schematic… | File picker | ✅ |
| Diff permission UI | Diff content provider + prompt | 🔶 |
| Checkpoints | Local workspaceState | ✅ |
| Walkthrough / onboarding | Getting Started + replay | ✅ |
| Layout → secondary sidebar | Arrange layout command | 🔶 |
| Close foreign agent chat | Setting on activate | 🔶 |
| Telemetry toggle | Setting (no Sentry by default) | ✅ |
| CLI path / auto-install | Settings | ✅ |
| Show reasoning summaries | Setting + chat flag | 🔶 |
| File @ mentions | Chat composer `@file` expand | 🔶 |
| Bash prefix `!` | Chat routes to terminal | ✅ |
| Serial send `~` | Monitor send / chat prefix | 🔶 |
| Headless `--server` JSON-RPC | Bridge detects / documents | ⬜ |
| GitHub daemon | Command opens docs / stub | 🔶 |
| MCP servers UI | Command → MCP docs | 🔶 |
| Twin evidence (LabWired) | Evidence view | ✅ |
| Doctor / smoke | Agent tools | ✅ |
| Subagents / instrument suite | Via CLI agent skills | ⬜ |

## Product rule

If Embedder has a **command, view, mode, or setting**, LabWired exposes an equivalent under category **LabWired**. Missing backend = honest stub that still completes the UX path (open URL, terminal, or “needs --server”).
