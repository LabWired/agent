# Product depth — LabWired Agent must have all of this

**Status:** binding product requirement (2026-08-12)  
**Stance:** Release path is shippable. **Depth** is not optional — we will own every row below. We still refuse Embedder’s **instrument farm / Open Plot product clone** (⛔); we win with twin oracle + knowledge + import + desk, not 30 scopes.

## Depth scorecard

| # | Depth area | Must have | Status now | Done when |
|---|------------|-----------|------------|-----------|
| D1 | Knowledge | Pinout/register facts + datasheet quotes; never invent | 🔶 tools + thin coverage | Top-N kit heroes all `part` or `datasheet` hit; coverage ratchet green in ship-gate |
| D2 | Import | Multi-source → design context always; twin when catalog allows | 🔶 diagram_json twin; bom/text/kicad design | Stranger can import BOM/KiCad/PDF text and get mapped/dropped honesty + twin when possible |
| D3 | Twin prove | Write → compile → run → `model_verified` | ✅ gated | Remains green; expand board matrix |
| D4 | Desk silicon | Flash + serial marker → desk green; RTT path | 🔶 UART; RTT partial | Real probe E2E gate + RTT attach/read when probe supports |
| D5 | Observability | Agent-composed elements, not Open Plot | 🔶→✅ job path | `compose job --ask` + observe skill; not invent |
| D6 | Workbench | Marketplace-quality chrome for agent jobs | 🔶 | G2 checklist green; no fake panels |
| D7 | Enterprise trust | SOC2/ISO path, DPA, air-gap agent package | ⬜ | Security pack + self-host docs shippable |
| D8 | Wedge ★ | Twin/CI without flaky HIL; dual claims | ✅ | Never dilute for instrument parity |

## Explicit kill list (still)

- 30+ instrument product surface  
- Ready-made Open Plot product page  
- Claiming desk green as twin green  

## Phases

1. **D1+D2 now** — coverage ratchet + multi-source import (this train)  
2. **D4** — physical E2E + RTT attach  
3. **D5+D6** — plot job E2E + Marketplace  
4. **D7** — compliance packaging  

Update this table when status changes. Agent README points here for depth; release notes track gates.
