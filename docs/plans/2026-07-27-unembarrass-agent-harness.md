# Un-embarrass LabWired Agent Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `LabWired/agent` a reliable, non-embarrassing OpenCode harness: one clear binary story, one skill set, an install that works offline-friendly, a hard claim gate that Markdown cannot fake, and a one-command demo that either model-verifies or fails loud.

**Architecture:** Stay a thin bash distribution over stock OpenCode (no monorepo package, no OpenCode fork). Fix PATH/naming so the agent launcher never shadows the simulator. Resolve the MCP server to a real filesystem entry (vendored or `LABWIRED_MCP_ENTRY`) instead of bare `npx -y` on the air-gap path. Collapse duplicate skills. Add a tiny pure claim-gate script plus shell tests. Add `./demo.sh` that proves doctor + skill layout + (optional) live verify.

**Tech Stack:** Bash, stock OpenCode (`opencode-ai` pin), `@labwired/mcp` (path or npm), shell tests (`bash` + `shunit` style or simple `assert` functions — no Node monorepo dependency required).

**Repo:** `https://github.com/LabWired/agent` only. Do **not** put this in `w1ne/labwired`.

**Out of scope:** Hardware gateway, Enterprise Helm, Studio, monorepo MCP implementation changes (except documenting which env vars the platform MCP already honors).

---

## Problems this plan fixes (from the roast)

| # | Embarrassment | Fix |
|---|---|---|
| 1 | Agent named `labwired` defaults sim to fictional `labwired-cli` | Smart sim resolution + docs; never invent a binary name |
| 2 | Skills don’t enforce claims; model can soft-pass | `labwired assert-status` hard gate + AGENTS.md must use it |
| 3 | Demo is a scavenger hunt | `./demo.sh` green path, exit non-zero on fail |
| 4 | Airgap still uses `npx -y` | MCP command = absolute path when `LABWIRED_MCP_ENTRY` or vendored copy present |
| 5 | Duplicate skills (`verify-firmware` + `firmware-verification`) | Keep three: verify / diagnose / inspect; remove the fourth |
| 6 | No automated checks on the harness itself | `tests/harness.sh` run in CI |

---

## Target UX (after this plan)

```bash
git clone https://github.com/LabWired/agent && cd agent
./install.sh          # pin OpenCode, install launcher + config + skills
labwired doctor       # all ok, or exact install commands
./demo.sh             # structure + claim-gate tests; optional live verify if sim+MCP ready
labwired              # OpenCode
```

Inside the agent session:

- Only skills: `verify-firmware`, `diagnose-firmware`, `inspect-evidence`
- After any verify, agent runs (or is instructed to treat as mandatory) claim rules keyed off **status string**, and humans can run:

```bash
labwired assert-status model_verified < path/to/verify-result.json
# exit 0 only if status field is exactly model_verified
```

---

## File structure

Create:

- `lib/resolve-sim.sh` — pure functions: resolve simulator binary
- `lib/resolve-mcp.sh` — pure functions: MCP command argv as lines/json
- `lib/assert-status.sh` — pure: parse JSON status (python3 or node one-liner fallback)
- `bin/labwired` — rewrite to source libs; subcommands: doctor, version, help, assert-status, default→opencode
- `tests/harness.sh` — shell tests for resolve + assert-status + skill inventory
- `demo.sh` — one-command smoke
- `mcp/README.md` — how to vendor `@labwired/mcp` dist for airgap
- `.github/workflows/harness.yml` — run `tests/harness.sh` on push

Modify:

- `install.sh` — pin, install, write config with resolved MCP command, never default sim to missing name
- `config/opencode.json` — MCP command placeholder replaced at install time; skill permissions only three skills
- `config/opencode.airgap.json` — same; document `LABWIRED_MCP_ENTRY` required
- `config/AGENTS.md` — claim gate + assert-status; no dual skill names
- `skills/*` — delete `firmware-verification/`; tighten the three remaining
- `README.md` — binary story, demo.sh, airgap MCP path
- `fixtures/gate1/*` — keep; wire into demo.sh

---

### Task 1: Simulator resolution (kill the fictional binary)

