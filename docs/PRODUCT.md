# LabWired Agent product (simple)

**Status:** binding  
**Date:** 2026-08-11

---

## One sentence

**Same twin tools as cloud agent · local suite (+ real boards) · Cursor-shaped Agent · `labwired agent` engine · VS Code DAP · prove only via oracle.**

---

## What this product is

| | |
|--|--|
| **Tools** | **Ideally identical `labwired_*` MCP toolset** as cloud Architect / hosted agent — one dialect, one schemas |
| **Form** | **Local dev suite** — CLI + VS Code/Cursor on your machine |
| **Targets** | **Digital twin** and **physical boards** (USB serial, probe, flash) |
| **Chrome** | Cursor-shaped **Agent** chat (home) |
| **Engine** | `labwired agent` / `labwired-agent` (skills + MCP + model) |
| **Board glass** | **Integrated**: show twin board + running state (topology / display / serial) when you run or debug — not a separate product |
| **Debug** | **VS Code DAP** in the **same suite** (F5 / `type: labwired`) — agent and debugger are one local suite |

```text
  Cloud agent / Architect     Local dev suite (this product)
  ───────────────────────     ─────────────────────────────
  browser / hosted loop       Agent chrome
                              + board glass (see twin running)
                              + VS Code DAP (step firmware)
  labwired_* MCP              labwired_* MCP  ← same twin tools
  twin (hosted)               twin (local and/or hosted)
  —                           + physical boards on the desk
```

**Integrated suite (important):** Agent is the home chrome; **board display** and **DAP** are first-class **in the same package**.  
**Story:** whatever you can debug on a **real board**, you can debug on a **virtual twin** — same F5 / `type: labwired` / `labwired-dap`.  
Not “agent here, separate debugger extension there.”

**Tool parity rule:** local and cloud agents share the **same `labwired_*` names and shapes** for twin/catalog/import/prove (`list`, `describe`, `context`, `import`, `validate`, `run`, `verify`, `inspect`, `part`, `datasheet`, …).  
Transport may differ (hosted HTTPS MCP vs local stdio); **semantics and claims do not.**  

**Exception — physical boards:** desk-only (serial, probe, flash, `hardware_observed`). Cloud Architect does not get real-board access; do not pretend it does. Local suite adds those tools; twin tools stay shared.

Architect stays the **browser** product. This package is the **desk** product.  
Same tools + claims; different shell. (See platform `two-agents.md`.)

---

## Product entry (simple)

**LabWired Agent is the product.** Users never need to name the underlying chat runtime.

| Layer | Owner | What |
|-------|--------|------|
| **LabWired Agent kit** | Us | `labwired agent` launcher, prepare, skills, `AGENTS.md`, branding, agent configs, MCP wiring |
| **`labwired_*` tools** | Us (shared with Architect) | Twin, catalog, prove, import — product truth |
| **Model gateway** | Us (hosted) / BYO local | `labwired-default` etc. via api.labwired.com or local URL |
| **VS Code extension** | Us | Cursor-shaped chrome; starts **`labwired agent`**, not a raw runtime binary |
| **Pinned chat runtime** | Upstream (internal) | Terminal UI loop — replaceable plumbing |

```text
  User → Cursor-like chrome / terminal
            │
            ▼
  labwired agent   ← product entry (prepare + config + skills + login)
            │
     ┌──────┴──────┐
     ▼             ▼
  labwired_*     model
  (MCP twin)     (gateway / local)
```

**Rules**

1. Users and marketing say **LabWired Agent** only.  
2. Extension / CLI always enter via **`labwired agent`** (prepare path).  
3. Pin the chat runtime deliberately (`OPENCODE_PIN`); upgrade as a kit release decision.  
4. Skills + MCP + claims are **our** product; the chat runtime is replaceable plumbing.  
5. Architect does **not** run this desk agent in the browser — different shell, same tools.  
6. **Stay on official OpenCode releases** — pin + wrap only; never fork. See [UPSTREAM_OPENCODE.md](./UPSTREAM_OPENCODE.md).

---

## Three layers

| Layer | What | Not |
|-------|------|-----|
| **1. Chrome** | Agent chat: model · @ · mic · Enter | Embedder panel farm |
| **2. Engine** | `labwired agent` → skills + MCP + model | Second in-panel brain |
| **3. Work** | Skills + tools | Invented pins / fake green |

---

## Hard rules

1. **Same twin tools as cloud agent** — shared `labwired_*` for catalog, twin, import, prove. No private dialect.  
2. **Physical boards = local only** — serial, probe, flash, `hardware_observed` on the desk; cloud Architect is not expected to have real boards.  
3. **Local suite** — twin first; real boards when plugged in. Hosted MCP/model optional after login.  
4. **UI stays simple** — Agent only as home.  
5. **Jobs = skills** — import, diagram, prove, observe, desk-hw: skills, not new sidebars.  
6. **Debug = DAP in this package** — same F5 path for **virtual twin** and **physical board** (`labwired-dap` + `target: twin|hardware|auto`).  
7. **Board glass on run** — run/debug opens/shows twin board + live signals/display when available.  
8. **Physical ≠ twin** — never rename twin results as hardware.  
9. **Claims**  
   - `model_verified` ← only `labwired_verify` (**prove**) on the **twin**  
   - `hardware_observed` ← only **physical board** path (**desk-hw**)  
   - run / plot = observation only  

---

## Domain skills (few)

| Skill | Job |
|-------|-----|
| **golden-path** | Entry loop |
| **bringup** | Knowledge + diagram + scaffold |
| **import-circuit** | External circuit → twin pack |
| **prove** | Twin verify → `model_verified` |
| **observe** | Plots from elements |
| **desk-hw** | **Physical boards**: flash, serial/RTT → `hardware_observed` |

---

## Non-goals

- Rewrite Architect as the desk agent runtime in the browser  
- Pixel clone Cursor / Embedder  
- Extension panel suite instead of skills  
- Green without oracle  

---

## Success

1. Local agent exposes the **same `labwired_*` tools** as cloud agent/Architect (parity goal).  
2. Open local Agent → Cursor-simple chrome → `labwired agent` engine.  
3. Twin loop works locally; **physical boards** on the desk (**desk-hw**).  
4. Run twin → **board glass shows** diagram + running/serial/display when available.  
5. Debug → **DAP starts** in VS Code (same suite).  
6. Twin green = `model_verified` only; desk green = `hardware_observed` only.  

---

## Doc map

| Doc | Role |
|------|------|
| **This file** | Binding product definition |
| `config/AGENTS.md` | Runtime rules for the engine |
| `skills/README.md` | Skill catalog |
| `extensions/labwired-vscode/docs/PRODUCT.md` | Extension pointer |

## Product depth

See [PRODUCT_DEPTH.md](./PRODUCT_DEPTH.md) — full knowledge, import, desk, workbench, enterprise depth is **required product**, not optional.

