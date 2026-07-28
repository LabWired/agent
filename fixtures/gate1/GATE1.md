# Gate 1 public proof — draft → fail → patch → model_verified

This fixture is the public red→green story for the LabWired Firmware Agent.
It does not replace a live `labwired_verify` run; it shows the **claim shape**
and offline gates anyone can check without a simulator.

## Story

| Step | What happens | Artifact |
|------|----------------|----------|
| 1. Draft | Broken firmware prints `BOOT` | `broken/main.c` |
| 2. Fail | Oracle wants serial `LABWIRED_OK` | `oracle.json` + `artifacts/broken.verify.json` (`status: failed`) |
| 3. Patch | Fixed firmware prints `LABWIRED_OK` | `fixed/main.c` |
| 4. Dispose | Same oracle passes | `artifacts/fixed.verify.json` (`status: model_verified`) |

## Offline check (no sim)

From the agent repo root:

```bash
./demo.sh
# or only claim gates:
bin/labwired assert-status failed fixtures/gate1/artifacts/broken.verify.json
bin/labwired assert-status model_verified fixtures/gate1/artifacts/fixed.verify.json
```

`assert-status` exits 0 only when the JSON `status` matches. That is the same
hard gate the agent must obey after every `labwired_verify`.

## Live path (with sim + MCP)

1. `./install.sh` then `labwired doctor`
2. Compile broken (builder or local toolchain) → `labwired_verify` with `oracle.json` + `diagram.json`
3. Expect **not** `model_verified`
4. Compile fixed → same oracle → expect `status: model_verified`
5. Optional: `DEMO_LIVE_VERIFY=1 DEMO_VERIFY_JSON=path/to/live.json ./demo.sh`

## Honesty

- `model_verified` is **simulation/oracle** truth, not hardware confirmation.
- Checked-in `artifacts/*.verify.json` are **demo shapes** for CI and docs.
  Production claims need a live verify payload from your twin.
- `proven: true` is only a deprecated alias for `model_verified`.

See [README.md](README.md) in this folder for diagram board notes.
