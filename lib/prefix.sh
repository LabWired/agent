#!/usr/bin/env bash
# prefix.sh — portable, contained LabWired install root (multi-platform).
# shellcheck shell=bash
#
# Layout (all under one prefix — copyable / relocatable):
#
#   $LABWIRED_HOME/                    # default: ~/.labwired
#     PREFIX_VERSION                   # agent kit version string
#     MANIFEST.json                    # component versions + platform
#     bin/                             # ONLY shims customers put on PATH
#       labwired
#       labwired-sim -> ../tools/sim/labwired-sim
#       probe-rs     -> ../tools/probe-rs/probe-rs
#       pio          -> ../tools/pio/...   (optional)
#     agent/                           # agent kit (skills, lib, config templates)
#     tools/
#       sim/labwired-sim
#       probe-rs/probe-rs
#       pio/                           # optional PlatformIO penv
#     env.sh                           # source to activate prefix on PATH
#     cache/                           # download cache
#
# Env:
#   LABWIRED_HOME   install root (default ~/.labwired)
#   LABWIRED_BIN_DIR  thin user PATH entry (default ~/.local/bin) — only shims

labwired_prefix_home() {
  if [[ -n "${LABWIRED_HOME:-}" ]]; then
    echo "${LABWIRED_HOME%/}"
    return 0
  fi
  echo "${HOME}/.labwired"
}

labwired_prefix_agent() { echo "$(labwired_prefix_home)/agent"; }
labwired_prefix_bin() { echo "$(labwired_prefix_home)/bin"; }
labwired_prefix_components() { echo "$(labwired_prefix_home)/components"; }
labwired_prefix_core_bin() { echo "$(labwired_prefix_components)/core/bin/labwired"; }
labwired_prefix_agent_bin() { echo "$(labwired_prefix_agent)/bin/labwired-agent"; }
labwired_prefix_tools() { echo "$(labwired_prefix_home)/tools"; }
labwired_prefix_cache() { echo "$(labwired_prefix_home)/cache"; }
labwired_prefix_manifest() { echo "$(labwired_prefix_home)/MANIFEST.json"; }

