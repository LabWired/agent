---
name: part-knowledge
description: >-
  Fetch pinouts, electrical facts, and datasheet text via LabWired tools before
  any hardware claim or firmware that depends on pins/addrs/registers. Never
  invent pin maps, I2C addresses, or register values from model memory.
license: MIT
compatibility: opencode
metadata:
  gate: "knowledge"
  labwired: "true"
  product: "context-before-code"
---

# Part knowledge (context before code)

## Hard rules

1. **Never invent** pin numbers, bus addresses, register resets, package pins,
   or “usual” wiring from model memory.
2. **Tools first.** For any pinout / part / electrical / register fact, call
   LabWired knowledge tools **before** writing firmware that depends on it.
3. A part fact is **not** `model_verified`. Only `labwired_verify` mints that.
4. If tools return nothing / ambiguous, say so and ask — do not fill gaps.

## Preferred tools (use what the surface exposes)

| Job | Tools (try in order) |
|-----|----------------------|
| Find board / MCU / part id | `labwired_list` (filter), search |
| Pins, buses, attrs | `labwired_describe` |
| Structured part facts | `labwired_part` / `labwired_part_resolve` → `labwired_part_get` (+ citation when available) |
| Raw datasheet text | `labwired_datasheet` (search / page) when a fact is missing from part store |
| Diagram truth | `labwired_validate` after wiring |

If only a subset is available (local MCP), use list/describe/validate and state
that structured part store was unavailable — still **do not invent**.

## Procedure

1. Identify the part or board the user named (or ask once).
2. **List / resolve** → get a canonical id or configuration.
3. **Describe / get facts** for pins and buses the firmware will touch.
4. If a field is missing (e.g. I²C address not in facts), **datasheet search**
   and quote returned text only — never invent the address.
5. Draft diagram / firmware using **only** tool-returned values.
6. Hand off to `board-bringup` / `scaffold-firmware` / `verify-firmware`.

## When to load this skill

- User asks “what’s the pinout / I²C address / register …?”
- New board or sensor before first firmware write
- Bring-up when verify rejects diagram or wrong pins suspected
- Any claim that would be wrong if the model “remembered” silicon

## Never

- Answer pin/addr/register from training memory  
- Override `labwired_part` facts with vague datasheet RAG  
- Claim hardware works from a cited datasheet alone  
- Skip tools because “everyone knows BME280 is 0x76”  

## Embedder offering beat

Embedder: datasheet-grounded chat story.  
**Us:** structured facts + raw text tools + **refuse invent** + later twin check.
