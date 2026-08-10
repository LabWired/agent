# Public LabWired Agent Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship an optional LabWired Agent that installs with one command, starts with `labwired agent`, and does not replace or damage LabWired Core.

**Architecture:** Split the current agent launcher from a small product dispatcher. The dispatcher owns the public `labwired` command and routes to explicit component paths. The agent installer installs only the agent and shared dispatcher, records any existing Core binary before replacing a same-path command, and preserves all non-agent data.

**Tech Stack:** Bash, PowerShell 5.1, Node.js 18+, OpenCode, JSON configuration, GitHub Actions

---

## File map

Create these focused files:

- `bin/labwired-agent`: Unix agent launcher. This is the current agent command logic.
- `lib/dispatch.sh`: Unix component discovery and command routing helpers.
- `tests/dispatcher.sh`: Unix dispatcher and legacy Core compatibility tests.
- `tests/agent-lifecycle.sh`: Unix install, update, and removal isolation tests.
- `docs/INSTALL.md`: Public install, update, removal, and troubleshooting guide.
- `docs/USAGE.md`: Public agent task examples.
- `docs/VERIFY.md`: Public explanation of twin results.
- `docs/DEVELOPMENT.md`: Contributor test commands.
- `scripts/check-public-package.sh`: Public file, secret, private-path, and document checks.

Modify these files:

- `bin/labwired`: Replace agent logic with the Unix product dispatcher.
- `bin/labwired.ps1`: Make the Windows launcher a product dispatcher.
- `bin/labwired.cmd`: Keep the Windows command shim pointed at the PowerShell dispatcher.
- `install.sh`: Install the agent without installing Core or Editor.
- `scripts/public/install`: Use the agent-only install path and safe staging.
- `scripts/public/install.ps1`: Publish the agent-specific Windows entry point.
- `scripts/install.ps1`: Install only the Windows agent and dispatcher by default.
- `scripts/npm-install.js`: Make npm use the agent-only mode.
- `lib/prefix.sh`: Add component paths, Core registration, and dispatcher generation.
- `lib/resolve-sim.sh`: Resolve registered Core before PATH fallbacks.
- `lib/update.sh`: Update only the agent by default.
- `package.json`: Align the version and public package allowlist.
- `README.md`: Replace internal product language with the public start path.
- `CHANGELOG.md`: Add the public release entry.
- `config/AGENTS.md`: Apply the simple technical English rule to agent responses.
- `docs/TESTING.md`: Replace stale test counts and group the release lanes.
- `scripts/public/DEPLOY.md`: Document `/install/agent` deployment.
- `tests/all.sh`: Add the new deterministic gates.
- `tests/harness.sh`: Update agent launcher paths in existing checks.
- `tests/public-install.sh`: Check the new URL, component scope, and public wording.
- `tests/prefix-unit.sh`: Check registered Core resolution.
- `tests/install-smoke.sh`: Check `labwired agent` and Core coexistence.
- `.github/workflows/harness.yml`: Run the new deterministic and package checks.

Do not move Core or Editor source into this repository. The shared command only stores a stable path to an existing Core binary.

### Task 1: Lock the public contract with failing tests

**Files:**
- Create: `tests/dispatcher.sh`
- Modify: `tests/all.sh`
- Modify: `package.json`

- [ ] **Step 1: Add a dispatcher contract test**

Create `tests/dispatcher.sh` with isolated fake components:

```bash
#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

export LABWIRED_HOME="$TMP/home"
export LABWIRED_BIN_DIR="$TMP/user-bin"
mkdir -p "$LABWIRED_HOME/components/core/bin" "$LABWIRED_HOME/agent/bin"

cat >"$LABWIRED_HOME/components/core/bin/labwired" <<'SH'
#!/usr/bin/env bash
printf 'core:%s\n' "$*"
SH
chmod +x "$LABWIRED_HOME/components/core/bin/labwired"

cat >"$LABWIRED_HOME/agent/bin/labwired-agent" <<'SH'
#!/usr/bin/env bash
printf 'agent:%s\n' "$*"
SH
chmod +x "$LABWIRED_HOME/agent/bin/labwired-agent"

export LABWIRED_CORE_BIN="$LABWIRED_HOME/components/core/bin/labwired"
export LABWIRED_AGENT_BIN="$LABWIRED_HOME/agent/bin/labwired-agent"

help="$(bash "$ROOT/bin/labwired")"
grep -q 'labwired agent' <<<"$help"
grep -q 'labwired core' <<<"$help"
grep -q 'labwired editor' <<<"$help"

[[ "$(bash "$ROOT/bin/labwired" agent doctor)" == 'agent:doctor' ]]
[[ "$(bash "$ROOT/bin/labwired" core test board.yml)" == 'core:test board.yml' ]]
[[ "$(bash "$ROOT/bin/labwired" test board.yml)" == 'core:test board.yml' ]]

if bash "$ROOT/bin/labwired" editor 2>"$TMP/editor.err"; then
  echo 'FAIL editor must report not installed' >&2
  exit 1
fi
grep -q 'not installed' "$TMP/editor.err"

echo 'ok   dispatcher PASS'
```

