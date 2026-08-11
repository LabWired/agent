# Context-first workbench — agent mirror

| Field | Value |
|-------|-------|
| **Canonical** | `labwired/docs/superpowers/specs/2026-08-11-context-first-workbench-design.md` |
| **Binding plan v3** | `labwired/docs/superpowers/plans/2026-08-11-context-first-p0.md` |
| **Ship claim** | Only **P0-ship** (`P0_SHIP_OK`), not P0a alone |

---

## Agent PRs

| PR | This repo | Pass |
|----|-----------|------|
| **P0b** | Sync `contextFlags.generated.ts`; `workspaceContext` pure only; `assert-context-parity.mjs`; **no** version/chrome edits | tsc + parity exit 0 |
| **P0d** | `config/AGENTS.md` session orientation (file already in package) | merged |

P0a / P0c are monorepo. Do not start P1 kinds or desk-hw UI.

---

## Locked decisions

- Packaging: **sha sync**, not path-dep on `@labwired/board-config`  
- Chrome: **frozen** until P0-ship  
- Prove: **mandatory** in monorepo P0c (not extension’s job to fake)  
- Netlist: monorepo kill switch — not agent scope  

---

## Claims

| Claim | Mints |
|-------|--------|
| design context | pack/context — not prove |
| `model_verified` | `labwired_verify` only |
| `hardware_observed` | desk-hw / probe only |
