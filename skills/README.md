# LabWired agent skills (organized)

**Too many skills confuses the agent.** We ship **five primary packs**.  
Old names (verify-firmware, board-bringup, …) are **aliases** → load the pack.

## Primary packs (use these)

| Pack | When | Was (aliases) |
|------|------|----------------|
| **`golden-path`** | Default / stranger / “prove it” end-to-end | (entry) |
| **`bringup`** | Pins, parts, diagram, minimal firmware skeleton | part-knowledge, board-bringup, scaffold-firmware |
| **`prove`** | Twin verify, repair ≤3, evidence report | verify-firmware, diagnose-firmware, firmware-repair-loop, report-evidence, inspect-evidence |
| **`observe`** | Plots / overlays from **elements** (not ready-made plots) | compose-observability |
| **`desk-hw`** | Flash probe / promote → `hardware_observed` only | flash-firmware, hw-promote |

## Claim rules (all packs)

| Claim | Source |
|-------|--------|
| `model_verified` | **Only** `labwired_verify` (prove pack) |
| `hardware_observed` | Flash **and** serial/RTT marker (desk-hw) |
| Observation / plot | Never upgrades either claim |

Sim is **not** forced — debugger path is first-class when twin tools are missing (see golden-path / prove).

## Default loop

```text
bringup → (write) → prove → optional observe → optional desk-hw
```

Or just load **`golden-path`** and follow it.

## Alias skills

Thin `SKILL.md` stubs redirect to the pack above so older prompts and configs still resolve.