- [ ] **Step 2: Add the test to the full deterministic suite**

Add this lane to `tests/all.sh` after `prefix-unit`:

```bash
run "dispatcher" "$ROOT/tests/dispatcher.sh"
```

Add this npm script to `package.json`:

```json
"test:dispatcher": "bash tests/dispatcher.sh"
```

- [ ] **Step 3: Run the test and confirm the old launcher fails the new contract**

Run:

```bash
bash tests/dispatcher.sh
```

Expected: FAIL because plain `labwired` starts the agent and `labwired core` is not a product route.

- [ ] **Step 4: Commit the contract test**

```bash
git add tests/dispatcher.sh tests/all.sh package.json
git commit -m "test: define LabWired product command contract"
```

### Task 2: Split the Unix dispatcher from the agent launcher

**Files:**
- Create: `bin/labwired-agent`
- Create: `lib/dispatch.sh`
- Modify: `bin/labwired`
- Test: `tests/dispatcher.sh`

- [ ] **Step 1: Move the current agent launcher without changing behavior**

Copy the current tracked `bin/labwired` to `bin/labwired-agent`. Change its default and help examples from `labwired ...` to `labwired agent ...`.

The final case dispatch in `bin/labwired-agent` must keep these agent subcommands:

```bash
server login logout whoami doctor install-deps deps update self-update upgrade
smoke check hello package pkg version --version -V help --help -h
assert-status score-verify serial-capture compose probe agent opencode
```

Plain `bin/labwired-agent` still starts OpenCode. `bin/labwired-agent doctor` still runs the agent doctor.

- [ ] **Step 2: Add explicit component discovery**

Create `lib/dispatch.sh` with these interfaces:

```bash
labwired_dispatch_home() {
  printf '%s\n' "${LABWIRED_HOME:-$HOME/.labwired}"
}

labwired_dispatch_agent_bin() {
  if [[ -n "${LABWIRED_AGENT_BIN:-}" ]]; then
    printf '%s\n' "$LABWIRED_AGENT_BIN"
  else
    printf '%s/agent/bin/labwired-agent\n' "$(labwired_dispatch_home)"
  fi
}

labwired_dispatch_core_bin() {
  local home registered
  home="$(labwired_dispatch_home)"
  if [[ -n "${LABWIRED_CORE_BIN:-}" ]]; then
    printf '%s\n' "$LABWIRED_CORE_BIN"
    return 0
  fi
  registered="$home/components/core/bin/labwired"
  [[ -x "$registered" ]] && { printf '%s\n' "$registered"; return 0; }
  [[ -x "$home/tools/sim/labwired-sim" ]] && {
    printf '%s\n' "$home/tools/sim/labwired-sim"
    return 0
  }
  return 1
}

labwired_dispatch_is_legacy_core_command() {
  case "${1:-}" in
    test|chips|machine|asset|run|snapshot|coverage|tier1-matrix|cosim-step|fuzz)
      return 0 ;;
    *) return 1 ;;
  esac
}
```

- [ ] **Step 3: Replace `bin/labwired` with the small dispatcher**

The dispatcher must use this routing shape:

```bash
case "${1:-}" in
  ""|help|--help|-h) show_product_help ;;
  agent) shift; exec_agent "$@" ;;
  core) shift; exec_core "$@" ;;
  editor) exec_editor "$@" ;;
  *)
    if labwired_dispatch_is_legacy_core_command "$1"; then
      exec_core "$@"
    fi
    printf 'labwired: unknown command: %s\n' "$1" >&2
    printf 'Run: labwired --help\n' >&2
    exit 2
    ;;
esac
```

