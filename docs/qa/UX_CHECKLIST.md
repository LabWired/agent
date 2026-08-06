# User experience checklist — LabWired Editor

**Date:** 2026-07-31  
**Companion to:** `2026-07-31-agent-product-ready.md` (agent gate)  
**Principle:** Tools can be correct and still feel broken if people cannot find them, trust them, or recover from empty states.

---

## First-run experience

| Step | What the user should see | Status |
|------|--------------------------|--------|
| Open Agent sidebar | “LabWired Agent” empty state + claim vocabulary | **improved** |
| Suggested actions | Doctor, twin-verify, bring-up, probe, promote dry-run, plan | **improved** |
| Type `/` | Slash menu: LabWired tools + modes | **improved** |
| Hint under input | `/doctor /probe /gdb …` not only code modes | **improved** |
| Missing agent | CTA Install CLI + Refresh Agent | **existing** |

## Discoverability (Command Palette)

Type **LabWired:** — category groups:

| Command | Purpose |
|---------|---------|
| Open HW Lab | Targets + Live surfaces |
| Open Evidence | Claim / twin evidence |
| Sign In / Project / Account | Hosted cloud path |
| Install CLI / Refresh Agent | Local agent lifecycle |
| Debug Info / GDB Start|Stop / Read Target Memory | Probe tooling |
| Flash Firmware (with confirm) | **Dialog** before physical flash |

## HW Lab

| Surface | UX expectation |
|---------|----------------|
| Header | ● Agent / ○ Agent offline |
| Offline banner (Live tab) | Demo still works; how to reconnect agent |
| Run demo | Serial + plot fill without probe |
| Plot empty | Explains `temp=23.5` + demo/Connect |
| Registers Demo\|Live | Live does **not** require GDB client; Refresh uses `debug_read` |
| Live errors | Probe/power/install hints, not “start GDB first” |
| Serial | Port picker, baud, Connect/Disconnect |

## Chat claim vocabulary (always visible)

- **`model_verified`** — twin / oracle only  
- **`hardware_observed`** — desk flash + marker  
- Never invent either claim from chat alone  

Slash:

| Command | Behavior |
|---------|----------|
| `/promote` | Safe **dry-run** claim shape (tool) |
| `/promote-hw` | Full desk promote skill prompt (confirm=1) |
| `/flash` | Prefer virtual; physical needs confirm |
| `/hwlab` | Guide through HW Lab |

## Human smoke (5 minutes)

```bash
export PATH="/opt/homebrew/opt/node@20/bin:$PATH"
cd ~/Projects/labwired-cursor
npm run buildreact   # after UI changes
./scripts/code.sh --user-data-dir ./.tmp/user-data --extensions-dir ./.tmp/extensions
```

1. Command Palette → **LabWired: Refresh Agent** → green notification  
2. New chat → starters → **Check agent & tools** (`/doctor`)  
3. Type `/` → see gdb / plot / promote  
4. **Open HW Lab** → Run demo → plot moves  
5. Registers → **Live** → **Refresh** (ESP32-C3 attached)  
6. **Flash Firmware (with confirm)** → pick virtual or cancel physical dialog  

## Automated UX-related gate

`labwired-agent/tests/gap-ready-qa.sh` includes static checks for:

- flash confirm command id  
- agent offline banner source  
- chat starters + claim copy  

---

## Still human-only

Full Electron click E2E, sign-in device code, real UART Connect session, STM32 powered read.