**Files:**
- Create: `lib/resolve-sim.sh`
- Create: `tests/harness.sh` (first cases)
- Modify: `bin/labwired` (source the lib; doctor uses it)

- [ ] **Step 1: Write `lib/resolve-sim.sh`**

```bash
#!/usr/bin/env bash
# resolve-sim.sh — resolve LabWired *simulator* binary (not the agent launcher).
# shellcheck shell=bash

# Returns 0 and prints absolute path, or 1 and prints nothing.
# Rules (first match wins):
# 1) $LABWIRED_CLI if set and executable (file or on PATH)
# 2) $LABWIRED_SIM if set and executable
# 3) command -v labwired that is NOT this agent launcher (argv0 realpath)
# 4) common names on PATH: labwired-sim, labwired-cli (only if they exist)
#
# Never invent a default name that is not found.

labwired_agent_self_path() {
  local src
  src="${BASH_SOURCE[1]:-${BASH_SOURCE[0]}}"
  # caller should pass launcher path as $1 when available
  if [[ -n "${1:-}" ]]; then
    (cd "$(dirname "$1")" && pwd -P)/$(basename "$1")
    return 0
  fi
  echo ""
}

labwired_resolve_sim() {
  local agent_path="${1:-}"
  local candidate real_agent real_cand

  real_agent=""
  if [[ -n "$agent_path" && -e "$agent_path" ]]; then
    real_agent="$(cd "$(dirname "$agent_path")" && pwd -P)/$(basename "$agent_path")"
  fi

  try_one() {
    local c="$1"
    [[ -z "$c" ]] && return 1
    if [[ -x "$c" ]]; then
      echo "$c"
      return 0
    fi
    if command -v "$c" >/dev/null 2>&1; then
      local p
      p="$(command -v "$c")"
      if [[ -n "$real_agent" ]]; then
        local rp
        rp="$(cd "$(dirname "$p")" && pwd -P)/$(basename "$p")"
        if [[ "$rp" == "$real_agent" ]]; then
          return 1
        fi
      fi
      echo "$p"
      return 0
    fi
    return 1
  }

  if [[ -n "${LABWIRED_CLI:-}" ]] && try_one "$LABWIRED_CLI"; then return 0; fi
  if [[ -n "${LABWIRED_SIM:-}" ]] && try_one "$LABWIRED_SIM"; then return 0; fi
  if try_one labwired; then return 0; fi
  if try_one labwired-sim; then return 0; fi
  if try_one labwired-cli; then return 0; fi
  return 1
}
```

- [ ] **Step 2: Write failing tests in `tests/harness.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=lib/resolve-sim.sh
source "$ROOT/lib/resolve-sim.sh"

fail=0
assert_eq() {
  local name="$1" got="$2" want="$3"
  if [[ "$got" != "$want" ]]; then
    echo "FAIL $name: got='$got' want='$want'"
    fail=1
  else
    echo "ok   $name"
  fi
}

# Isolated PATH fixture
FIX="$(mktemp -d)"
trap 'rm -rf "$FIX"' EXIT
mkdir -p "$FIX/bin"
# fake agent launcher
cat >"$FIX/bin/labwired" <<'EOS'
#!/bin/sh
echo agent
EOS
chmod +x "$FIX/bin/labwired"
# fake simulator with different name
cat >"$FIX/bin/labwired-sim" <<'EOS'
#!/bin/sh
echo sim
EOS
chmod +x "$FIX/bin/labwired-sim"

# When LABWIRED_CLI points at sim, use it
got="$(PATH="$FIX/bin" LABWIRED_CLI="$FIX/bin/labwired-sim" labwired_resolve_sim "$FIX/bin/labwired" || true)"
assert_eq "explicit LABWIRED_CLI" "$got" "$FIX/bin/labwired-sim"

# When only agent is named labwired, do not pick agent as sim
got="$(PATH="$FIX/bin" env -u LABWIRED_CLI -u LABWIRED_SIM labwired_resolve_sim "$FIX/bin/labwired" || true)"
# Prefer labwired-sim when present
assert_eq "prefer labwired-sim over agent labwired" "$got" "$FIX/bin/labwired-sim"

# Empty when nothing usable
got="$(PATH="/usr/bin:/bin" env -u LABWIRED_CLI -u LABWIRED_SIM labwired_resolve_sim "$FIX/bin/labwired" || true)"
# may still find real system labwired; only assert pure failure if none:
if ! command -v labwired >/dev/null 2>&1 && ! command -v labwired-sim >/dev/null 2>&1; then
  assert_eq "none found" "$got" ""
fi

if [[ "$fail" -ne 0 ]]; then exit 1; fi
echo "resolve-sim tests passed"
```

