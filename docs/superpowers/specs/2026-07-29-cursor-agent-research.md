# Research: How Cursor runs agents — and what LabWired should copy

**Date:** 2026-07-29  
**Purpose:** Competitive / design research for LabWired’s *verified firmware-engineering agent* (v0).  
**Sources:** Cursor public docs (`cursor.com/docs/*`, skills, rules, subagents, hooks, run modes, search, MCP, CLI).  
**Not a claim of internal Cursor IP** — product surface only.

---

## One-line takeaway

Cursor does **not** sell “a smarter base model.” It sells a **host loop**: instructions (rules + skills) + **structured tools** + **context control** (search/subagents) + **execution policy** (sandbox / auto-review / hooks) + optional **verification patterns** (verifier subagent, browser, tests via shell).

That is almost the same stack LabWired wants — except LabWired’s **dispose** layer is a **deterministic firmware oracle**, which Cursor does not have.

| Layer | Cursor | LabWired v0 |
|-------|--------|-------------|
| Brain | Frontier models (BYO pick) | Same — rent Claude/Codex/Ollama |
| Instructions | Rules + AGENTS.md + Skills | `config/AGENTS.md` + `skills/*` |
| Tools | Edit/search/shell/browser + MCP | LabWired MCP + shell helpers + probe/PIO |
| Context | Instant Grep + Explore subagent + progressive skills | Version-aware Zephyr RAG (later); board catalog today |
| Policy | Run modes, sandbox, hooks | Claim gate + tool allowlist + max repairs |
| Verify | Tests/browser/human + optional verifier subagent | **`labwired_verify` oracle** + optional physical promote (any probe/board) |
| Moat | IDE + indexing + sandbox + agent UX | **Deterministic twin + evidence** |

---

## 1. Cursor’s agent anatomy

