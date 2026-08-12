#!/usr/bin/env bash
# probe.sh — LabWired unified board attach (physical probes + virtual LabWired).
# Backend for real silicon: probe-rs (ST-Link, J-Link, CMSIS-DAP, …).
# Backend for virtual: LabWired simulator (validation device).
# shellcheck shell=bash

# Requires: ROOT set, resolve-probe.sh + resolve-sim.sh sourced.

labwired_probe_usage() {
  cat <<'EOF'
labwired probe — attach boards (physical or virtual LabWired)

  labwired probe list              List probes + virtual devices
  labwired probe chips [query]     Search chip names (probe-rs)
  labwired probe flash <elf>       Flash firmware
      --chip <name>                Chip/board id (required for physical)
      --target virtual|auto|probe  Default: auto
      --probe <selector>           probe-rs probe selector (optional)
  labwired probe reset             Reset target
      --chip <name>
      --target virtual|auto|probe
  labwired probe doctor            Probe backend status
  labwired probe rtt [--chip <id>] RTT status / attach when probe-rs supports it

Virtual LabWired validation device:
  --target virtual   Uses LABWIRED_CLI simulator (no physical probe)
  Claims: simulation only until a physical path succeeds.

Examples:
  labwired probe list
  labwired probe flash build/app.elf --chip STM32L476RGTx
  labwired probe flash build/app.elf --target virtual --chip nucleo-l476rg
  labwired probe reset --chip nRF52840_xxAA
EOF
}

labwired_probe_backend_info() {
  local prs=""
  if prs="$(labwired_resolve_probe_rs 2>/dev/null)"; then
    echo "probe-rs: $prs"
    "$prs" --version 2>/dev/null | head -1 || true
  else
    echo "probe-rs: (not installed)"
  fi
  local sim=""
  if sim="$(labwired_resolve_sim "${LABWIRED_AGENT_HOME:-}/bin/labwired" 2>/dev/null)"; then
    echo "virtual:  $sim"
  else
    echo "virtual:  (LabWired sim not found — curl -fsSL https://labwired.com/install.sh | sh)"
  fi
}

labwired_probe_list() {
  echo "== physical probes (probe-rs) =="
  local prs=""
  if ! prs="$(labwired_resolve_probe_rs 2>/dev/null)"; then
    echo "(probe-rs missing — run: labwired probe install-backend)"
  else
    if ! "$prs" list 2>/dev/null; then
      echo "(none attached or list failed)"
    fi
  fi
  echo
  echo "== virtual LabWired validation devices =="
  local sim=""
  if sim="$(labwired_resolve_sim "${LABWIRED_AGENT_HOME:-}/bin/labwired" 2>/dev/null)"; then
    echo "labwired-virtual   backend=sim   path=$sim"
    echo "  Use: labwired probe flash <elf> --target virtual --chip <board-or-system>"
    echo "  Or MCP: labwired_run / labwired_verify against the twin"
  else
    echo "(sim not installed — install LabWired CLI for virtual boards)"
  fi
}

labwired_probe_chips() {
  local q="${1:-}"
  local prs=""
  if ! prs="$(labwired_resolve_probe_rs 2>/dev/null)"; then
    echo "labwired probe: probe-rs not installed" >&2
    return 1
  fi
  if [[ -n "$q" ]]; then
    "$prs" chip list 2>/dev/null | grep -i -- "$q" | head -80 || true
  else
    echo "labwired probe: pass a query, e.g. labwired probe chips stm32l4"
    echo "  (full chip list is large — probe-rs supports most Cortex-M / nRF / RP / ESP)"
    return 0
  fi
}

