# LabWired agent skills (prepacked)

Clear interfaces — few packs, one knowledge path, shared MCP.

```text
Skills (how to work)     MCP tools (what is true)
─────────────────────    ────────────────────────
golden-path / packs  →   labwired_* (knowledge, prove, …)
Superpowers          →   process only (never mint green)
```

---

## Domain packs (firmware)

| Pack | Interface job |
|------|----------------|
| **`golden-path`** | Entry: full stranger loop |
| **`bringup`** | **Knowledge + diagram + scaffold** (one path for part questions) |
| **`prove`** | Twin verify / repair / evidence → `model_verified` |
| **`observe`** | Compose plots from **elements** |
| **`desk-hw`** | Flash + `hardware_observed` |

```text
golden-path → bringup → prove → optional observe → optional desk-hw
```

### Claims

| Claim | Interface |
|-------|-----------|
| `model_verified` | **`prove`** + `labwired_verify` only |
| `hardware_observed` | **`desk-hw`** (flash + marker) |
| Pin / part answers | **`bringup`** + knowledge MCP (below) |

Sim is **not** forced; debugger is first-class when twin is missing.

---

## Knowledge (one agent path)

**Job:** Same hardware questions (pins, addrs, registers, notes) without inventing.

| Agent does | MCP tools |
|------------|-----------|
| Load **`bringup`** | |
| Find part | `labwired_list` / `labwired_describe` |
| Prefer structured answer | **`labwired_part`** |
| Grounded prose / missing fact | **`labwired_datasheet`** (our datasheet MCP) |
| Still nothing | Say **missing** |

**Agent-facing:** one knowledge path (not two products).  
**Public copy:** knowledge via MCP — do not advertise a full public PDF library.  
**Internal:** PDF ingest + vector DB may back `labwired_datasheet`; keep that off marketing.

Full contract: **[`docs/KNOWLEDGE.md`](../docs/KNOWLEDGE.md)**.


## Superpowers (process)

Prepacked: `using-superpowers`, TDD, plans, systematic-debugging, …  

**Priority:** user → LabWired claims → knowledge MCP → Superpowers process.

---

## Other MCP (not knowledge)

| Job | Tools |
|-----|--------|
| Prove | `labwired_compile` / `run` / `verify` |
| Inspect | `labwired_inspect` |
| Validate wiring | `labwired_validate` |

---

## No legacy skill names

Only the **5 domain packs** + Superpowers process skills ship.  
Old names (`verify-firmware`, `part-knowledge`, …) are **dropped**.
