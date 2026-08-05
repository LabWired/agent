# LabWired Firmware Agent — product packaging

**Tagline:** The easiest way to write firmware.

Package the agent like a **product people install and pay for**, not an internal harness dump.

---

## How competitors package (steal the shape, not the stack)

| | **BootLoop** | **Embedder** | **Cursor / Claude Code** | **Us (target)** |
|--|--------------|--------------|--------------------------|-----------------|
| **Hero** | Firmware in minutes, on real HW | Cursor for embedded | Ship code from terminal | Write firmware, check on a virtual board |
| **Install** | Single-command / pilot (high-touch) | `npm i -g` + web app + free credits | `curl \| bash` or `npm i -g` | **`curl \| sh` + optional npm** |
| **Product suite** | Agent · Test · Sentinel (3 SKUs) | One agent platform | One CLI product | **Agent (free) · Pro · Enterprise** |
| **Proof** | Demo / pilot on customer HW | Free trial credits | Interactive demo | Gate 1 red→green + Playground |
| **Trust** | ITAR, aerospace pedigree | Enterprise / instruments | Brand + models | Open MIT + twin check (not self-grade) |
| **GTM** | Forward-deployed pilots | Self-serve + sales | PLG | **PLG free agent → Pro workbench → Enterprise vault** |

**Do not** copy BootLoop’s three-product triad as homepage architecture until the free agent install is the obvious front door.

**Do** copy:

1. **One command to install**  
2. **Outcome-first headline** (not “MCP harness”)  
3. **Clear free vs paid**  
4. **Something that runs in under 5 minutes**  
5. **GitHub that looks like a product** (description, homepage, topics, releases)

---

## Our product surfaces

```
labwired.com
  ├─ Home #mcp          → dual path (Agent | Claude/Codex)
  ├─ /pro.html          → paid workbench + agent install
  └─ (soon) /agent      → dedicated product page (optional)

github.com/LabWired/agent   → OSS product home
  ├─ curl install / npm
  ├─ skills + demo
  └─ releases

app.labwired.com            → Playground (see it run)
```

### Tiers (packaging, not feature soup)

| SKU | What they get | Price posture |
|-----|----------------|---------------|
| **Firmware Agent (OSS)** | CLI agent, skills, local/BYO model, twin check via MCP | Free, MIT |
| **Pro** | Private projects, priority builds, editor workbench, support | Stripe / seat |
| **Enterprise** | Air-gap, on-prem model, vault, HIL in CI, SSO | Sales |

Same **check** everywhere: virtual board (and later real HW) — agent never self-grades a pass.

---

## Install story (product-critical)

**Primary (share everywhere):**

```bash
curl -fsSL https://labwired.com/agent-install.sh | sh
labwired doctor
labwired
```

**Secondary:**

```bash
npm i -g @labwired/agent && labwired
# or
git clone https://github.com/LabWired/agent && cd agent && ./install.sh
```

**BYO agent:**

```bash
claude mcp add labwired --transport http https://api.labwired.com/mcp
```

Install must land:

1. `labwired` on PATH  
2. OpenCode pin + skills + config  
3. Clear next steps if simulator missing  

---

## Packaging backlog

### P0 — feels like a product this week

- [x] Plain tagline + README product voice  
- [x] Six skills + Gate 1 demo artifacts  
- [ ] **One-command curl install** (`agent-install.sh` bootstrap)  
- [ ] **GitHub**: homepage, description, topics  
- [ ] **VERSION + CHANGELOG** + optional npm `@labwired/agent`  
- [ ] Landing install one-liner matches curl (not only git clone)  
- [ ] Landing PR #188 merged  

### P1 — looks like a product

- [x] Dedicated `/agent` page (hero, install, looping demo, Pro upsell)  
- [x] ~30s looping demo: describe → fail → fix → green (`assets/agent-demo.js`)  
- [x] GitHub Release `v0.1.0` with notes  
- [ ] `labwired update` (pull agent home + reinstall skills)  
- [ ] Social OG image for agent  

### P2 — sells like a product

- [x] Free cloud path: hosted MCP + model gateway without local sim (`labwired login` + `config/opencode.hosted.json`)  
- [ ] Pro: agent session in editor (VS Code / Studio) as default paid story  
- [ ] Enterprise one-pager: air-gap install + on-prem model  
- [ ] Pilot motion for regulated teams (BootLoop-style FDE optional)  

---

## Messaging rules

**Use**

- The easiest way to write firmware  
- Checks on a virtual board before you flash  
- Free install · Pro workbench · Enterprise vault  

**Avoid on marketing surfaces**

- oracle / fail-closed / harness / Gate 1 / model_verified soup  
- “distribution layer” / “no fork” nerd footnotes  

Keep strict status rules in `AGENTS.md` and CI — not on the homepage.

---

## Success metrics

1. Stranger runs **one command**, gets `labwired doctor` mostly green  
2. GitHub repo reads as a **product**, not a script dump  
3. Home + Pro push the same install line  
4. Time-to-first-green (demo or live twin) documented and under 15 minutes with sim  