`exec_agent` and `exec_core` must check `-x` and return a short install message when the component is missing. `exec_editor` must return exit code 1 with `LabWired Editor is not installed.`

- [ ] **Step 4: Run the focused tests**

Run:

```bash
bash -n bin/labwired bin/labwired-agent lib/dispatch.sh
bash tests/dispatcher.sh
bash tests/harness.sh
```

Expected: all commands exit 0 and `dispatcher PASS` is printed.

- [ ] **Step 5: Commit the split**

```bash
git add bin/labwired bin/labwired-agent lib/dispatch.sh tests/dispatcher.sh
git commit -m "feat: split product dispatcher from agent launcher"
```

### Task 3: Make Unix installation agent-only and Core-safe

**Files:**
- Create: `tests/agent-lifecycle.sh`
- Modify: `install.sh`
- Modify: `scripts/public/install`
- Modify: `scripts/agent-install.sh`
- Modify: `scripts/npm-install.js`
- Modify: `lib/prefix.sh`
- Modify: `lib/resolve-sim.sh`
- Test: `tests/install-smoke.sh`
- Test: `tests/prefix-unit.sh`
- Test: `tests/public-install.sh`

- [ ] **Step 1: Add a failing coexistence test**

Create `tests/agent-lifecycle.sh`. Use a fake Core binary at `$TMP/user-bin/labwired`, run the installer with `LABWIRED_TEST_SKIP_OPENCODE=1` and `LABWIRED_TEST_SKIP_NETWORK=1`, then assert:

```bash
bash "$ROOT/install.sh" --agent-only
test -x "$LABWIRED_HOME/agent/bin/labwired-agent"
test -x "$LABWIRED_HOME/bin/labwired"
test -x "$LABWIRED_HOME/components/core/bin/labwired"
[[ "$("$USERBIN/labwired" core --version)" == 'fake-core 1.0.0' ]]
[[ "$("$USERBIN/labwired" test fixture.yml)" == 'fake-core:test fixture.yml' ]]
test ! -e "$LABWIRED_HOME/tools/sim/labwired-sim"
test ! -d "$LABWIRED_HOME/editor"
```

The test must also create `$LABWIRED_HOME/user-data/keep.txt` and confirm it remains after install and update.

- [ ] **Step 2: Run the lifecycle test and confirm it fails**

Run:

```bash
bash tests/agent-lifecycle.sh
```

Expected: FAIL because the current installer installs simulator and probe tools and replaces the `labwired` command without registering Core.

- [ ] **Step 3: Add component paths and safe Core registration**

Add these functions to `lib/prefix.sh`:

```bash
labwired_prefix_components() { echo "$(labwired_prefix_home)/components"; }
labwired_prefix_core_bin() { echo "$(labwired_prefix_components)/core/bin/labwired"; }
labwired_prefix_agent_bin() { echo "$(labwired_prefix_agent)/bin/labwired-agent"; }
```

Add `labwired_prefix_register_existing_core SOURCE`. It must:

1. Return without changes when `SOURCE` is empty or is an agent/dispatcher script.
2. Create `components/core/bin`.
3. Copy `SOURCE` to a temporary file in that directory.
4. Run the temporary file with `--version` or `--help`.
5. Rename the verified temporary file to `components/core/bin/labwired`.

Never delete the source binary in this function.

- [ ] **Step 4: Change the Unix installer default**

Make `install.sh` default to agent-only behavior:

```bash
PROFILE="${LABWIRED_PROFILE:-hosted}"
export LABWIRED_INSTALL_SIM="${LABWIRED_INSTALL_SIM:-0}"
export LABWIRED_INSTALL_PROBE_RS="${LABWIRED_INSTALL_PROBE_RS:-0}"
export LABWIRED_INSTALL_PIO="${LABWIRED_INSTALL_PIO:-0}"
```

Support `--agent-only` as the default mode. Keep `--with-core-tools` as an explicit development option that sets simulator and probe installation to 1. Do not expose `--with-core-tools` in the public quick start.

Before writing the user shim, capture `command -v labwired`. If it is a Core binary at the same destination, register it with `labwired_prefix_register_existing_core` and verify the registered copy before replacing the user-path entry.

Install the dispatcher to `$LABWIRED_HOME/bin/labwired`. Install the agent launcher to `$LABWIRED_HOME/agent/bin/labwired-agent`.

