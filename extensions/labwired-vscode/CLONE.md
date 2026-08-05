# Embedder clone foundation (v0.3)

We **start from Embedder’s extension UX**, not from labwired.com marketing.

## What we cloned (structure)

| Embedder | LabWired clone |
|----------|----------------|
| `:root` VS Code CSS tokens | Same var names (`--bg`, `--border`, `--primary`, …) |
| `.message-list` / `.turn` / `.message` | Same |
| `.empty-state` + large logo | Same |
| `.composer` + `.composer-shell` | Same |
| `.composer-mode-pill` (cycle Act/Plan/Debug) | + Verify |
| Mode border colors on shell | plan=primary, debug=warning, verify=success |
| `!` bash / `~` serial input border | Same |
| Panel **Monitor** (serial) | Same |
| History list | Same |
| Plan review | Same |
| Custom schematic editor | Lightweight |
| Evidence | LabWired-only (twin) |

## What we did **not** copy

- Proprietary JS/React bundles  
- Their backend / `--server` protocol payload shapes (we will design ours)  
- Neo-brutal marketing chrome  

## Source study

`docs/competitive/embedder-vscode/` — unpacked `embedder.embedder-vscode@0.3.163`

## Real tools (v0.3.1)

All of these run the **real `labwired` CLI** and print results in chat as tool rows:

| Slash | Tool |
|-------|------|
| `/doctor` `/doctor strict` | install check |
| `/smoke` | claim gate + sim |
| `/version` `/update` `/install-deps` | kit lifecycle |
| `/probe list\|doctor\|chips\|flash\|reset\|install-backend` | hardware |
| `/serial <port> [baud] [marker] [timeout]` | UART capture |
| `/score <file>` `/assert [status] <file>` | verify oracle |
| `/package` `/tools` `/help` | meta |

Also: **LabWired: Run Tool…** command palette, empty-state buttons, ⚙ in composer.

Freeform text (not a tool route) still starts the agent terminal.

## v0.4.0 — three former gaps

| Gap | Status |
|-----|--------|
| Freeform LLM in-panel | `AgentSession`: `opencode run --format json` then OpenAI-compatible `LABWIRED_MODEL_URL` stream |
| Live serial | Monitor **Connect** via `LiveSerial` (Unix `/dev/cu.*` continuous read + write) |
| Catalog / datasheet grounding | Local `data/catalog-facts.json` (136 parts) + `.labwired/datasheets/` + `/catalog` tool + Catalog view |
| `labwired server` | Wraps `opencode serve` on :4096 |

## Agent server (v0.5)

`server/rpc-server.mjs` — JSON-RPC stdio (`labwired server --rpc-stdio`).

Methods: `initialize`, `mode/set`, `tool/list`, `tool/run`, `chat/send`, `chat/stop`, `serial/listPorts`.

**LabWired Editor** (`labwired-cursor`) spawns this as a thin client. Same tools as this extension; no second implementation.

## Next

1. Richer OpenCode event parsing / session resume  
2. PDF text extraction for datasheet RAG  
3. Diff permission UI like Embedder tool confirm  
4. Extension `RpcClient` → same `rpc-server.mjs` (wire live) 
