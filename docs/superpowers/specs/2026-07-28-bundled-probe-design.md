# Design: Bundled multi-probe support for LabWired Agent

**Date:** 2026-07-28  
**Status:** Implementing (CLI v0: `labwired probe`, skill, install hook)  
**Goal:** Real-board flash/debug ships with the agent. Users do not install or think about OpenOCD.

---

## Decision

| Do | Don’t |
|----|--------|
| **probe-rs first** as the default backend | Market or require OpenOCD |
| One LabWired surface: `labwired probe …` / MCP tools | Expose raw OpenOCD Tcl / GDB recipes |
| Auto-detect popular probes | Ask users which `.cfg` file to use |
| Bundle probe stack with agent install | “Install OpenOCD separately” as the path |
| Keep OpenOCD as **optional fallback** only | Build our identity around OpenOCD |

**Why probe-rs:** one Rust stack, many probes (CMSIS-DAP, ST-Link, J-Link, ESP USB-JTAG, etc.), chip database, flash + RTT + memory. Matches “works with popular debuggers” without per-vendor CLI soup.

**Why not OpenOCD-first:** powerful but cfg hell, version drift, bad agent UX, not a product brand.

---

## Product story

```
Agent writes firmware
    → virtual board (sim) until green
    → labwired probe flash / run on desk board
    → serial / RTT observe
    → report: model_verified  vs  hardware-observed  (separate claims)
```

Users see: **LabWired Agent + your probe.**  
Not: install OpenOCD, pick interface cfg, pick target cfg.

---

## What “bundled with agent” means

On `./install.sh` / `agent-install.sh` (best-effort by OS/arch):

1. Install agent kit (already).  
2. Install or pin **probe-rs** CLI (or ship a thin LabWired wrapper that embeds/invokes it).  
3. Wire MCP tools for probe ops into the same OpenCode config.  
4. Ship skill `flash-firmware` (or extend verify/diagnose): sim first, then optional hardware.

If probe-rs cannot install (offline/air-gap), doctor warns: hardware path unavailable; sim still works.

---

## Probe coverage (v0 target)

| Probe family | Via probe-rs | Priority |
|--------------|--------------|----------|
| CMSIS-DAP / DAPLink | Yes | P0 (Nucleo, many kits) |
| ST-Link (V2/V3) | Yes | P0 |
| J-Link | Yes (with vendor lib where needed) | P0 |
| ESP USB-JTAG / built-in | Yes / partial | P1 |
| Black Magic | Yes if supported upstream | P2 |
| OpenOCD-only oddballs | Fallback backend later | P2 |

Chip list: start with LabWired catalog beachheads (STM32, nRF52, RP2040, ESP32) that probe-rs already names.

---

## Agent / MCP surface (v0)

Stable verbs (names illustrative):

| Tool | Job |
|------|-----|
| `probe_list` | List attached probes |
| `probe_info` | Probe + chip identity |
| `probe_flash` | Flash ELF/bin to chip |
| `probe_reset` | Reset / halt / run |
| `probe_rtt` / serial | Observe logs |
| `probe_read` | Optional memory/register (debug) |

Implementation options (pick one in plan):

**A (recommended first):** wrap **probe-rs** CLI + small MCP server in-repo (`@labwired/probe` or `labwired-probe`).  
**B:** vendor/adapt MIT `embedded-debugger-mcp` tool taxonomy, rebrand, default backend = probe-rs only.  
**C:** later optional OpenOCD backend behind the same tools for edge chips.

User never chooses A/B/C — only `labwired` / MCP.

---

## Claims (non-negotiable)

| Status | Meaning |
|--------|---------|
| `model_verified` | Sim/oracle only |
| `hardware_observed` / similar | Probe flash + observed UART/RTT/registers (define later) |
| Never | Upgrade sim green to “works on hardware” without probe path |

---

## Install UX

```bash
curl -fsSL https://labwired.com/agent-install.sh | sh
labwired doctor
# shows: agent ok, sim ?, probe-rs ok, probes: ST-Link #0
labwired
```

Doctor lines:

- `ok  probe-backend: probe-rs x.y`  
- `ok  probe: STLink V2 …` or `warn probe: none attached`  
- Never: `install openocd`

---

## Out of scope for v0

- Full time-travel on silicon  
- LabWired HIL hardware product  
- Training a model to use OpenOCD  
- Supporting every obscure probe on day one  

---

## Implementation order

1. Spec tool list + claim names (this doc).  
2. Pin probe-rs in agent install (macOS/Linux/Windows).  
3. Minimal MCP: list / flash / reset.  
4. Skill: after sim green, offer flash.  
5. Doctor + docs.  
6. Optional: OpenOCD fallback backend, same tools.

---

## Success

- Nucleo + ST-Link or CMSIS-DAP: install agent → flash ELF without mentioning OpenOCD.  
- J-Link user: same commands.  
- Agent page: “Works with popular debug probes” — not “requires OpenOCD.”