- [ ] **Step 5: Make the public and npm entry points agent-only**

Change `scripts/public/install` examples to:

```bash
curl -fsSL https://labwired.com/install/agent | bash
```

Its final exec must be:

```bash
exec bash "$AGENT_HOME/install.sh" --agent-only "$@"
```

Change `scripts/npm-install.js` so its default Unix arguments include `--agent-only`. On Windows, pass `-AgentOnly`.

- [ ] **Step 6: Resolve registered Core before legacy PATH names**

In `lib/resolve-sim.sh`, check this path before `labwired-sim` and `labwired-cli` on PATH:

```bash
${prefix_home}/components/core/bin/labwired
```

Keep the existing agent-launcher rejection checks.

- [ ] **Step 7: Update install tests**

Update `tests/install-smoke.sh` to assert:

```bash
"$USERBIN/labwired" --help | grep -q 'labwired agent'
"$USERBIN/labwired" agent version | grep -q 'LabWired Agent'
test ! -e "$PREFIX/tools/sim/labwired-sim"
```

Update `tests/prefix-unit.sh` with a fake registered Core and assert that `labwired_resolve_sim` returns it.

Update `tests/public-install.sh` to require `/install/agent` and reject the old bare `/install` URL in public agent examples.

- [ ] **Step 8: Run the Unix install tests**

Run:

```bash
bash tests/dispatcher.sh
bash tests/agent-lifecycle.sh
bash tests/public-install.sh
bash tests/prefix-unit.sh
bash tests/install-smoke.sh
```

Expected: all five scripts exit 0. The lifecycle output includes `core coexistence PASS` and `agent-only PASS`.

- [ ] **Step 9: Commit Unix installation**

```bash
git add install.sh scripts/public/install scripts/agent-install.sh scripts/npm-install.js lib/prefix.sh lib/resolve-sim.sh tests/agent-lifecycle.sh tests/install-smoke.sh tests/prefix-unit.sh tests/public-install.sh
git commit -m "feat: install agent without replacing LabWired Core"
```

### Task 4: Isolate agent update, configuration, and removal

**Files:**
- Modify: `lib/update.sh`
- Modify: `bin/labwired-agent`
- Modify: `install.sh`
- Modify: `lib/prefix.sh`
- Test: `tests/agent-lifecycle.sh`
- Test: `tests/hosted-config.sh`

- [ ] **Step 1: Extend the lifecycle test with update and removal checks**

Add checks that run:

```bash
"$USERBIN/labwired" agent update --check
"$USERBIN/labwired" agent package uninstall --yes
```

After removal, assert:

```bash
test ! -e "$LABWIRED_HOME/agent"
test -x "$LABWIRED_HOME/components/core/bin/labwired"
test -f "$LABWIRED_HOME/user-data/keep.txt"
[[ "$("$USERBIN/labwired" core --version)" == 'fake-core 1.0.0' ]]
```

Also create an existing OpenCode config with an unrelated provider and assert that installation does not delete that provider.

- [ ] **Step 2: Run the extended test and confirm destructive behavior**

Run:

```bash
bash tests/agent-lifecycle.sh
```

Expected: FAIL because the current removal command deletes shared tools, bins, cache, and share directories.

- [ ] **Step 3: Make update agent-only**

Change `labwired_update_reinstall` in `lib/update.sh` to run:

```bash
bash "$installer" --agent-only
```

Remove Core, probe, and PlatformIO updates from the default agent update path. Keep a clear error if a user passes the old `--tools-only` option:

```text
Core tools are managed by `labwired core`.
```

- [ ] **Step 4: Make removal ownership-based**

Change the agent removal command to remove only:

```text
$LABWIRED_HOME/agent
$LABWIRED_HOME/state/agent
agent-owned OpenCode skill files listed in the agent manifest
```

Keep the dispatcher when Core or Editor is registered. Remove the dispatcher and user shim only when no components remain.

Do not remove `components/core`, `tools`, `cache`, `share`, login data, or unknown files.

- [ ] **Step 5: Merge OpenCode configuration instead of replacing it**

Use the existing Python JSON update block in `install.sh` to modify only these owned keys:

```text
mcp.labwired
provider.labwired
permission.skill.<LabWired skill name>
```

Keep all unrelated providers, MCP servers, permissions, themes, and user settings. Before the first change, write one backup to:

```text
~/.config/opencode/opencode.json.labwired-backup
```

Do not overwrite an existing backup.

- [ ] **Step 6: Run lifecycle and hosted configuration tests**

Run:

```bash
bash tests/agent-lifecycle.sh
bash tests/hosted-config.sh
bash tests/desktop-session.sh
```

Expected: all scripts exit 0. The unrelated provider remains in the test configuration.

- [ ] **Step 7: Commit lifecycle isolation**

```bash
git add lib/update.sh bin/labwired-agent install.sh lib/prefix.sh tests/agent-lifecycle.sh tests/hosted-config.sh
git commit -m "fix: isolate agent update and removal"
```

### Task 5: Add Windows dispatcher and agent-only installation parity

**Files:**
- Modify: `bin/labwired.ps1`
- Modify: `bin/labwired.cmd`
- Create: `bin/labwired-agent.ps1`
- Modify: `scripts/install.ps1`
- Modify: `scripts/public/install.ps1`
- Modify: `scripts/npm-install.js`
- Create: `tests/windows-contract.ps1`
- Modify: `tests/public-install.sh`

- [ ] **Step 1: Add a PowerShell contract test**

Create `tests/windows-contract.ps1` with temporary fake `.cmd` components. Check these outputs:

```powershell
$help = & $Dispatcher
if ($help -notmatch 'labwired agent') { throw 'agent help missing' }
if ($help -notmatch 'labwired core') { throw 'core help missing' }
if ((& $Dispatcher agent doctor) -notmatch 'agent:doctor') { throw 'agent route failed' }
if ((& $Dispatcher core test board.yml) -notmatch 'core:test board.yml') { throw 'core route failed' }
if ((& $Dispatcher test board.yml) -notmatch 'core:test board.yml') { throw 'legacy core route failed' }
```

- [ ] **Step 2: Run syntax checks before implementation**

Run on a system with PowerShell:

```powershell
powershell -NoProfile -File tests/windows-contract.ps1
```

Expected: FAIL because `bin/labwired.ps1` is still the agent launcher.

- [ ] **Step 3: Split and route Windows commands**

Move current agent logic into `bin/labwired-agent.ps1`. Replace `bin/labwired.ps1` with a dispatcher that mirrors the Unix routes:

```text
labwired
labwired agent [arguments]
labwired core [arguments]
labwired editor [arguments]
legacy Core commands
```

Use `$env:LABWIRED_AGENT_BIN` and `$env:LABWIRED_CORE_BIN` overrides in tests. Default to explicit paths under `%USERPROFILE%\.labwired`.

- [ ] **Step 4: Make Windows installation agent-only**

Add `[switch]$AgentOnly` to `scripts/install.ps1`. Make it the default when neither `-Full` nor another component mode is passed. Do not call `Install-Sim`, `Install-ProbeRs`, or PlatformIO from the agent-only path.

If an existing `labwired.exe` or `labwired.cmd` is found at the user shim destination, copy and verify it under:

```text
%USERPROFILE%\.labwired\components\core\bin\labwired.exe
```

Then install the dispatcher.

- [ ] **Step 5: Update the Windows public installer URL**

Use this public command in comments and deployment notes:

```powershell
irm https://labwired.com/install/agent.ps1 | iex
```

- [ ] **Step 6: Run Windows and cross-platform static checks**

Run:

```powershell
powershell -NoProfile -File tests/windows-contract.ps1
powershell -NoProfile -Command "[scriptblock]::Create((Get-Content scripts/install.ps1 -Raw)) | Out-Null"
```

Run on Unix:

```bash
bash tests/public-install.sh
```

Expected: all checks exit 0.

- [ ] **Step 7: Commit Windows parity**

```bash
git add bin/labwired.ps1 bin/labwired.cmd bin/labwired-agent.ps1 scripts/install.ps1 scripts/public/install.ps1 scripts/npm-install.js tests/windows-contract.ps1 tests/public-install.sh
git commit -m "feat: add Windows product dispatcher"
```

### Task 6: Rewrite public documentation in simple technical English

**Files:**
- Modify: `README.md`
- Create: `docs/INSTALL.md`
- Create: `docs/USAGE.md`
- Create: `docs/VERIFY.md`
- Create: `docs/DEVELOPMENT.md`
- Modify: `docs/TESTING.md`
- Modify: `config/AGENTS.md`
- Modify: `scripts/public/DEPLOY.md`
- Modify: `CHANGELOG.md`
- Modify: `package.json`
- Test: `scripts/check-public-package.sh`