- [ ] **Step 3: Run tests — expect FAIL** (lib missing or functions wrong)

```bash
cd /path/to/LabWired/agent
bash tests/harness.sh
```

- [ ] **Step 4: Wire `bin/labwired` doctor** to use `labwired_resolve_sim "$(command -v labwired 2>/dev/null || true)"` and print the resolved path. **Remove** default `export LABWIRED_CLI=labwired-cli`. Instead:

```bash
# After resolve:
if sim="$(labwired_resolve_sim "$0")"; then
  export LABWIRED_CLI="$sim"
else
  unset LABWIRED_CLI  # doctor fails; launch warns
fi
```

When launching OpenCode, export resolved `LABWIRED_CLI` so MCP child inherits a real path.

- [ ] **Step 5: Re-run tests**

```bash
bash tests/harness.sh
```

Expected: PASS for resolve-sim cases.

- [ ] **Step 6: Commit**

```bash
git add lib/resolve-sim.sh tests/harness.sh bin/labwired
git commit -m "fix(agent): resolve simulator without fictional labwired-cli default"
```

---

### Task 2: MCP resolution (kill naked `npx -y` on airgap)

**Files:**
- Create: `lib/resolve-mcp.sh`
- Create: `mcp/README.md`
- Modify: `install.sh` to rewrite `config/opencode.json` MCP command at install time
- Modify: `config/opencode.json`, `config/opencode.airgap.json` templates
- Extend: `tests/harness.sh`

- [ ] **Step 1: Implement `lib/resolve-mcp.sh`**

```bash
#!/usr/bin/env bash
# Prints JSON array of command strings for OpenCode local MCP, e.g.
# ["node","/abs/path/index.js"] or ["npx","-y","@labwired/mcp"]
# Priority:
# 1) $LABWIRED_MCP_ENTRY if file exists → ["node", abs path]
# 2) $AGENT_ROOT/mcp/vendor/index.js if exists → ["node", abs]
# 3) fallback online: ["npx","-y","@labwired/mcp"]  # install.sh default only; airgap install must fail if 1+2 missing

labwired_resolve_mcp_command_json() {
  local root="${1:-.}"
  local entry=""
  if [[ -n "${LABWIRED_MCP_ENTRY:-}" && -f "${LABWIRED_MCP_ENTRY}" ]]; then
    entry="$(cd "$(dirname "$LABWIRED_MCP_ENTRY")" && pwd -P)/$(basename "$LABWIRED_MCP_ENTRY")"
    printf '["node","%s"]\n' "$entry"
    return 0
  fi
  if [[ -f "$root/mcp/vendor/index.js" ]]; then
    entry="$(cd "$root/mcp/vendor" && pwd -P)/index.js"
    printf '["node","%s"]\n' "$entry"
    return 0
  fi
  if [[ "${LABWIRED_MCP_ALLOW_NPX:-}" == "1" || "${LABWIRED_MCP_ALLOW_NPX:-}" == "true" ]]; then
    printf '["npx","-y","@labwired/mcp"]\n'
    return 0
  fi
  # Default for normal install: allow npx (dev/online). Airgap profile sets ALLOW_NPX=0.
  if [[ "${LABWIRED_PROFILE:-online}" == "airgap" ]]; then
    return 1
  fi
  printf '["npx","-y","@labwired/mcp"]\n'
  return 0
}
```

- [ ] **Step 2: Tests**

Add to `tests/harness.sh`:

