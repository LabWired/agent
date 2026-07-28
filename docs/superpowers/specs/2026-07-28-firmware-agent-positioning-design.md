# Design: LabWired Firmware Agent positioning

**Date:** 2026-07-28  
**Status:** Implemented (2026-07-28) — kit packaging + Gate 1 artifacts + landing one-liner; deploy landing + push agent still pending  
**Repos:**

| Repo | Role |
|------|------|
| [LabWired/agent](https://github.com/LabWired/agent) (`Projects/labwired-agent`) | Open Firmware Agent kit (OpenCode harness + skills + branding) |
| monorepo `landing_page/` (`Projects/labwired/landing_page`) | Live site source: **already has** `/pro.html` + homepage; we *extend* the funnel |

**Related docs:**

- `docs/plans/2026-07-27-unembarrass-agent-harness.md` (harness mechanics — already shipped)
- monorepo `docs/positioning.md`, `docs/pro-page-spec.md`, `docs/product-tiers.md`
- **Live:** https://labwired.com/pro.html (source: `landing_page/astro/src/partials/pro.body.html`)

---

## 1. Goal

Position LabWired as open-source tooling and the **go-to place to get a Firmware Agent**:

1. **Agent kit** — stock OpenCode harness, LabWired-branded, with a clear install story and skill pack.
2. **Landing funnel** — **Enhance** the existing Pro page (https://labwired.com/pro.html is already live) and add dual path on the **main** homepage (turnkey agent + BYO MCP). Do **not** rebuild `/pro.html` from scratch.

We do **not** fork OpenCode. We keep the existing harness (launcher, doctor, claim gate, resolve-sim/mcp, install, demo, tests) and package it as product surface.

### One-line promise

> **Get the LabWired Firmware Agent — propose firmware, dispose with a deterministic oracle. Open harness, open install, honest claims.**

### Free vs Pro boundary

| Surface | What it is | Claim |
|---------|------------|--------|
| **OSS agent kit** (`LabWired/agent`) | OpenCode-based harness + skills + MCP wiring | Install free; run with local model and/or MCP; model-verified only via oracle |
| **Hosted Playground / MCP** | Cloud path on labwired.com | Try without local sim |
| **Pro** (`/pro.html`) | Paid product loop: harness + verified runs + IDE/debug roadmap | Narrative + upgrade path; no vaporware |

---

## 2. Architecture (keep harness, change packaging)

```
┌─────────────────────────────────────────────────────────┐
│  labwired.com                                           │
│  Homepage #agent-harness ──► dual path                  │
│     A) Turnkey: clone LabWired/agent → ./install.sh     │
│     B) BYO: hosted MCP / local npx @labwired/mcp        │
│  /pro.html ──► Pro loop narrative + CTAs                │
│     → github.com/LabWired/agent                         │
│     → Playground / pricing / enterprise contact         │
└───────────────────────────┬─────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────┐
│  LabWired/agent (this kit)                              │
│  bin/labwired → stock opencode                          │
│  config/ (opencode.json, AGENTS.md)                     │
│  skills/ (Gate 1 + workflow skills)                     │
│  branding/ (logo, banner)                               │
│  MCP → @labwired/mcp → simulator oracle                 │
└─────────────────────────────────────────────────────────┘
```

**Invariant:** No OpenCode fork. Pin stays deliberate (`opencode-ai@1.18.7` until bumped). Claim gate (`assert-status` / AGENTS.md) remains fail-closed.

---

## 3. LabWired/agent changes

### 3.1 README (primary product surface)

Rewrite for a developer landing on GitHub who wants a **Firmware Agent**, not an internal harness note.

Required sections:

1. **Hero** — title “LabWired Firmware Agent”, one-line promise, badges (MIT, OpenCode-based, skills).
2. **Install in 60 seconds** — clone → `./install.sh` → `labwired doctor` → `./demo.sh` → `labwired`.
3. **What you get** — agent + MCP + oracle claim rules + skill pack.
4. **Skills table** — all shipped skills with one-line jobs.
5. **Binary story** — agent launcher vs simulator vs MCP (keep current honest table).
6. **Air-gap / ITAR** — keep; point to `mcp/README.md`.
7. **Not here** — platform monorepo, Studio, HIL, Enterprise Helm.
8. **Links** — labwired.com, `/pro.html`, Playground, core.

Tone: open-source product, not internal ops. Keep technical accuracy from the current README.

### 3.2 Branding

| Asset | Purpose |
|-------|---------|
| `branding/logo.svg` | LabWired mark (from landing `logo.svg` / chrome mark) |
| `branding/banner.txt` | Optional ASCII banner for `labwired` / `labwired help` |
| README logo + shields | GitHub social proof |

Launcher copy:

- `labwired version` / help: “LabWired Firmware Agent — the easiest way to write firmware”
- doctor headers stay cyan `==>` style; no noisy splash every launch (banner only on `help` / first-run note optional)

`config/opencode.json` agent block:

- `name` / `description`: “LabWired Firmware Agent — proposes firmware; model-verifies with the deterministic oracle.”
- Provider display name stays “LabWired (local)”

### 3.3 Skills

**Keep (Gate 1 claim core):**

| Skill | Job |
|-------|-----|
| `verify-firmware` | Mandatory-oracle model verification |
| `diagnose-firmware` | Fail first, patch, re-verify |
| `inspect-evidence` | Explain `evidence_ref` / status (read-only) |

**Add (workflow pack — 3 skills):**

| Skill | Job |
|-------|-----|
| `board-bringup` | Choose board/MCU, draft a valid diagram, validate pins/buses before firmware claims |
| `scaffold-firmware` | Minimal blink/UART hello skeleton for target (Arduino/bare-metal first; Zephyr only if docs honest) |
| `report-evidence` | Turn verify JSON + gaps into a human/CI report; never invent pass |

Rules for every skill:

- Frontmatter: `license: MIT`, `compatibility: opencode`, `metadata.labwired: "true"`, gate or workflow tag
- Point at claim vocabulary; never allow soft-pass
- No duplicate of deleted `firmware-verification` name — use `verify-firmware` as the oracle skill

**Wire-up:**

- `config/opencode.json` + `opencode.airgap.json` → `permission.skill` allowlist for all six
- `install.sh` already copies `skills/` — ensure inventory
- `tests/harness.sh` → assert six skill directories exist
- `config/AGENTS.md` → list all six and when to load them

### 3.4 AGENTS.md

Extend standing rules:

- Role: “LabWired Firmware Agent”
- Skills list includes new three with “when to use”
- Claim gate unchanged (status string, assert-status)
- Branding line only; no marketing fluff that weakens claims

### 3.5 Harness code

**Do not rework** resolve-sim, resolve-mcp, assert-status, demo claim gate unless a skill install breaks tests.

Allowed micro-edits:

- Version/help strings for “Firmware Agent”
- Optional banner on help
- Skill allowlist + doctor skill count if doctor enumerates skills

---

## 4. Landing funnel (monorepo `landing_page/` — Pro already live)

**Correction (2026-07-28):** https://labwired.com/pro.html **ships today**. Source of truth:

- `landing_page/astro/src/pages/pro.astro`
- `landing_page/astro/src/partials/pro.body.html` / `pro.head.html`
- Nav already includes Pro in `landing_page/astro/src/layouts/Layout.astro`
- Pricing tiers partial exists: `pricing-tiers.partial.html`
- Stripe Get Pro CTA is live on the Pro page

**labwired-landing-deck** is a separate/legacy deck — **do not implement Pro there** for this work. Funnel edits go in **`w1ne/labwired` → `landing_page/`**.

### 4.1 What’s already on Pro (do not rebuild)

Live narrative (Write → Run → Rewind):

- Hero: “The easiest way to write firmware” + Get Pro (Stripe) + Open Playground
- Loop cards: agent/BYO harness for Zephyr write; sim run without a desk board; reverse-step
- Feature list already mentions **“Agent harness — built in, or bring your own Claude or Codex”** with **Coming soon**
- FAQ already covers BYO agent, no hardware required, cloud vs Enterprise

### 4.2 What we change on Pro (enhance only)

| Change | Detail |
|--------|--------|
| **Promote harness from “Coming soon”** | When `LabWired/agent` packaging is ready: ship OSS install path; remove or narrow “Coming soon” for the **open harness kit** (Pro cloud integrations can stay phased) |
| **Firmware Agent callout** | Explicit block: open-source kit at `https://github.com/LabWired/agent` + install one-liner matching agent README |
| **Honesty** | Keep “OpenCode-based / opencode-based harness” language; claim gate story optional one-liner (oracle disposes) |
| **Secondary CTA** | e.g. “Get the open Firmware Agent →” alongside Get Pro / Playground (does not replace paid CTA) |
| **FAQ** | Point BYO + turnkey answers at the GitHub kit when live |

Do **not** rewrite hero positioning wholesale unless product asks — Pro page is working. We **link the kit into the existing story**.

### 4.3 Homepage dual-path

Edit monorepo `landing_page/astro/src/partials/index.body.html` (current home is agent-prompt / projects style — not the landing-deck `#agent-harness` block):

- Add a clear path to **turnkey Firmware Agent** (`LabWired/agent`) and keep / reinforce **BYO MCP** / Playground
- Link Pro (`/pro.html`) where the paid workbench story fits
- Prefer additive section or CTA strip over full homepage redesign

### 4.4 Content / design tests

Extend monorepo landing tests (e.g. `landing_page/tests/…`):

- `github.com/LabWired/agent` (or install path) present where we claim the open agent
- Pro still has Get Pro + no vaporware regressions
- Harness “Coming soon” consistent with ship state

---

## 5. Claim honesty (non-negotiable)

Across agent README, skills, Pro page, homepage:

- **model-verified** only when oracle `status === model_verified`
- Do not market hardware-confirmed from this harness
- Time-travel / Zephyr IDE: label **shipped** vs **roadmap** per `product-tiers.md` reality — no vaporware
- OpenCode: “based on” / “harness over stock OpenCode”, never “our OpenCode”

---

## 6. Out of scope

- Forking or vendoring OpenCode source
- Monorepo MCP/builder implementation changes
- VS Code / Cline fork
- HIL hardware productization
- Enterprise Helm / SSO
- New monorepo package under `w1ne/labwired` for the agent (agent stays `LabWired/agent`)
- Replacing pilot pricing business model without product decision

---

## 7. Success criteria

1. `LabWired/agent` README reads as a Firmware Agent product page; install path works.
2. Six skills present, allowlisted, installed by `install.sh`, asserted in `tests/harness.sh`.
3. `labwired doctor` / `./demo.sh` / harness tests remain green (or fail only for missing sim, as today).
4. Live `/pro.html` links the open Firmware Agent kit; harness “Coming soon” updated to match ship state.
5. Homepage offers turnkey agent + existing Playground/MCP paths without a full redesign.
6. No conflicting price claims; Stripe Get Pro stays the paid CTA.
7. Spec-aligned wording with `positioning.md` propose/dispose story.

---

## 8. Implementation order (for the plan)

1. **Agent kit packaging** — branding, README, AGENTS, three skills, opencode permissions, harness tests.
2. **Pro page enhance** — agent callout + CTAs + FAQ/feature “Coming soon” truth in monorepo `landing_page/`.
3. **Homepage dual-path** — additive CTAs/section for the open agent kit.
4. **Cross-link polish** — agent README ↔ pro/home; llms if needed.
5. **Verify** — agent `tests/harness.sh`; monorepo landing tests; optional install smoke.

Suggested PR split: (1) `LabWired/agent`, (2) monorepo `landing_page/` — independent deploys.

---

## 9. Open decisions resolved in this design

| Question | Decision |
|----------|----------|
| Scope | Agent kit + enhance live Pro + homepage (Approach A) |
| Skills | Trio + board-bringup, scaffold-firmware, report-evidence |
| Funnel | **Existing** https://labwired.com/pro.html + agent on main |
| OpenCode | Keep harness; no fork |
| Landing source | monorepo `landing_page/` (not labwired-landing-deck) |
| Pricing on Pro page | Already live Stripe + tiers partial — do not invent parallel pricing |

---

## 10. Spec self-review

- No TBD placeholders left for implementers except explicit “label roadmap vs shipped” at content time.
- Free agent kit vs Pro narrative is consistent with `positioning.md`.
- Scope is two-repo, not platform monorepo rewrite.
- Skill names fixed to avoid reintroducing `firmware-verification` duplicate.