From [Agent overview](https://cursor.com/docs/agent/overview):

An agent = three components:

1. **Instructions** — system prompt + [rules](https://cursor.com/docs/rules)  
2. **Tools** — file edit, codebase search, terminal, browser, …  
3. **Model** — user-selected; Cursor **tunes instructions/tools per model**

There is **no hard cap** on tool calls per task. Checkpoints snapshot files before big edits (local undo, not Git).

**LabWired implication:** Keep selling the *loop*, not the weights. Document “BYO model + our skills/MCP/oracle” the way Cursor documents “pick any model + our tools.”

---

## 2. Instructions stack (rules → skills)

### 2.1 Rules

Cursor layers:

| Type | Where | Role |
|------|-------|------|
| Project rules | `.cursor/rules/*.mdc` | Versioned, globs / always / intelligent / manual |
| User rules | app settings | Global style prefs |
| Team rules | dashboard | Org policy; **Team → Project → User** precedence |
| AGENTS.md | repo root + nested dirs | Simple always-on markdown; nested dirs combine |

Best practices they publish: keep rules **&lt;500 lines**, split composable rules, **point at files** instead of pasting style guides, add rules only when the agent **repeats a mistake**.

### 2.2 Skills (open standard)

From [Agent Skills](https://cursor.com/docs/skills):

- Portable `SKILL.md` packages (scripts / references / assets)
- Discovery from `.agents/skills/`, `.cursor/skills/`, user dirs, **plus** `.claude/skills/` and `.codex/skills/` for compatibility
- Progressive loading: short skill body; pull `references/` on demand
- Frontmatter: `name`, `description` (routing), optional `paths` globs, `disable-model-invocation` (slash-only)
- Nested monorepo skills auto-scoped by package path
- Built-ins: `/babysit`, `/review`, `/create-skill`, `/loop`, etc.

**Skills vs subagents (Cursor’s own table):**

- **Skill** — single-purpose, repeatable, no separate context  
- **Subagent** — long research, parallel workstreams, independent verification

### 2.3 LabWired mapping

| Cursor | LabWired today / v0 |
|--------|---------------------|
| AGENTS.md | `config/AGENTS.md` claim gate |
| Skills | `skills/*/SKILL.md` (OpenCode-compatible) |
| `paths` scoped skills | Use `paths` / board globs later (`**/zephyr/**`, `**/*.overlay`) |
| Progressive refs | Keep SKILL.md short; put oracle clause examples in `references/` |
| Claude/Codex skill dirs | Mirror install into those paths for multi-harness customers |

---

## 3. Tools and search (context is the product)

### 3.1 Core tools

- Search files / keywords  
- Web search  
- Fetch rules  
- Read files (incl. images)  
- Edit files  
- Shell (profile-aware)  
- Browser (MCP-backed; screenshots / interaction)  
- Image generation  
- **Ask questions** (async; agent keeps working)

### 3.2 Search architecture

From [Search](https://cursor.com/docs/agent/tools/search):

1. **Instant Grep** — custom engine, exact/regex first (faster than naive ripgrep on large trees)  
2. **Semantic index** — embeddings; paths obfuscated, chunks encrypted at rest story  
3. **Explore subagent** — parallel multi-search on a **faster model**, returns **summary only** so main context doesn’t bloat  

**LabWired mapping (firmware RAG, phase after v0):**

| Cursor pattern | Firmware equivalent |
|----------------|---------------------|
| Instant Grep | `rg` / BM25 over customer repo + Zephyr tree |
| Symbol-aware search | C symbols, Kconfig, DT compat strings |
| Explore subagent | “repo-explore” worker: board hierarchy + `prj.conf` deps |
| Don’t dump raw trees into main chat | Retrieve → filter by **exact Zephyr version** → short pack |

Cursor proves **selective retrieval + isolation** beats stuffing the context window. Same lesson as Repoformer-style research in our model plan.

---

## 4. Execution policy (how they stay safe enough to auto-run)

### 4.1 Run modes

From [Run Modes](https://cursor.com/docs/agent/security/run-modes) (as of docs ~2026):

| Mode | Behavior |
|------|----------|
| **Auto-review** (recommended default) | Allowlist auto; sandbox shell when possible; classifier on the rest |
| **Allowlist** | Deterministic trusted set |
| **Run Everything** | No prompts (high risk) |

Sandbox (macOS Seatbelt / Linux Landlock): workspace RW, network default-deny + package-manager allowlists, protected paths (`.git/hooks`, etc.).

`permissions.json` = natural-language allow/block instructions.  
`sandbox.json` = network/path policy.  
Team dashboard can override both.

### 4.2 Hooks (hard gate on the loop)

From [Hooks](https://cursor.com/docs/agent/hooks):

JSON stdio scripts on lifecycle events, e.g.:

- `beforeShellExecution` / `beforeMCPExecution` — allow | deny | ask  
- `afterFileEdit` — formatters  
- `postToolUse` — inject context / audit  
- `stop` / `subagentStop` — **follow-up loops** with `loop_limit`  
- `failClosed: true` for security-critical hooks  

Partners (Semgrep, Snyk, 1Password, …) use hooks as the **enterprise control plane**.

### 4.3 LabWired mapping

| Cursor | LabWired v0 |
|--------|-------------|
| Auto-review classifier | **Do not** use an LLM to score firmware correctness |
| Sandbox | Airgap config + no unrestricted shell in enterprise story |
| `beforeMCPExecution` | Gate: refuse `labwired_run` results as success claims |
| `stop` follow-up loop | `firmware-repair-loop` max **3** with hard abstain |
| `failClosed` | `labwired assert-status` — green only on exact status string |
| Semgrep-after-edit | Optional clang-tidy / static MCP later |

**Product language:** Cursor sells *safe autonomy*. LabWired sells *honest autonomy*: autonomy ends where the oracle has no evidence.

---

## 5. Subagents and the verifier pattern

From [Subagents](https://cursor.com/docs/subagents):

Built-ins: **Explore**, **Bash**, **Browser** — all exist to **isolate noisy context**.

Custom subagents in `.cursor/agents/*.md`:

- `name`, `description` (routing!), `model`, `readonly`, `is_background`  
- Documented **verifier** pattern: skeptical agent that **runs tests**, does not trust “done”  
- Orchestrator: planner → implementer → verifier  
- Parallel Task tool; resume by agent id  
- Cloud subagents: separate VM/branch (`/in-cloud`, `/babysit`)

**LabWired mapping:**

| Cursor subagent | LabWired analog |
|-----------------|-----------------|
| Explore | Symbol/version retrieval worker |
| Bash | Hosted compile / west / PIO (metered) |
| Browser | Playground iframe / studio URL (already in MCP contract) |
| **Verifier** | **`labwired_verify` is stronger** — not another LLM; deterministic oracle |
| Cloud agent | Enterprise on-prem runner / CI twin |

Do **not** implement “verifier” as a second model grading the first. Cursor uses that only because general code lacks a free oracle. We have one.

Optional: a **readonly** “inspect-evidence” skill/subagent that *explains* oracle output — never mints status.

---

## 6. MCP and multi-surface distribution

Cursor treats MCP as first-class:

- Editor + CLI + Cloud Agents  
- `mcp.json`, marketplace, OAuth  
- Auto-run MCP under same Run Mode rules  
- CLI: `agent mcp list` / `list-tools`

**LabWired already mirrors this:** `@labwired/mcp` + agent install + playground.  
v0 should keep **one tool surface** across OpenCode / Claude / Codex / Cursor customers (skill dir compatibility helps Cursor users install LabWired skills next to theirs).

---

## 7. What Cursor does *not* do (our wedge)

Cursor does **not**:

1. Provide a **register-accurate deterministic MCU twin**  
2. Mint **typed verification statuses** (`model_verified` / gaps / unsupported)  
3. Bind **the same binary** across browser, CI, and bench as a product promise  
4. Specialize default tools for Kconfig / devicetree / Twister  

Cursor *does* use terminal tests and browser checks as soft verifiers — same *shape* as our repair loop, weaker *signal* for firmware.

**Positioning line:**

> Cursor makes software agents productive. LabWired makes firmware agents *honest*.

---

## 8. Concrete copy-list for LabWired v0

Priority order (highest first):

1. **Claim gate = fail-closed hook**  
   Keep `assert-status` + AGENTS.md; treat soft language as a product bug.

2. **Skills as progressive packages**  
   Align with Agent Skills standard: short `SKILL.md`, optional `scripts/` (`serial-capture.sh`, `score-verify.sh`), `references/` for oracle recipes.

3. **Skill discovery multi-harness**  
   Install LabWired skills into `.cursor/skills/labwired/*` (and Claude/Codex paths) so Cursor users get the pack natively.

4. **Explore-style retrieval (next phase)**  
   Separate “search Zephyr tree / customer repo” worker; never dump full trees into the main agent.

5. **Repair loop with loop_limit**  
   Cursor’s `stop.loop_limit` default 5 → our **max 3** repairs + abstain (firmware cost/risk higher).

6. **Verifier is the oracle, not a subagent model**  
   Document Cursor’s verifier pattern as the *motivation*, LabWired verify as the *implementation*.

7. **Evidence report template**  
   Mirror Cursor “what passed / incomplete” verifier report, but with status matrix:
   `model_verified | build_ok | hardware_observed | failed | inconclusive | unsupported | abstain`

8. **Execution policy for HW**  
   Flash/serial never auto-upgrade to model_verified (Cursor’s separation of sandbox vs full system access is the UX analogy).  
   **Physical boards are validation canaries for tooling**, not the product focus. Product path = skills + oracle + evidence for FW engineers (Zephyr/Pro multi-file, any catalog board).

9. **Trajectory capture**  
   Cursor has `cursor-blame` / transcripts; we should log tool+oracle trajectories for later QLoRA (Cursor doesn’t need this for firmware domain).

10. **Don’t build Cursor**  
    No Instant Grep reimplementation, no Seatbelt, no IDE. Integrate *as* MCP+skills *inside* Cursor/OpenCode.

---

## 9. Example: Cursor-style skill layout for LabWired

```text
skills/
  firmware-repair-loop/
    SKILL.md                 # short routing + hard rules
    scripts/
      score-verify.sh
    references/
      claim-vocabulary.md
      oracle-examples.md
  hw-promote/
    SKILL.md                 # board-agnostic: probe-rs / esptool / serial oracle
    scripts/
      serial-capture.sh
    references/
      promote-status-matrix.md
```

Frontmatter fields to add over time (Cursor-compatible):

```yaml
---
name: firmware-repair-loop
description: >-
  Propose patches and re-verify with labwired_verify until model_verified
  or abstain. Use when firmware fails build, tests, or oracle clauses.
# paths: "**/src/**, **/prj.conf, **/*.overlay"   # later
metadata:
  labwired: "true"
  gate: "oracle"
---
```

---

## 10. Demo narrative (sales)

| Step | Cursor-like UX | LabWired substance |
|------|----------------|--------------------|
| 1 | User: “fix the UART init” | Agent skill routes to repair loop |
| 2 | Search + edit | Same |
| 3 | Run tests | `west build` / PIO / hosted compile |
| 4 | “Looks good” ❌ | **`labwired_verify` → status** |
| 5 | Optional browser check | Optional physical promote → `hardware_observed` (board is incidental) |
| 6 | PR summary | Evidence matrix + known limits |

Generic coding agents stop at step 3–4 with prose. We stop only at **typed evidence**.

---

## 11. Open questions (product)

1. Ship a **Cursor-native** install (`npx` / marketplace entry) vs OpenCode-first only?  
2. Expose a **readonly verifier subagent** markdown for `.cursor/agents/labwired-verifier.md` that only calls MCP inspect/verify?  
3. Should enterprise offer **hooks** that block any chat message claiming “works on hardware” without a status field? (Cursor-style `beforeSubmitPrompt` analog — may be harness-specific.)

---

## 12. References

- https://cursor.com/docs/agent/overview  
- https://cursor.com/docs/skills  
- https://cursor.com/docs/rules  
- https://cursor.com/docs/subagents  
- https://cursor.com/docs/agent/hooks  
- https://cursor.com/docs/agent/security/run-modes  
- https://cursor.com/docs/agent/tools/search  
- https://cursor.com/docs/agent/tools/browser  
- https://cursor.com/docs/agent/tools/terminal  
- https://cursor.com/docs/mcp  
- https://cursor.com/docs/cli/using  
- https://cursor.com/docs/cloud-agent  
- https://agentskills.io (Agent Skills standard)

---

## 13. Bottom line for v0 workflow

Steal Cursor’s **packaging and control plane**:

- skills + AGENTS.md + progressive context + max-iteration loops + multi-harness discovery  

Do **not** steal Cursor’s **definition of done** (LLM/tests/browser alone).

LabWired’s definition of done remains:

```text
model_verified  ⇔  labwired_verify.status == model_verified
hardware_observed  ⇔  flash + serial/GPIO oracle on real silicon
```

Everything else is scaffolding so a cheaper model can still ship firmware engineers trustworthy results.
