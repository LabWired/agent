---
name: bringup
description: >-
  Board/part context and minimal firmware scaffold. Tools for pins and parts
  only — never invent pinouts or I2C addresses. Use before writing or claiming
  behavior. Pack: part knowledge + diagram validate + scaffold.
license: MIT
compatibility: opencode
metadata:
  gate: "workflow"
  labwired: "true"
  pack: "bringup"
  aliases: "part-knowledge,board-bringup,scaffold-firmware"
---

# Bringup (parts + diagram + scaffold)

**Pack** of: part-knowledge · board-bringup · scaffold-firmware.

## Hard rules

1. **Never invent** pin numbers, bus addresses, register resets from model memory.  
2. Call MCP tools first: `labwired_list` / `labwired_describe` / `labwired_part*`.  
3. **Datasheets only via MCP `labwired_datasheet`** — not model memory, not random web
   scrape as authority. Quote tool output only.  
4. A fact is **not** `model_verified`. Only **prove** pack / `labwired_verify` mints that.  
5. Scaffold is a **proposal** — compile success is not a pass.

## A. Part knowledge (context before code)

1. Identify part/board (ask once if unclear).  
2. `labwired_list` → `labwired_describe` → **`labwired_part`** for pins/buses firmware will touch.  
3. If a field is missing: call **`labwired_datasheet`** (our datasheet MCP) and  
   **quote only returned text**.  
4. If tools return nothing / ambiguous — say so; do not fill gaps.

## B. Board / diagram

1. Draft `diagram` JSON (MCU type, nets, peripherals) from tool values only.  
2. `labwired_validate` when available; fix pin/bus errors.  
3. Never invent pin maps that contradict describe/part output.

## C. Scaffold firmware

1. Smallest blink and/or UART hello (prefer `LED ON`/`LED OFF` lines if plots later).  
2. Optional marker e.g. `LABWIRED_OK` for desk promote later.  
3. No drive-by refactors.  
4. Hand off to **`prove`** (or `golden-path`) with an oracle for that behavior.

## Handoff

| Next | Skill pack |
|------|------------|
| Prove on twin | `prove` |
| Full stranger path | `golden-path` |
| Plot after run | `observe` |
