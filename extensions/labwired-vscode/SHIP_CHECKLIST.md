# LabWired Workbench — ship checklist (G0 → G2)

Evidence paths are relative to the agent kit root unless noted.

## G0 — Install

- [x] Extension package name LabWired (`package.json` displayName)
- [x] Install CLI walkthrough step (command `labwired.installCli`)
- [x] Evidence: `extensions/labwired-vscode/package.json` walkthrough id `labwiredGettingStarted`

## G1 — Auth + doctor

- [x] Log in command uses same device-code as CLI (`labwired.login`)
- [x] Doctor command (`labwired.doctor`)
- [x] Terminal start agent name **LabWired Agent** (not OpenCode) — `src/cli/bridge.ts`
- [x] Evidence: `OPENCODE_DISABLE_TERMINAL_TITLE=1` in `envForAgent`; walkthrough title "Start LabWired Agent"

## G2 — Golden path parity

- [x] Start Agent runs bare `labwired` / kit path (prepare + packs + MCP)
- [x] Knowledge path: part + datasheet tools (CLI/MCP) — agent skills bringup
- [x] Dual claims: desk ≠ twin documented in README + desk-hw skill
- [x] Plot glass is compose JSON only (no Open Plot product) — observe skill
- [x] Billing/team: real URL / login — no fake success panels (billing uses cloud session)
- [x] Evidence: `docs/GOLDEN_PATH.md`, `skills/desk-hw/SKILL.md`, `skills/observe/SKILL.md`

## Build

```bash
# from extensions/labwired-vscode when shipping a VSIX
# npm install && npm run package   # produces .vsix for sideload
```

- [x] Sideload path documented (CLONE / README of extension)

## Not done / out of G2

- Full marketplace publish pipeline (release process, not G2 UI completeness)