# Resolve flash target: virtual | probe
# env/args: --target, auto prefers physical if probe present else virtual
labwired_probe_resolve_target() {
  local want="${1:-auto}"
  local prs="" sim=""
  prs="$(labwired_resolve_probe_rs 2>/dev/null || true)"
  sim="$(labwired_resolve_sim "${LABWIRED_AGENT_HOME:-}/bin/labwired" 2>/dev/null || true)"

  case "$want" in
    virtual|sim|labwired)
      [[ -n "$sim" ]] || return 1
      echo "virtual"
      return 0
      ;;
    probe|physical|hw)
      [[ -n "$prs" ]] || return 1
      echo "probe"
      return 0
      ;;
    auto|"")
      if [[ -n "$prs" ]] && "$prs" list 2>/dev/null | grep -q .; then
        echo "probe"
        return 0
      fi
      if [[ -n "$sim" ]]; then
        echo "virtual"
        return 0
      fi
      if [[ -n "$prs" ]]; then
        echo "probe"
        return 0
      fi
      return 1
      ;;
    *)
      return 1
      ;;
  esac
}

labwired_probe_flash() {
  local elf="" chip="" target="auto" probe_sel=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --chip) chip="${2:-}"; shift 2 ;;
      --target) target="${2:-}"; shift 2 ;;
      --probe) probe_sel="${2:-}"; shift 2 ;;
      -h|--help) labwired_probe_usage; return 0 ;;
      -*)
        echo "labwired probe flash: unknown flag $1" >&2
        return 2
        ;;
      *)
        if [[ -z "$elf" ]]; then elf="$1"; shift
        else echo "labwired probe flash: unexpected arg $1" >&2; return 2
        fi
        ;;
    esac
  done
  if [[ -z "$elf" || ! -f "$elf" ]]; then
    echo "usage: labwired probe flash <elf> --chip <name> [--target virtual|probe|auto]" >&2
    return 2
  fi

  local mode=""
  if ! mode="$(labwired_probe_resolve_target "$target")"; then
    echo "labwired probe flash: no backend (install probe-rs and/or LabWired sim)" >&2
    return 1
  fi

  if [[ "$mode" == "virtual" ]]; then
    local sim
    sim="$(labwired_resolve_sim "${LABWIRED_AGENT_HOME:-}/bin/labwired")" || {
      echo "labwired probe flash: virtual needs LabWired sim" >&2
      return 1
    }
    echo "==> virtual LabWired device (simulation — not hardware)"
    echo "    sim:  $sim"
    echo "    elf:  $elf"
    [[ -n "$chip" ]] && echo "    chip: $chip"
    # Prefer run if binary supports it; always honest about sim.
    if "$sim" --help 2>&1 | grep -qE -- '--firmware|run|firmware'; then
      if [[ -n "$chip" ]]; then
        "$sim" --firmware "$elf" --system "$chip" 2>/dev/null \
          || "$sim" run --firmware "$elf" --board "$chip" 2>/dev/null \
          || "$sim" --firmware "$elf" 2>/dev/null \
          || {
            echo "labwired: could not invoke sim with this CLI; use MCP labwired_run/verify" >&2
            echo "claim: not hardware-confirmed; sim path only"
            return 1
          }
      else
        "$sim" --firmware "$elf" 2>/dev/null || {
          echo "labwired: set --chip for virtual board id, or use MCP labwired_verify" >&2
          return 1
        }
      fi
    else
      echo "labwired: sim CLI shape unknown — use agent MCP labwired_verify for virtual boards" >&2
      echo "    LABWIRED_CLI=$sim"
      return 1
    fi
    echo "claim: simulation only (virtual LabWired validation device)"
    return 0
  fi

  # Physical: ESP32* often uses esptool/PIO (USB-Serial/JTAG), not probe-rs alone.
  local chip_lc
  chip_lc="$(printf '%s' "$chip" | tr '[:upper:]' '[:lower:]')"
  if [[ -z "$chip" ]]; then
    echo "labwired probe flash: --chip required for physical flash" >&2
    return 2
  fi
  if [[ "$chip_lc" == *esp32* ]] || [[ "$chip_lc" == *esp8266* ]]; then
    if command -v pio >/dev/null 2>&1 && [[ -f "platformio.ini" ]]; then
      echo "==> physical flash via PlatformIO (ESP family — USB-CDC path)"
      echo "    chip: $chip"
      echo "    elf:  $elf  (pio rebuilds from project; prefer project dir)"
      pio run -t upload
      echo "claim: flashed via PIO — capture serial before hardware_observed"
      return 0
    fi
    local bin=""
    # Accept .bin next to .elf or same stem
    if [[ "$elf" == *.elf && -f "${elf%.elf}.bin" ]]; then
      bin="${elf%.elf}.bin"
    elif [[ -f "$elf" && "$elf" == *.bin ]]; then
      bin="$elf"
    fi
    if [[ -n "$bin" ]] && command -v esptool >/dev/null 2>&1; then
      local port="${LABWIRED_HW_PORT:-${LABWIRED_C3_PORT:-}}"
      [[ -n "$port" ]] || port="$(ls /dev/cu.usbmodem* /dev/ttyUSB* /dev/ttyACM* 2>/dev/null | head -1 || true)"
      [[ -n "$port" ]] || {
        echo "labwired probe flash: set LABWIRED_HW_PORT for esptool" >&2
        return 1
      }
      # Map free-form chip id → esptool --chip (generic ESP family backend)
      local chip_arg="esp32"
      case "$chip_lc" in
        *esp32c3*) chip_arg="esp32c3" ;;
        *esp32c6*) chip_arg="esp32c6" ;;
        *esp32s3*) chip_arg="esp32s3" ;;
        *esp32s2*) chip_arg="esp32s2" ;;
        *esp32h2*) chip_arg="esp32h2" ;;
        *esp8266*) chip_arg="esp8266" ;;
        *esp32*)   chip_arg="esp32" ;;
      esac
      echo "==> physical flash via esptool ($chip_arg)"
      esptool --chip "$chip_arg" -p "$port" -b 460800 write_flash 0x10000 "$bin" \
        || esptool --chip "$chip_arg" -p "$port" write_flash 0x0 "$bin"
      echo "claim: flashed via esptool — capture serial before hardware_observed"
      return 0
    fi
    echo "labwired probe flash: ESP chip needs PlatformIO project or esptool + .bin" >&2
    echo "    tip: cd project && pio run -t upload && labwired serial-capture …" >&2
  fi

  # Physical: probe-rs (STM32, nRF, …)
  local prs
  prs="$(labwired_resolve_probe_rs)" || {
    echo "labwired probe flash: probe-rs not found (labwired probe install-backend)" >&2
    return 1
  }
  echo "==> physical flash via probe-rs (not OpenOCD)"
  echo "    probe-rs: $prs"
  echo "    chip:     $chip"
  echo "    elf:      $elf"
  local args=(download --chip "$chip" --binary-format elf "$elf")
  if [[ -n "$probe_sel" ]]; then
    args+=(--probe "$probe_sel")
  fi
  "$prs" "${args[@]}"
  echo "claim: flashed via probe — still verify UART/behavior before hardware-confirmed"
}