```bash
source "$ROOT/lib/resolve-mcp.sh"
# vendor path
mkdir -p "$FIX/mcp/vendor"
echo 'console.log(1)' >"$FIX/mcp/vendor/index.js"
got="$(LABWIRED_PROFILE=airgap env -u LABWIRED_MCP_ENTRY labwired_resolve_mcp_command_json "$FIX")"
echo "$got" | grep -q "node" && echo "ok mcp vendor" || { echo FAIL mcp vendor; fail=1; }

# airgap without vendor fails
rm -rf "$FIX/mcp"
if LABWIRED_PROFILE=airgap env -u LABWIRED_MCP_ENTRY labwired_resolve_mcp_command_json "$FIX" 2>/dev/null; then
  echo "FAIL airgap should fail without vendor"; fail=1
else
  echo "ok   airgap refuses npx"
fi
```

- [ ] **Step 3: `install.sh` writes config**

After copying templates, generate final MCP command:

```bash
# shellcheck source=lib/resolve-mcp.sh
source "$SRC/lib/resolve-mcp.sh"
PROFILE=online
# if user passed --airgap:
# PROFILE=airgap
export LABWIRED_PROFILE="$PROFILE"
MCP_JSON="$(labwired_resolve_mcp_command_json "$SRC")" || {
  echo "airgap install requires LABWIRED_MCP_ENTRY or mcp/vendor/index.js — see mcp/README.md" >&2
  exit 1
}
# Use python3 or node to splice MCP_JSON into opencode.json command field
python3 - <<PY
import json, pathlib, os
cfg_path = pathlib.Path(os.environ["CFG_DIR"]) / "opencode.json"
cfg = json.loads(cfg_path.read_text())
cfg["mcp"]["labwired"]["command"] = json.loads(os.environ["MCP_JSON"])
# Also pin environment LABWIRED_CLI to resolved sim if available
cfg_path.write_text(json.dumps(cfg, indent=2) + "\n")
PY
```

Pass `MCP_JSON` and `CFG_DIR` in the environment.

- [ ] **Step 4: `mcp/README.md`**

Document:

```bash
# From a machine with network:
npm pack @labwired/mcp
# extract dist/index.js into agent/mcp/vendor/
# or: export LABWIRED_MCP_ENTRY=/path/to/node_modules/@labwired/mcp/dist/index.js
./install.sh --airgap
```

- [ ] **Step 5: Commit**

```bash
git add lib/resolve-mcp.sh mcp/README.md install.sh config/opencode.json config/opencode.airgap.json tests/harness.sh
git commit -m "fix(agent): resolve MCP entry for airgap without naked npx"
```

---

### Task 3: Collapse skills to three + honest claim docs

**Files:**
- Delete: `skills/firmware-verification/` (entire directory)
- Modify: `skills/verify-firmware/SKILL.md`, `diagnose-firmware`, `inspect-evidence`
- Modify: `config/opencode.json` permission.skill (only three)
- Modify: `config/AGENTS.md`
- Modify: `bin/labwired` doctor skill list
- Extend tests: assert exactly three skill dirs

- [ ] **Step 1: Failing inventory test**

```bash
# In tests/harness.sh
mapfile -t skills < <(find "$ROOT/skills" -mindepth 1 -maxdepth 1 -type d -exec basename {} \; | sort)
want=$'diagnose-firmware\ninspect-evidence\nverify-firmware'
got=$(printf '%s\n' "${skills[@]}")
assert_eq "skill inventory" "$got" "$want"
# must not exist:
[[ ! -d "$ROOT/skills/firmware-verification" ]] || { echo FAIL duplicate skill; fail=1; }
```

- [ ] **Step 2: Delete duplicate skill; ensure remaining three frontmatter `name` matches folder**

- [ ] **Step 3: AGENTS.md mandatory language**

Add:

```md
## Claim gate (non-negotiable)

After every `labwired_verify` tool result:

1. Read `status` (not only `proven`).
2. You may say the firmware is model-verified **only** if `status` is exactly `model_verified`.
3. Otherwise report failed / inconclusive / unsupported with `gaps`.
4. For human or CI checks of a saved payload:
   `labwired assert-status model_verified < verify.json`

Never claim hardware-confirmed from this harness.
```

- [ ] **Step 4: Commit**