- [ ] **Step 1: Add simple-English and stale-command checks**

In `scripts/check-public-package.sh`, scan public Markdown files and fail on these stale commands and internal terms:

```bash
for pattern in \
  'https://labwired.com/install | bash' \
  'https://labwired.com/agent-install.sh' \
  'labwired doctor' \
  'labwired login' \
  'Gate 1' \
  'harness dump' \
  'distribution layer'
do
  if rg -n "$pattern" README.md docs/INSTALL.md docs/USAGE.md docs/VERIFY.md; then
    echo "FAIL stale public text: $pattern" >&2
    exit 1
  fi
done
```

Allow exact internal status names only in `docs/VERIFY.md` and `config/AGENTS.md`.

- [ ] **Step 2: Run the document check and confirm it fails**

Run:

```bash
bash scripts/check-public-package.sh
```

Expected: FAIL because the current README uses the old installer and old top-level agent commands.

- [ ] **Step 3: Rewrite the README around one first task**

The top of `README.md` must contain this flow:

```bash
curl -fsSL https://labwired.com/install/agent | bash
labwired agent
```

Then show one prompt:

```text
Blink the LED and test it on the twin.
```

Keep the first screen under 80 lines. Link to the four focused public guides. Do not include pricing, internal architecture, competitor notes, or editor claims.

- [ ] **Step 4: Write the four focused guides**

`docs/INSTALL.md` must cover supported systems, the one-line installer, `labwired agent update`, `labwired agent doctor`, agent-only removal, Core coexistence, and short troubleshooting steps.

`docs/USAGE.md` must cover start, login, board bring-up, firmware repair, twin testing, observation, and optional physical-board checks.

`docs/VERIFY.md` must explain:

```text
Build passed != behavior passed
labwired_run = observation
labwired_verify + model_verified = twin behavior passed
hardware_observed = physical board marker observed
```

`docs/DEVELOPMENT.md` must list the repository setup, deterministic tests, install smoke, live twin gate, optional hardware gate, and optional model gate.

- [ ] **Step 5: Add the writing rule to agent instructions**

Add this section near the top of `config/AGENTS.md`:

```markdown
## Writing style

Use simple technical English.
Use short sentences.
Put one main idea in each sentence.
Explain uncommon terms once.
Show the command before a long explanation.
Keep exact status names in evidence, then explain them in normal language.
```

- [ ] **Step 6: Align version and release notes**

Set `package.json` version to the exact value in `VERSION`. Add a changelog entry for the public agent release with these user-visible changes:

```text
- Start the agent with `labwired agent`.
- Install only the agent from `/install/agent`.
- Keep existing LabWired Core commands working.
- Update and remove the agent without changing Core data.
- Use shorter public documentation.
```

- [ ] **Step 7: Run documentation checks**

Run:

```bash
bash scripts/check-public-package.sh
bash tests/public-install.sh
bash tests/skills-inventory.sh
```

Expected: all scripts exit 0.

- [ ] **Step 8: Commit public documentation**

```bash
git add README.md docs/INSTALL.md docs/USAGE.md docs/VERIFY.md docs/DEVELOPMENT.md docs/TESTING.md config/AGENTS.md scripts/public/DEPLOY.md CHANGELOG.md package.json scripts/check-public-package.sh
git commit -m "docs: publish simple LabWired Agent guides"
```

### Task 7: Restrict the public package and add release hygiene gates

**Files:**
- Modify: `package.json`
- Modify: `.gitignore`
- Modify: `scripts/check-public-package.sh`
- Modify: `tests/public-install.sh`
- Modify: `.github/workflows/harness.yml`

- [ ] **Step 1: Add a packed-file test**

Extend `scripts/check-public-package.sh` to run:

```bash
pack_json="$(npm pack --dry-run --json)"
printf '%s' "$pack_json" >"$TMP/package.json"
```

Fail if packed file names contain any of these paths:

```text
docs/qa/
docs/product/
docs/superpowers/
fixtures/coverage/smoke/
.grok/
*.png
*.yml
```

Require these paths:

```text
README.md
LICENSE
CHANGELOG.md
VERSION
bin/labwired
bin/labwired-agent
config/AGENTS.md
docs/INSTALL.md
docs/USAGE.md
docs/VERIFY.md
docs/DEVELOPMENT.md
```

