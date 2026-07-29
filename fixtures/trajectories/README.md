# Trajectory fixtures (JSONL)

Ordered agent trajectories for demos, harness eval, and a **later** QLoRA /
SFT corpus. v0 does **not** ship a training pipeline; this directory only
defines the on-disk shape so collectors and eval tools stay aligned.

## Format

- **One trajectory per line** in `*.jsonl` (UTF-8, no pretty-print inside a line).
- Optional multi-line pretty JSON samples may live beside JSONL for humans;
  machines should prefer JSONL + `schema.json`.
- Schema: [`schema.json`](schema.json) (Draft 2020-12 subset, minimal).

## Top-level object

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | no | Stable trajectory id (e.g. `gate1-repair-01`) |
| `task` | object | **yes** | What the agent was asked to do |
| `tools` | array | **yes** | Ordered tool / skill invocations |
| `observations` | array | **yes** | Runner / twin / serial observations |
| `patch` | object \| null | **yes** | Code change applied (or `null` if none) |
| `verification` | object | **yes** | Final claim disposition |
| `meta` | object | no | Free-form tags, model id, budget, etc. |

### `task`

| Field | Type | Description |
|-------|------|-------------|
| `prompt` | string | User or harness instruction |
| `goal` | string | Optional short goal label |
| `fixture` | string | Optional path under `fixtures/` |
| `oracle_ref` | string | Optional path/hash of frozen oracle |

### `tools[]`

Each step is one tool or skill action:

| Field | Type | Description |
|-------|------|-------------|
| `ts` | string | ISO-8601 timestamp (optional) |
| `name` | string | Tool or skill name (`labwired_verify`, `firmware-repair-loop`, …) |
| `kind` | string | One of: `verify`, `patch`, `flash`, `serial_capture`, `run`, `inspect`, `report`, `other` |
| `inputs` | object | Arguments / refs (paths, chip id, port env) |
| `result_ref` | string | Optional path or digest of tool output |
| `status` | string \| null | Tool-level status if any |

### `observations[]`

| Field | Type | Description |
|-------|------|-------------|
| `ts` | string | Optional timestamp |
| `source` | string | e.g. `labwired_run`, `serial-capture`, `twin` |
| `summary` | string | Short human-readable digest |
| `excerpt` | string | Optional log / serial excerpt |
| `status` | string \| null | Observation-level status if any |

### `patch`

| Field | Type | Description |
|-------|------|-------------|
| `diff` | string | Unified diff or empty |
| `files` | array of string | Paths touched |
| `summary` | string | One-line intent |

Use `null` when the trajectory has no code change.

### `verification`

| Field | Type | Description |
|-------|------|-------------|
| `status` | string | Exactly one of: `model_verified`, `hardware_observed`, `failed`, `inconclusive`, `unsupported` |
| `path` | string | Which path produced it: `twin`, `hardware`, `offline_claim`, `other` |
| `assert_ref` | string | Optional path to verify / HW result JSON |
| `notes` | string | Gaps, stop reason, dual-claim notes |

**Honesty rules (mirror `config/AGENTS.md`):**

- `model_verified` only from twin `labwired_verify`.
- `hardware_observed` only from flash **and** serial/RTT marker match.
- Never upgrade `hardware_observed` → `model_verified`.
- Repair trajectories should record at most **3** re-verify attempts after the first red (see repair budget).

## Example line (pretty-printed; collapse to one line in JSONL)

```json
{
  "id": "hw-serial-esp32c3-01",
  "task": {
    "prompt": "Flash serial-marker fixture and confirm LABWIRED_OK on the port",
    "goal": "hardware_observed",
    "fixture": "fixtures/hw-serial-esp32c3"
  },
  "tools": [
    {
      "name": "labwired probe flash",
      "kind": "flash",
      "inputs": { "chip": "esp32c3", "elf": "firmware.elf" },
      "status": null
    },
    {
      "name": "serial-capture",
      "kind": "serial_capture",
      "inputs": { "port_env": "LABWIRED_HW_PORT", "marker": "LABWIRED_OK" },
      "status": "ok"
    }
  ],
  "observations": [
    {
      "source": "serial-capture",
      "summary": "marker present in window",
      "excerpt": "LABWIRED_OK"
    }
  ],
  "patch": null,
  "verification": {
    "status": "hardware_observed",
    "path": "hardware",
    "notes": "flash + marker; not model_verified"
  }
}
```

## QLoRA / later training notes

When a collector is added:

1. Emit one JSONL object per episode (task → tools → observations → optional patch → verification).
2. Keep oracle identity and verification status machine-readable — do not train on soft-pass labels.
3. Prefer red→repair→green Gate 1 and generic HW promote episodes as seed data.
4. This repo’s product surface still **must not** invoke training as part of the agent runtime.

## Related

- Claim policy: `config/AGENTS.md`
- Twin red/green shape: `fixtures/gate1/`
- Example HW serial marker: `fixtures/hw-serial-esp32c3/` (`LABWIRED_OK`, port `LABWIRED_HW_PORT`)
- Generic cycle: `scripts/dev-cycle.sh`