```bash
git add -A skills config bin/labwired tests/harness.sh
git commit -m "fix(agent): single skill set verify/diagnose/inspect"
```

---

### Task 4: Hard claim gate (`assert-status`)

**Files:**
- Create: `lib/assert-status.sh`
- Modify: `bin/labwired` — subcommand `assert-status <expected> [file|-]`
- Extend: `tests/harness.sh`

- [ ] **Step 1: Implement pure assert**

```bash
#!/usr/bin/env bash
# Usage: labwired_assert_status expected_status < json
# JSON may be full MCP tool payload or { "status": "..." } or nested content text.
labwired_assert_status() {
  local expected="$1"
  local raw
  raw="$(cat)"
  local got
  got="$(printf '%s' "$raw" | python3 -c '
import json,sys,re
raw=sys.stdin.read()
status=None
try:
    data=json.loads(raw)
except Exception:
    data=None
def find_status(obj):
    if isinstance(obj, dict):
        if "status" in obj and obj["status"] in (
            "model_verified","failed","inconclusive","unsupported"):
            return obj["status"]
        for v in obj.values():
            s=find_status(v)
            if s: return s
    elif isinstance(obj, list):
        for v in obj:
            s=find_status(v)
            if s: return s
    elif isinstance(obj, str):
        try:
            return find_status(json.loads(obj))
        except Exception:
            m=re.search(r"\"status\"\s*:\s*\"(model_verified|failed|inconclusive|unsupported)\"", obj)
            if m: return m.group(1)
    return None
if data is not None:
    status=find_status(data)
if not status:
    m=re.search(r"\"status\"\s*:\s*\"(model_verified|failed|inconclusive|unsupported)\"", raw)
    status=m.group(1) if m else None
if not status:
    sys.stderr.write("assert-status: no status field found\n")
    sys.exit(2)
print(status)
sys.exit(0 if status==sys.argv[1] else 1)
' "$expected")"
  local rc=$?
  if [[ $rc -eq 0 ]]; then
    echo "assert-status: ok ($got)"
    return 0
  fi
  echo "assert-status: expected $expected, got ${got:-unknown}" >&2
  return "$rc"
}
```

Simpler approach if python3 always available: keep as above. If not, document python3 dependency for assert-status only (doctor already needs modern unix).

- [ ] **Step 2: Tests**

```bash
source "$ROOT/lib/assert-status.sh"
echo '{"status":"model_verified","proven":true}' | labwired_assert_status model_verified
echo '{"status":"failed","proven":false}' | labwired_assert_status model_verified && { echo FAIL; fail=1; } || echo "ok reject failed"
echo '{"status":"unsupported"}' | labwired_assert_status unsupported
```

- [ ] **Step 3: Wire CLI**

```bash
assert-status)
  shift
  expected="${1:?usage: labwired assert-status <status> [file]}"
  shift || true
  file="${1:-/-}"
  # shellcheck source=lib/assert-status.sh
  source "$ROOT/lib/assert-status.sh"
  if [[ "$file" == "-" || -z "${1:-}" ]]; then
    labwired_assert_status "$expected"
  else
    labwired_assert_status "$expected" <"$file"
  fi
  ;;
```

Fix the file handling carefully: if second arg is a path, read it; else stdin.

- [ ] **Step 4: Commit**

```bash
git add lib/assert-status.sh bin/labwired tests/harness.sh skills config
git commit -m "feat(agent): hard assert-status claim gate"
```

---

### Task 5: `demo.sh` — one command, fail loud

**Files:**
- Create: `demo.sh`
- Modify: `fixtures/gate1/README.md` (point to demo.sh)
- Modify: `README.md` top install → demo path

