# Gate 1 red→green fixture

Demo oracle for the OpenCode harness (this repo), not for the monorepo product UI.

## Oracle

`oracle.json` requires serial marker `LABWIRED_OK`.

| Tree | Prints | Expected status |
|------|--------|-----------------|
| `broken/main.c` | `BOOT` | failed (or non-model_verified) |
| `fixed/main.c` | `LABWIRED_OK` | model_verified when twin path is healthy |

`diagram.json` targets `nucleo-l476rg` / `stm32l476` — swap if your local sim beachhead differs.

## Human demo

1. `./install.sh` then `labwired doctor`
2. Compile broken → `labwired_verify` with oracle + diagram → **not** model_verified
3. Compile fixed → same oracle → **model_verified**
4. Optional: load skill `inspect-evidence` if `evidence_ref` is returned