# Refuse paths containing symlinked application-level ancestors. The first
# filesystem component is treated as the platform root (for example macOS
# /var -> /private/var); everything below it must be a real directory.
labwired_prefix_validate_path_ancestors() {
  local target="${1:-}" current="" part index=0
  local -a _labwired_path_parts
  [[ "$target" == /* ]] || return 1
  IFS='/' read -r -a _labwired_path_parts <<<"${target#/}"
  for part in "${_labwired_path_parts[@]}"; do
    [[ -n "$part" ]] || continue
    [[ "$part" != "." && "$part" != ".." ]] || return 1
    current="$current/$part"
    index=$((index + 1))
    if (( index > 1 )) && [[ -L "$current" ]]; then
      printf 'labwired: refusing symlinked path ancestor: %s\n' "$current" >&2
      return 1
    fi
  done
}

# User-facing PATH dir for a single shim (not the whole tree scatter).
labwired_user_bin() {
  echo "${LABWIRED_BIN_DIR:-$HOME/.local/bin}"
}

# True when running under Windows Subsystem for Linux.
labwired_prefix_is_wsl() {
  if [[ -n "${WSL_DISTRO_NAME:-}" || -n "${WSL_INTEROP:-}" ]]; then
    return 0
  fi
  if [[ -f /proc/version ]] && grep -qiE 'microsoft|wsl' /proc/version 2>/dev/null; then
    return 0
  fi
  return 1
}

labwired_prefix_platform() {
  local os arch
  os="$(uname -s 2>/dev/null || echo unknown)"
  arch="$(uname -m 2>/dev/null || echo unknown)"
  case "$os" in
    Darwin) os="darwin" ;;
    Linux)
      # WSL reports as Linux — use linux-* triple so prebuilt sim/probe assets match.
      os="linux"
      ;;
    MINGW*|MSYS*|CYGWIN*) os="windows" ;;
    *) os="$(printf '%s' "$os" | tr '[:upper:]' '[:lower:]')" ;;
  esac
  case "$arch" in
    x86_64|amd64) arch="x86_64" ;;
    aarch64|arm64) arch="aarch64" ;;
    *) : ;;
  esac
  echo "${os}-${arch}"
}

# Extra label for doctor/MANIFEST (linux-x86_64 + wsl).
labwired_prefix_runtime_label() {
  local p
  p="$(labwired_prefix_platform)"
  if labwired_prefix_is_wsl; then
    echo "${p}+wsl"
  else
    echo "$p"
  fi
}

# Platforms with prebuilt sim binaries (GitHub labwired-core releases).
# Windows is a supported *agent* platform; local sim is optional until core
# publishes windows-x86_64 assets (hosted MCP verify works in the meantime).
labwired_prefix_platform_supported() {
  case "$(labwired_prefix_platform)" in
    darwin-x86_64|darwin-aarch64|linux-x86_64|linux-aarch64) return 0 ;;
    windows-x86_64|windows-aarch64)
      # Accept when/if assets appear; install-deps probes release API.
      return 0
      ;;
    *) return 1 ;;
  esac
}

labwired_prefix_ensure_dirs() {
  local h
  h="$(labwired_prefix_home)"
  mkdir -p \
    "$h/bin" \
    "$h/agent" \
    "$h/components" \
    "$h/tools/sim" \
    "$h/tools/probe-rs" \
    "$h/tools/pio" \
    "$h/cache" \
    "$h/share"
}

# Run a probe with a portable wall-clock bound (BSD/macOS and Linux). Output is
# emitted only after the child exits; status 124 means the probe was terminated.
_labwired_prefix_bounded_output() {
  local limit_ticks="${1:-20}" output pid tick status
  shift
  output="$(mktemp "${TMPDIR:-/tmp}/labwired-probe.XXXXXX")" || return 1
  "$@" >"$output" 2>&1 &
  pid=$!
  tick=0
  while kill -0 "$pid" 2>/dev/null; do
    if [[ "$tick" -ge "$limit_ticks" ]]; then
      kill -TERM "$pid" 2>/dev/null || true
      sleep 0.1
      kill -KILL "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
      rm -f "$output"
      return 124
    fi
    sleep 0.1
    tick=$((tick + 1))
  done
  if wait "$pid"; then status=0; else status=$?; fi
  cat "$output"
  rm -f "$output"
  return "$status"
}

# Preserve a pre-existing standalone Core binary before installing the product
# dispatcher at the user-facing `labwired` path.
labwired_prefix_register_existing_core() {
  local source="${1:-}" target target_dir tmp help version
  [[ -n "$source" && -x "$source" ]] || return 0
  target="$(labwired_prefix_core_bin)"
  [[ "$source" != "$target" ]] || return 0

  # Never register one of our shell dispatchers/agent launchers as Core: doing
  # so would make `labwired core` recursively dispatch to itself.
  if head -n 80 "$source" 2>/dev/null \
    | grep -Eq 'labwired_product_help|labwired_dispatch_exec_|LABWIRED_AGENT_HOME|/agent/bin/labwired-agent|LabWired Agent'; then
    return 0
  fi

  local components core_dir
  components="$(labwired_prefix_components)"
  core_dir="$components/core"
  target_dir="$(dirname "$target")"
  for path in "$components" "$core_dir" "$target_dir"; do
    [[ ! -L "$path" ]] || {
      printf 'labwired: refusing symlinked Core component path: %s\n' "$path" >&2
      return 1
    }
  done
  mkdir -p "$target_dir"
  for path in "$components" "$core_dir" "$target_dir"; do
    [[ -d "$path" && ! -L "$path" ]] || return 1
  done
  tmp="$(mktemp "$target_dir/.labwired-core.XXXXXX")" || return 1
  if ! cp "$source" "$tmp"; then
    rm -f "$tmp"
    return 1
  fi
  chmod 0755 "$tmp"
  if head -n 1 "$tmp" 2>/dev/null | grep -q '^#!' \
    && grep -Eq '(^|[[:space:]])(source|\.)[[:space:]]|dirname|require\(|^import[[:space:]]' "$tmp"; then
    rm -f "$tmp"
    printf 'labwired: existing Core launcher depends on adjacent files and cannot be registered safely; set LABWIRED_CORE_BIN to a self-contained executable\n' >&2
    return 1
  fi
  if ! version="$(_labwired_prefix_bounded_output 20 "$tmp" --version)"; then
    rm -f "$tmp"
    printf 'labwired: existing Core candidate did not answer --version within the safety bound\n' >&2
    return 1
  fi
  if ! help="$(_labwired_prefix_bounded_output 20 "$tmp" --help)"; then
    rm -f "$tmp"
    printf 'labwired: existing Core candidate did not answer --help within the safety bound\n' >&2
    return 1
  fi
  local identified=0
  if [[ "$help" == *"LabWired Simulator"* \
    && "$help" == *"test"* && "$help" == *"chips"* && "$help" == *"machine"* \
    && -n "$version" ]]; then
    identified=1
  elif [[ "${LABWIRED_TEST_ALLOW_FAKE_CORE:-0}" == "1" \
    && "${LABWIRED_TEST_SKIP_NETWORK:-0}" == "1" \
    && "${LABWIRED_TEST_SKIP_OPENCODE:-0}" == "1" \
    && "$version" == "fake-core 1.0.0" \
    && "$help" == "fake-core help" ]]; then
    identified=1
  fi
  if [[ "$identified" != "1" ]]; then
    rm -f "$tmp"
    printf 'labwired: existing command is not a self-contained LabWired Core; set LABWIRED_CORE_BIN explicitly if needed\n' >&2
    return 1
  fi
  mv -f "$tmp" "$target"
}

# Write env.sh so users can: source ~/.labwired/env.sh
labwired_prefix_write_env() {
  local h bin
  h="$(labwired_prefix_home)"
  bin="$h/bin"
  cat >"$h/env.sh" <<EOF
# LabWired portable prefix — generated by install
# Usage: source ${h}/env.sh
export LABWIRED_HOME="${h}"
export LABWIRED_AGENT_HOME="${h}/agent"
# Prefer prefix tools before system PATH
case ":\${PATH}:" in
  *":${bin}:"*) ;;
  *) export PATH="${bin}:\${PATH}" ;;
esac
# Simulator for MCP / agent
if [[ -x "${h}/tools/sim/labwired-sim" ]]; then
  export LABWIRED_CLI="${h}/tools/sim/labwired-sim"
  export LABWIRED_SIM="\${LABWIRED_CLI}"
fi
if [[ -x "${h}/tools/probe-rs/probe-rs" ]]; then
  export LABWIRED_PROBE_RS="${h}/tools/probe-rs/probe-rs"
fi
EOF
}

labwired_prefix_write_manifest() {
  local h plat agent_ver sim_ver probe_ver pio_ver ts
  h="$(labwired_prefix_home)"
  plat="$(labwired_prefix_platform)"
  agent_ver="unknown"
  [[ -f "$h/agent/VERSION" ]] && agent_ver="$(tr -d '[:space:]' <"$h/agent/VERSION")"
  sim_ver=""
  [[ -x "$h/tools/sim/labwired-sim" ]] && sim_ver="$("$h/tools/sim/labwired-sim" --version 2>/dev/null | head -1 || echo installed)"
  probe_ver=""
  [[ -x "$h/tools/probe-rs/probe-rs" ]] && probe_ver="$("$h/tools/probe-rs/probe-rs" --version 2>/dev/null | head -1 || echo installed)"
  pio_ver=""
  if [[ -x "$h/bin/pio" ]] || command -v pio >/dev/null 2>&1; then
    pio_ver="$(pio --version 2>/dev/null | head -1 || echo present)"
  fi
  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo unknown)"
  cat >"$(labwired_prefix_manifest)" <<EOF
{
  "schema": 1,
  "product": "labwired-agent",
  "agent_version": $(python3 -c "import json; print(json.dumps('''$agent_ver'''))" 2>/dev/null || echo "\"$agent_ver\""),
  "platform": "$plat",
  "runtime": "$(labwired_prefix_runtime_label)",
  "wsl": $(if labwired_prefix_is_wsl; then echo true; else echo false; fi),
  "prefix": $(python3 -c "import json,os; print(json.dumps(os.path.expanduser('''$h''')))" 2>/dev/null || echo "\"$h\""),
  "components": {
    "sim": $(python3 -c "import json; print(json.dumps('''$sim_ver'''))" 2>/dev/null || echo "\"$sim_ver\""),
    "probe_rs": $(python3 -c "import json; print(json.dumps('''$probe_ver'''))" 2>/dev/null || echo "\"$probe_ver\""),
    "platformio": $(python3 -c "import json; print(json.dumps('''$pio_ver'''))" 2>/dev/null || echo "\"$pio_ver\"")
  },
  "updated_at": "$ts",
  "portable": true,
  "contained": true
}
EOF
  echo "$agent_ver" >"$h/PREFIX_VERSION"
}

# Install a thin shim into user PATH that only execs prefix bin.
# Fully portable: activates prefix env so `labwired` works without prior `source env.sh`.
labwired_prefix_link_user_shim() {
  local user_bin h shim tmp
  user_bin="$(labwired_user_bin)"
  h="$(labwired_prefix_home)"
  mkdir -p "$user_bin" "$h/bin"
  shim="${user_bin}/labwired"
  tmp="$(mktemp "$user_bin/.labwired-shim.XXXXXX")"
  cat >"$tmp" <<EOF
#!/usr/bin/env bash
# LabWired portable launcher — do not edit; re-run install to refresh
export LABWIRED_HOME="${h}"
export LABWIRED_AGENT_HOME="\${LABWIRED_HOME}/agent"
export PATH="\${LABWIRED_HOME}/bin:\${PATH}"
if [[ -f "\${LABWIRED_HOME}/env.sh" ]]; then
  # shellcheck disable=SC1090
  source "\${LABWIRED_HOME}/env.sh"
fi
if [[ -x "\${LABWIRED_HOME}/tools/sim/labwired-sim" ]]; then
  export LABWIRED_CLI="\${LABWIRED_HOME}/tools/sim/labwired-sim"
  export LABWIRED_SIM="\${LABWIRED_CLI}"
fi
if [[ -x "\${LABWIRED_HOME}/tools/probe-rs/probe-rs" ]]; then
  export LABWIRED_PROBE_RS="\${LABWIRED_HOME}/tools/probe-rs/probe-rs"
fi
exec "\${LABWIRED_HOME}/bin/labwired" "\$@"
EOF
  chmod 0755 "$tmp"
  mv -f "$tmp" "$shim"
  # Mirror into prefix bin as well
  cp "$shim" "${h}/bin/labwired-shim" 2>/dev/null || true
}

labwired_prefix_info() {
  local h m
  h="$(labwired_prefix_home)"
  echo "LABWIRED_HOME=$h"
  echo "platform=$(labwired_prefix_platform)"
  echo "agent=$h/agent"
  echo "bin=$h/bin"
  echo "tools=$h/tools"
  m="$(labwired_prefix_manifest)"
  if [[ -f "$m" ]]; then
    echo "manifest=$m"
    cat "$m"
  else
    echo "manifest=(missing — run install)"
  fi
}