- [ ] **Step 1: Write `demo.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

echo "==> harness unit tests"
bash tests/harness.sh

echo "==> skill + fixture shape"
test -f skills/verify-firmware/SKILL.md
test -f fixtures/gate1/oracle.json
grep -q LABWIRED_OK fixtures/gate1/fixed/main.c
! grep -q LABWIRED_OK fixtures/gate1/broken/main.c

echo "==> doctor (may warn if OpenCode/sim not installed)"
if bin/labwired doctor; then
  echo "doctor: clean"
else
  echo "doctor: incomplete environment (unit tests still passed)"
  echo "Install pin + sim, then re-run for full green."
  # Exit 0 for unit-level demo success; use DEMO_REQUIRE_DOCTOR=1 for strict
  if [[ "${DEMO_REQUIRE_DOCTOR:-0}" == "1" ]]; then
    exit 1
  fi
fi

echo "==> optional live verify"
if [[ "${DEMO_LIVE_VERIFY:-0}" == "1" ]]; then
  : "${DEMO_VERIFY_JSON:?set DEMO_VERIFY_JSON to a labwired_verify payload file}"
  bin/labwired assert-status model_verified "$DEMO_VERIFY_JSON"
fi

echo "demo.sh: OK"
```

- [ ] **Step 2: chmod +x; run**

```bash
chmod +x demo.sh
./demo.sh
```

Expected: unit tests pass; doctor may soft-fail unless machine fully installed.

- [ ] **Step 3: Commit**

```bash
git add demo.sh fixtures/gate1/README.md README.md
git commit -m "feat(agent): one-command demo.sh smoke path"
```

---

### Task 6: CI + install flag polish

**Files:**
- Create: `.github/workflows/harness.yml`
- Modify: `install.sh` — support `--airgap`, print resolved sim/MCP at end
- Modify: `README.md` — final binary story table

- [ ] **Step 1: Workflow**

```yaml
name: harness
on:
  push:
  pull_request:
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: harness tests
        run: bash tests/harness.sh
      - name: demo (unit)
        run: ./demo.sh
```

- [ ] **Step 2: README binary table**

| Binary / env | Meaning |
|---|---|
| `labwired` (this repo) | OpenCode **agent launcher** |
| `LABWIRED_CLI` / auto-resolved sim | **Simulator** the MCP calls |
| `LABWIRED_MCP_ENTRY` / `mcp/vendor` | MCP server entry (airgap) |
| `opencode` | Pinned OpenCode CLI |

- [ ] **Step 3: Full local verification**

```bash
bash tests/harness.sh
./demo.sh
./install.sh   # on a dev machine
labwired doctor
labwired version
labwired assert-status model_verified <<<'{"status":"model_verified"}'
```

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/harness.yml install.sh README.md
git commit -m "ci(agent): harness tests and install/airgap polish"
```

---

## Acceptance criteria

- [ ] No default `LABWIRED_CLI=labwired-cli` unless that path exists
- [ ] Agent launcher never selected as simulator when resolving sim
- [ ] Exactly three skills under `skills/`
- [ ] `labwired assert-status model_verified` exits 0/1 correctly on fixtures
- [ ] Airgap install fails closed without vendored MCP or `LABWIRED_MCP_ENTRY`
- [ ] Online install may still use `npx -y @labwired/mcp` explicitly as fallback
- [ ] `./demo.sh` exits 0 on unit checks without network
- [ ] `tests/harness.sh` green in GitHub Actions
- [ ] README states monorepo vs agent boundary in ≤10 lines

## Non-goals (still embarrassing later, not this PR)

- Forcing OpenCode runtime to intercept model text (needs plugin; optional follow-up)
- Auto-running live board verify in CI without sim binaries
- Merging `LabWired/skills` automation
- Changing platform monorepo tool schemas

## Implementation notes

1. Work only in `LabWired/agent` (branch off `main` or update open PR #1).
2. Prefer bash + python3 stdlib for JSON; avoid adding package.json to this repo unless tests demand it.
3. Keep OpenCode pin constant in one place: `lib/pin.sh` exporting `OPENCODE_PIN=1.18.7`, sourced by install + bin.
4. If PR #1 is still open, implement this plan as follow-up commits on the same branch or a new PR stacked after merge.

---

## Spec coverage (roast → task)

| Roast item | Task |
|---|---|
| Naming / fictional sim | Task 1 |
| npx airgap cosplay | Task 2 |
| Skill duplicates | Task 3 |
| Markdown-only enforcement | Task 4 |
| Scavenger-hunt demo | Task 5 |
| No CI on harness | Task 6 |
