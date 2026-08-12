# Upstream OpenCode — easy upgrade policy

**Goal:** Ship **LabWired Agent** as the product while staying on **official `opencode-ai`** releases with minimal friction.

We do **not** fork OpenCode. We **pin + wrap**.

---

## Architecture (what we own)

| Layer | Owner | Upgrade cost |
|-------|--------|----------------|
| Chat runtime binary | Upstream npm `opencode-ai@OPENCODE_PIN` | Bump pin + smoke |
| Product launcher | Us (`labwired agent`) | Ours only |
| Login / session | Us (`~/.labwired/session/`) | Ours only |
| Skills, AGENTS.md, brand plugin | Us | Ours only |
| Twin tools MCP | Us (`labwired_*`) | Ours only |
| Config *directory* (user-visible) | Us (`~/.config/labwired-agent`) via `OPENCODE_CONFIG_DIR` | Official env |
| Config *filenames* inside that dir | Upstream (`opencode.json`, `tui.json`, …) | **Do not rename** |

---

## Hard rules (keep upgrades easy)

1. **Never fork** the OpenCode source tree or ship a patched binary.  
2. **Never** reimplement the TUI; brand only via supported config + plugins (`home_logo`, theme).  
3. **Always** enter via `labwired agent` (sets `OPENCODE_CONFIG_DIR`, session env, branding).  
4. **Pin deliberately** — one constant: `OPENCODE_PIN` in `bin/labwired-agent` and `install.sh` (keep in sync).  
5. **Do not rename** engine-required filenames (`opencode.json`, schema URLs). Product path is the **directory**, not those names.  
6. **Do not** depend on OpenCode product auth (Zen / `/connect`); LabWired login + env Bearer only.  
7. Deny built-in product skills we replace (`customize-opencode` → our `customize-labwired-agent`).  
8. Prefer **documented** config keys and env vars; if something needs binary patches, redesign.

---

## How to bump OpenCode (same-day path)

```bash
# 1) Pick release from https://www.npmjs.com/package/opencode-ai
PIN=1.x.y

# 2) Update both pins
#    bin/labwired-agent  OPENCODE_PIN=
#    install.sh          OPENCODE_PIN=
#    bin/labwired-agent.ps1 default pin if present

# 3) Install pin
npm install -g "opencode-ai@$PIN"

# 4) Smoke (minutes)
labwired agent doctor
labwired agent whoami          # hosted session
# Start TUI once: logo LabWired, send one prompt, one MCP tool

# 5) Ship kit if green
```

If smoke fails, check only:

- Config schema / provider / MCP remote options  
- TUI plugin API (`@opencode-ai/plugin/tui`)  
- Env substitution `{env:…}`  

Do **not** patch upstream; pin-revert or adapt our wrapper/config.

---

## What product branding is allowed

| OK (wrapper) | Not OK (fork tax) |
|--------------|-------------------|
| `~/.config/labwired-agent` + `OPENCODE_CONFIG_DIR` | Patching `opencode` binary |
| Theme + `labwired-brand.tsx` home_logo | Replacing every internal i18n string |
| Deny engine skills; ship our skills | Maintaining a git fork of opencode |
| LabWired login → env for model/MCP | Custom auth inside engine store |
| Display names Hosted / Default / Fast | Renaming `opencode.json` on disk |

---

## Related

- Pin: `OPENCODE_PIN` in `bin/labwired-agent`, `install.sh`  
- Product entry: `docs/PRODUCT.md`  
- Config skill: `skills/customize-labwired-agent`  