labwired_probe_reset() {
  local chip="" target="auto" probe_sel=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --chip) chip="${2:-}"; shift 2 ;;
      --target) target="${2:-}"; shift 2 ;;
      --probe) probe_sel="${2:-}"; shift 2 ;;
      *) echo "usage: labwired probe reset --chip <name> [--target virtual|probe]" >&2; return 2 ;;
    esac
  done
  local mode
  mode="$(labwired_probe_resolve_target "$target")" || {
    echo "labwired probe reset: no backend" >&2
    return 1
  }
  if [[ "$mode" == "virtual" ]]; then
    echo "virtual reset: restart simulation via MCP labwired_run (no probe)"
    return 0
  fi
  local prs
  prs="$(labwired_resolve_probe_rs)" || return 1
  [[ -n "$chip" ]] || { echo "labwired probe reset: --chip required" >&2; return 2; }
  local args=(reset --chip "$chip")
  [[ -n "$probe_sel" ]] && args+=(--probe "$probe_sel")
  "$prs" "${args[@]}"
}

labwired_probe_install_backend() {
  # Install probe-rs into ~/.cargo/bin (bundled path for agent)
  if labwired_resolve_probe_rs >/dev/null 2>&1; then
    echo "probe-rs already present: $(labwired_resolve_probe_rs)"
    return 0
  fi
  if ! command -v cargo >/dev/null 2>&1; then
    echo "labwired: need Rust/cargo to install probe-rs, or install a release binary:" >&2
    echo "  https://probe.rs/docs/getting-started/installation/" >&2
    return 1
  fi
  echo "==> installing probe-rs (multi-probe backend; not OpenOCD)"
  cargo install probe-rs-tools --locked 2>/dev/null \
    || cargo install probe-rs --features cli --locked 2>/dev/null \
    || cargo install probe-rs-cli --locked 2>/dev/null \
    || {
      echo "labwired: cargo install failed — see https://probe.rs/docs/getting-started/installation/" >&2
      return 1
    }
  if [[ -x "${HOME}/.cargo/bin/probe-rs" ]]; then
    mkdir -p "${LABWIRED_BIN_DIR:-$HOME/.local/bin}"
    ln -sfn "${HOME}/.cargo/bin/probe-rs" "${LABWIRED_BIN_DIR:-$HOME/.local/bin}/probe-rs"
    echo "linked probe-rs → ${LABWIRED_BIN_DIR:-$HOME/.local/bin}/probe-rs"
  fi
  labwired_resolve_probe_rs
}

