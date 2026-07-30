# Twin catalog (agent)

Thin board index for the firmware agent — **no monorepo checkout required**.

| Path | Role |
|------|------|
| `boards.json` | List of twin board ids |
| `systems/<id>.yaml` | System manifest with `chip: "<id>"` (bundled in labwired-sim) |

Chip register maps ship **inside labwired-sim**. These YAMLs only name the chip
and optional board I/O — they do not vendor the full core `configs/` tree.

```bash
# Resolve a system for a chip
labwired_catalog_system esp32c3   # via lib/resolve-catalog.sh

# Refresh list of system stubs (does not need core)
scripts/sync-catalog.sh
```

Override:

| Env | Meaning |
|-----|---------|
| `LABWIRED_CATALOG` | Absolute path to this catalog root |
| `LABWIRED_HW_SYSTEM` | Explicit system YAML (wins over catalog) |
| `LABWIRED_CORE_SRC` | Optional monorepo core (dev only) |