- [ ] **Step 2: Add secret and private-path scans**

Scan tracked and packed text for:

```text
/Users/
@gmail.com
BEGIN PRIVATE KEY
DEEPINFRA_API_KEY followed by an assigned secret value
LABWIRED_ACCESS_TOKEN followed by an assigned secret value
```

The scan must print the file path and exit 1 on a match. Test fixtures may use the exact placeholders `example@example.com`, `test-token`, and `DEEPINFRA_API_KEY=…`.

- [ ] **Step 3: Run the package check and confirm current leakage**

Run:

```bash
bash scripts/check-public-package.sh
```

Expected before allowlist changes: FAIL because the current npm package includes broad `docs`, `fixtures`, and `scripts` directories.

- [ ] **Step 4: Replace broad package entries with a public allowlist**

In `package.json`, keep only runtime files and public guides. Include exact subpaths instead of whole internal directories. Keep the five LabWired domain skills and required process skills because the agent needs them at runtime.

Do not publish repository tests, QA reports, product plans, screenshots, raw competitive material, or local deployment evidence.

- [ ] **Step 5: Add CI gates**

Add these commands to the `unit` job in `.github/workflows/harness.yml`:

```yaml
- name: dispatcher and public package
  run: |
    bash tests/dispatcher.sh
    bash tests/agent-lifecycle.sh
    bash scripts/check-public-package.sh
```

Keep physical-board and paid-model tests optional. They must print `not run` when their required input is absent.

- [ ] **Step 6: Run release hygiene checks**

Run:

```bash
bash scripts/check-public-package.sh
npm pack --dry-run
bash tests/public-install.sh
```

Expected: all commands exit 0. The package list contains no internal directories or private paths.

- [ ] **Step 7: Commit package hygiene**

```bash
git add package.json .gitignore scripts/check-public-package.sh tests/public-install.sh .github/workflows/harness.yml
git commit -m "build: restrict public agent package"
```

### Task 8: Run the complete release verification

**Files:**
- Modify only if a test exposes a defect in the files already listed above.
- Verify: all deterministic, install, twin, and optional hardware lanes.

- [ ] **Step 1: Run syntax and deterministic tests**

Run:

```bash
bash -n bin/labwired bin/labwired-agent install.sh scripts/public/install lib/*.sh tests/*.sh
npm run test:unit
bash tests/dispatcher.sh
bash tests/agent-lifecycle.sh
bash scripts/check-public-package.sh
```

Expected: all commands exit 0.

- [ ] **Step 2: Run clean installation tests**

Run:

```bash
npm run test:install
```

Expected: PASS with `labwired agent` available, no new Core install, and no Editor install.

- [ ] **Step 3: Run the full repository suite**

Run:

```bash
npm test
```

Expected: overall PASS. A missing model key or board is printed as `not run`, not PASS.

- [ ] **Step 4: Run the live product gate with the connected ESP32-C3**

Run outside any USB-restricted sandbox:

```bash
bash tests/gap-ready-qa.sh
```

Expected:

```text
pass: 28
fail: 0
agent_product_ready: true
```

- [ ] **Step 5: Verify the public archive**

Run:

```bash
npm pack --dry-run
git diff --check
git status --short
```

Expected: the archive contains only approved public files. `git diff --check` prints nothing. Only intentional release changes are present.

- [ ] **Step 6: Commit any verification-only corrections**

If verification required a correction in the planned release files, commit only those planned files that changed:

```bash
git add bin/labwired bin/labwired-agent install.sh scripts/public/install \
  lib/dispatch.sh lib/prefix.sh lib/resolve-sim.sh lib/update.sh \
  README.md docs/INSTALL.md docs/USAGE.md docs/VERIFY.md docs/DEVELOPMENT.md \
  package.json tests/dispatcher.sh tests/agent-lifecycle.sh
git commit -m "fix: close public agent release gate"
```

If no correction was required, do not create an empty commit.

## Final handoff

Report these facts without broadening the claim:

- Agent installer and command tested
- Core coexistence tested with the compatibility fixture
- Twin verification result
- Physical ESP32-C3 debug-read result, if run
- Windows contract result and where it ran
- Paid-model test result or `not run`
- Public archive contents checked

Do not publish npm packages, GitHub releases, website routes, or installer files to production without a separate explicit release request.