labwired_probe_cmd() {
  local sub="${1:-}"
  shift || true
  case "$sub" in
    ""|help|-h|--help) labwired_probe_usage ;;
    list|ls) labwired_probe_list "$@" ;;
    chips|chip) labwired_probe_chips "$@" ;;
    flash|download) labwired_probe_flash "$@" ;;
    reset) labwired_probe_reset "$@" ;;
    doctor|info) labwired_probe_backend_info "$@" ;;
    install-backend|install) labwired_probe_install_backend "$@" ;;
    rtt|rtt-capture)
      # labwired probe rtt-capture --chip X [--marker M]  → claim JSON or NEED_RTT
      # shellcheck source=lib/rtt-capture.sh
      source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/rtt-capture.sh"
      if [[ "$sub" == "rtt-capture" ]]; then
        labwired_rtt_capture "$@"
      else
        local chip=""
        while [[ $# -gt 0 ]]; do
          case "$1" in
            --chip) chip="${2:-}"; shift 2 || true ;;
            *) shift || true ;;
          esac
        done
        labwired_probe_rtt "$chip"
      fi
      ;;
    *)
      echo "labwired probe: unknown subcommand '$sub'" >&2
      labwired_probe_usage >&2
      return 2
      ;;
  esac
}


labwired_probe_rtt() {
  local chip="${1:-}"
  local prs
  if ! prs="$(labwired_resolve_probe_rs 2>/dev/null)"; then
    echo "probe rtt: probe-rs not installed — ./install.sh --full" >&2
    return 1
  fi
  echo "==> RTT via probe-rs ($prs)"
  if "$prs" rtt --help >/dev/null 2>&1 || "$prs" attach --help >/dev/null 2>&1; then
    echo "probe-rs supports RTT/attach. Example:"
    echo "  $prs attach${chip:+ --chip $chip}"
    echo "  # then use RTT channel for markers; promote with serial-capture-equivalent"
    echo "claim: RTT path available — capture marker before hardware_observed"
    return 0
  fi
  echo "probe-rs present but RTT subcommand not detected — use UART serial-capture" >&2
  return 1
}
