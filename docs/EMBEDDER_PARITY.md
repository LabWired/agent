# LabWired Agent vs Embedder — user job parity (release 0.3.10)

Stance: match Embedder **user jobs** via skills + MCP + twin/desk claims. Do **not** clone instrument farm / Open Plot.

| User job | Embedder surface | LabWired ship surface | Release gate |
|----------|------------------|----------------------|--------------|
| Install → chat | VS Code + CLI | `curl labwired.com/install` → `labwired agent` | ship-gate doctor |
| Account / hosted brain | Account required | Device login + live doctor probe | hosted-auth-probe |
| Part / datasheet knowledge | RM citations | `labwired_list` / `part` / `datasheet` | knowledge-mcp-smoke |
| Schematic → board | Multi-EDA ingest | `import-circuit` + `labwired_import` (diagram_json P0) | import-diagram-smoke + MCP import |
| Closed loop write→test→fix | Flash silicon + instruments | Twin: `prove` → `labwired_verify` → `model_verified` | live-gate1 |
| Real board check | HIL instruments | `desk-hw`: probe flash + serial → `hardware_observed` | desk-hw-smoke |
| Honest claims | Silicon is truth | Twin ≠ desk; never upgrade HW→twin green | assert-status + AGENTS |
| Plots / LA | Open Plot product | Elements + `observe` / compose | ship-gate compose |
| Deterministic CI without bench | Not their wedge | Twin / CI | ★ LabWired wedge |
| 30+ instruments / panel farm | Product | Non-goal | ⛔ |

Non-goals this release: RTT product, VS Code Marketplace G2, SOC2/on-prem agent, Embedder panel clone.
