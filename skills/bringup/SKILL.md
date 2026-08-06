---
name: bringup
description: >-
  Board/part context and minimal firmware scaffold. One knowledge path via MCP
  (list/describe/part, then datasheet tool for grounded text). Never invent
  pinouts or I2C addresses.
license: MIT
compatibility: opencode
metadata:
  gate: "workflow"
  labwired: "true"
  pack: "bringup"
  aliases: "part-knowledge,board-bringup,scaffold-firmware"
---

# Bringup (knowledge + diagram + scaffold)

**One knowledge interface** for pins/parts/electrical questions.  
Full contract: `docs/KNOWLEDGE.md`.

## Hard rules

1. **Never invent** pins, bus addresses, register values, or datasheet text.  
2. **One MCP knowledge path** (same questions):  
   `list` / `describe` → **`labwired_part`** (facts) → **`labwired_datasheet`** when you need grounded prose or the fact is missing.  
3. Knowledge is **not** `model_verified` (use **`prove`** for twin green).  
4. Scaffold is a **proposal** — compile success is not a pass.  
5. Do **not** tell the user we are a public full-PDF library — use tools; answer the question.

## A. Knowledge (same questions → one path)

Engineers ask the same things (“I²C addr?”, “which pin?”, “reset value?”). **One job**, one path:

| Step | Tool | Use |
|------|------|-----|
| 1 | `labwired_list` | Find part/board id |
| 2 | `labwired_describe` | Pins/buses overview |
| 3 | **`labwired_part`** | **Preferred** structured fact |
| 4 | **`labwired_datasheet`** | Grounded text from our knowledge MCP (quote tool output only) |
| 5 | — | Still empty → say **missing**; do not invent |

Label answers **fact** vs **quote** vs **missing**. Full contract: `docs/KNOWLEDGE.md`.

## B. Diagram

1. Draft `diagram` from tool values only.  
2. `labwired_validate` when available.  
3. No pin maps that contradict tools.

## C. Scaffold

1. Minimal blink and/or UART hello (`LED ON`/`OFF` if plots later).  
2. Optional marker `LABWIRED_OK` for desk promote.  
3. Hand off to **`prove`** or **`golden-path`**.

## Handoff

| Next | Pack |
|------|------|
| Twin prove | `prove` |
| Full loop | `golden-path` |
| Plot | `observe` |
