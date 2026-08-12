# LabWired Agent vs Embedder — full job parity + our wedge

**Status:** binding — we **will** own every user job below (product depth).  
**Not a clone:** we refuse instrument-farm / Open Plot product parity (⛔).  
**Our wedge ★:** deterministic twin oracle + dual claims + CI without flaky HIL.

See also: [PRODUCT_DEPTH.md](./PRODUCT_DEPTH.md).

| User job | Embedder | LabWired must ship | Status |
|----------|----------|--------------------|--------|
| Install → agent | VSIX + CLI | `curl labwired.com/install` → `labwired agent` | ✅ |
| Account / hosted brain | Account | Device login + live doctor probe | ✅ |
| Part / datasheet knowledge | RM citations | `labwired_list` / `part` / `datasheet` + coverage | 🔶 |
| Schematic → board | Multi-EDA | `import-circuit` + `labwired_import` multi-source | 🔶 |
| Closed loop write→test→fix | Silicon + instruments | Twin prove → twin green | ✅ gate |
| Real board check | HIL instruments | desk-hw flash+serial (+ RTT) | 🔶 |
| Honest claims | Silicon truth | Twin ≠ desk | ✅ |
| Plots / signals | Open Plot | Elements + observe | 🔶 |
| Deterministic CI | weak | Twin / CI ★ | ✅ |
| 30+ instruments | product | ⛔ kill | ⛔ |
| Enterprise trust | SOC2/on-prem | D7 packaging | ⬜ |

## Gates

- Release: `./scripts/ship-gate.sh`  
- Depth knowledge: knowledge MCP smoke + coverage ratchet  
- Depth import: multi-source import tests + MCP import  
