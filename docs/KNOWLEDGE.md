# Knowledge interface (clear, one path)

**Agent job:** Answer hardware questions (pins, addresses, registers, notes) **without inventing**.

**Public story:** Knowledge via shared MCP tools after login — not “we mirror every manufacturer PDF.”

**Internal reality (do not market):** We **do** host datasheet PDFs and train/retrieve over a **vector index** so `labwired_datasheet` (and related search) can return grounded text. That is an implementation detail, not a homepage feature.

---

## Agent-facing interface (one)

Same questions → one path → **`bringup`** skill + MCP:

```text
1. labwired_list / labwired_describe   → id + pin/bus overview
2. labwired_part                       → structured fact when present (preferred)
3. labwired_datasheet                  → grounded text when fact missing or prose needed
4. Still empty → say missing; never invent
```

Do **not** teach the agent two products (“parts app” vs “datasheet app”).  
Do **not** tell users “download our full PDF library.”

---

## Trust levels

| Kind | Source | Agent may say |
|------|--------|----------------|
| **Fact** | Curated / checked structured store (`labwired_part`) | “Tool fact: …” |
| **Quote** | Retrieval over hosted corpus (`labwired_datasheet` / vector path) | “Per knowledge tool: …” |
| **Missing** | No fact, no useful hit | “No LabWired knowledge for … — do not invent” |

Facts beat quotes when both exist. Quotes never mint `model_verified`.

---

## MCP tools (stable names)

| Tool | Role |
|------|------|
| `labwired_list` / `labwired_describe` | Discover + overview |
| `labwired_part` (+ citation helpers) | Structured answers |
| `labwired_datasheet` | Text / page / snippet from knowledge backend |

Optional future: one facade tool that returns `{ kind: fact\|quote\|missing, ... }` while keeping these backends.

---

## Messaging rules

| OK (product / agent docs) | Avoid (public marketing) |
|---------------------------|---------------------------|
| “Parts and datasheet context via MCP” | “We host all manufacturer datasheets” |
| “Grounded answers from LabWired knowledge tools” | “Full PDF mirror / free datasheet CDN” |
| “Never invent pins or register values” | Implying we redistribute every vendor PDF as a library product |

Internal eng/docs may discuss PDF ingest + vector DB. **Customer-facing copy stays tool-level.**

---

## Not knowledge

| Job | Interface |
|-----|-----------|
| Twin green | `prove` → `labwired_verify` |
| Plots | `observe` |
| Desk HW | `desk-hw` |

---

## Binding rules

1. One agent path: **`bringup` + knowledge MCP tools**.  
2. Prefer **facts**; use **datasheet tool** for grounded prose when needed.  
3. **Never invent.**  
4. Knowledge ≠ `model_verified`.  
5. **Don’t advertise** full-PDF hosting; backend may still ingest/index PDFs for retrieval.  
