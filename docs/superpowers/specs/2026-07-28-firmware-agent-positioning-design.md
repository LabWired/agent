# Design: LabWired Firmware Agent positioning

**Date:** 2026-07-28  
**Status:** Approved for planning  
**Repos:**

| Repo | Role |
|------|------|
| [LabWired/agent](https://github.com/LabWired/agent) (`Projects/labwired-agent`) | Open Firmware Agent kit (OpenCode harness + skills + branding) |
| [labwired-landing-deck](https://github.com/…) (`Projects/labwired-landing-deck`) | Marketing funnel: homepage dual-path + `/pro.html` |

**Related docs:**

- `docs/plans/2026-07-27-unembarrass-agent-harness.md` (harness mechanics — already shipped)
- monorepo `docs/positioning.md`, `docs/pro-page-spec.md`, `docs/product-tiers.md`

---

## 1. Goal

Position LabWired as open-source tooling and the **go-to place to get a Firmware Agent**:

1. **Agent kit** — stock OpenCode harness, LabWired-branded, with a clear install story and skill pack.
2. **Landing funnel** — Pro product narrative (`/pro.html`) plus dual path on the **main** homepage (turnkey agent + BYO MCP).

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

- `labwired version` / help: “LabWired Firmware Agent (OpenCode harness)”
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

## 4. Landing funnel

### 4.1 `/pro.html` (implement pro-page-spec, adapted)

Source of narrative: monorepo `docs/pro-page-spec.md`.

Implement in **labwired-landing-deck** (live site source), not only monorepo docs:

| File | Action |
|------|--------|
| `astro/src/pages/pro.astro` | New page |
| `astro/src/partials/pro.body.html` | Sections |
| `astro/src/partials/pro.head.html` | Scoped styles + meta |
| `astro/src/layouts/Layout.astro` | Nav link **Pro** between For CI and Pricing |
| `components/header.html` | Same nav for legacy HTML |
| Built `pro.html` | After Astro build (or mirror CI pattern) |
| `tests/content.test.js` | Assert Pro nav, hero promise, agent GitHub link, no vaporware red flags |

**Sections (top → bottom):**

1. Hero — ship firmware you can trust; CTAs: Get Pro / Open Playground / Get the Firmware Agent (OSS)
2. Develop → Test → Debug loop cards (oracle + time-travel honesty)
3. Why honest (three wedge bullets)
4. What’s in Pro (aligned with live pricing honesty)
5. Supported tech strip (only sim-verified claims)
6. Enterprise teaser
7. Pricing — **adapt**: landing-deck currently has pilot-style `pricing.html` (€4,999 pilot), **not** Starter/Pro $9/$39 partial. Do **not** invent a tiers partial with stale numbers. Prefer: link/embed current pricing truth + “Pro product story” language from `product-tiers.md` with clear “checkout coming soon” if still true, **or** pilot CTA if that remains the live paid path. Single source of truth: do not hardcode conflicting prices.
8. FAQ — BYO agent vs turnkey harness; sim first; on-prem = Enterprise

**Agent kit callout (required):**

- Explicit block: open-source **Firmware Agent** on GitHub (`https://github.com/LabWired/agent`)
- Install one-liner matching agent README
- Wording: “opencode-based agent harness” / “OpenCode-based” — not “we built OpenCode”

### 4.2 Homepage dual-path (`#agent-harness`)

Edit `astro/src/partials/index.body.html` (and rebuild static `index.html`):

- Section kicker can stay “For coding agents”
- H2/sub: include **turnkey Firmware Agent** alongside MCP
- **Path A — Turnkey agent:** clone + `./install.sh` + link to repo + optional `/pro.html`
- **Path B — BYO MCP:** keep hosted Codex/Claude commands + local `npx -y @labwired/mcp`
- Hero primary CTA: either “Get the Firmware Agent →” (anchor to dual-path) or dual CTAs (agent + Playground) — prefer dual so Playground is not demoted

### 4.3 Nav / GitHub

- Nav: add **Pro**
- Consider secondary GitHub link to `LabWired/agent` on Pro and agent-harness only (homepage trust strip may keep core stars; Pro/agent sections link agent kit)

### 4.4 Content tests

Extend `tests/content.test.js`:

- Pro page exists and is linked from chrome
- Agent install string or `github.com/LabWired/agent` on homepage agent section
- No claim that AI self-grades as verified

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
4. `/pro.html` ships in landing-deck with nav; tells Pro loop + OSS agent kit.
5. Homepage `#agent-harness` offers turnkey agent + BYO MCP.
6. No conflicting price claims between Pro page and live pricing.
7. Spec-aligned wording with `positioning.md` propose/dispose story.

---

## 8. Implementation order (for the plan)

1. **Agent kit packaging** — branding, README, AGENTS, three skills, opencode permissions, harness tests.
2. **Landing Pro page** — partials + nav + content tests.
3. **Homepage dual-path** — agent-harness section + content tests.
4. **Cross-link polish** — llms.txt / agent README ↔ pro/home consistency.
5. **Verify** — harness.sh, landing content tests, manual install smoke if environment allows.

Suggested PR split: (1) agent repo, (2) landing-deck — so each deploys independently.

---

## 9. Open decisions resolved in this design

| Question | Decision |
|----------|----------|
| Scope | Agent kit + Pro page + homepage (Approach A) |
| Skills | Trio + board-bringup, scaffold-firmware, report-evidence |
| Funnel | Pro page + agent on main |
| OpenCode | Keep harness; no fork |
| Pricing on Pro page | Do not invent tiers partial; align with live landing pricing truth |

---

## 10. Spec self-review

- No TBD placeholders left for implementers except explicit “label roadmap vs shipped” at content time.
- Free agent kit vs Pro narrative is consistent with `positioning.md`.
- Scope is two-repo, not platform monorepo rewrite.
- Skill names fixed to avoid reintroducing `firmware-verification` duplicate.
