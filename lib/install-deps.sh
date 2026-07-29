#!/usr/bin/env bash
# install-deps.sh — install runtime tools into the portable LABWIRED_HOME prefix.
# shellcheck shell=bash
#
# Contained: binaries live under $LABWIRED_HOME/tools/*, shims in $LABWIRED_HOME/bin.
# Portable: set LABWIRED_HOME to any writable path (USB, project-local, CI cache).
# Multi-platform: darwin/linux × x86_64/aarch64 prebuilts for sim; probe-rs cargo/install.

# Requires: prefix.sh sourced first (labwired_prefix_* helpers).

labwired_deps_say() { printf '\033[36m==>\033[0m %s\n' "$1"; }
labwired_deps_warn() { printf '\033[33mwarn:\033[0m %s\n' "$1" >&2; }
labwired_deps_ok() { printf '\033[32mok \033[0m %s\n' "$1"; }

labwired_deps_ensure_rust() {
  if command -v cargo >/dev/null 2>&1; then
    return 0
  fi
  if [[ "${LABWIRED_INSTALL_RUST:-1}" != "1" ]]; then
    labwired_deps_warn "cargo missing and LABWIRED_INSTALL_RUST=0"
    return 1
  fi
  labwired_deps_say "installing Rust toolchain (rustup) — used only to build probe-rs if needed"
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --no-modify-path
  # shellcheck disable=SC1090
  . "${HOME}/.cargo/env" 2>/dev/null || export PATH="${HOME}/.cargo/bin:${PATH}"
  command -v cargo >/dev/null 2>&1
}

# Place sim under $LABWIRED_HOME/tools/sim and shim in bin/
labwired_deps_install_sim() {
  local home tools bin cache repo version plat archive url tmp dest
  home="$(labwired_prefix_home)"
  tools="$home/tools/sim"
  bin="$home/bin"
  cache="$home/cache"
  mkdir -p "$tools" "$bin" "$cache"

  # Prefer monorepo-built CLI when present (has newer chip models than GH prebuild)
  local mono=""
  for mono in \
    "${LABWIRED_CORE_CLI:-}" \
    "${LABWIRED_CORE_SRC:-}/target/release/labwired" \
    "${HOME}/Projects/labwired/core/target/release/labwired" \
    "${HOME}/Projects/labwired-emit-ts/core/target/release/labwired"
  do
    [[ -n "$mono" && -x "$mono" ]] || continue
    # Always refresh if monorepo binary is newer than installed
    if [[ ! -x "$tools/labwired-sim" ]] || [[ "$mono" -nt "$tools/labwired-sim" ]]; then
      cp "$mono" "$tools/labwired-sim"
      chmod +x "$tools/labwired-sim"
      echo "local-monorepo" >"$tools/VERSION"
      labwired_deps_ok "simulator from monorepo → $tools/labwired-sim"
    else
      labwired_deps_ok "simulator already in prefix (monorepo not newer)"
    fi
    ln -sfn "$tools/labwired-sim" "$bin/labwired-sim"
    ln -sfn "$tools/labwired-sim" "$bin/labwired-cli"
    return 0
  done

  if [[ -x "$tools/labwired-sim" ]]; then
    labwired_deps_ok "simulator already in prefix: $tools/labwired-sim"
    ln -sfn "$tools/labwired-sim" "$bin/labwired-sim"
    ln -sfn "$tools/labwired-sim" "$bin/labwired-cli"
    return 0
  fi
  # Honor explicit LABWIRED_CLI if it points at a real binary
  if [[ -n "${LABWIRED_CLI:-}" && -x "${LABWIRED_CLI}" ]]; then
    cp "${LABWIRED_CLI}" "$tools/labwired-sim"
    chmod +x "$tools/labwired-sim"
    ln -sfn "$tools/labwired-sim" "$bin/labwired-sim"
    ln -sfn "$tools/labwired-sim" "$bin/labwired-cli"
    labwired_deps_ok "copied LABWIRED_CLI into prefix tools/sim"
    return 0
  fi

  if ! labwired_prefix_platform_supported; then
    labwired_deps_warn "no prebuilt sim for $(labwired_prefix_platform) — set LABWIRED_CLI or build core"
    return 1
  fi

  repo="${LABWIRED_CORE_REPO:-w1ne/labwired-core}"
  version="${LABWIRED_CORE_VERSION:-latest}"
  plat="$(labwired_prefix_platform)"

  if [[ "$version" == "latest" ]]; then
    labwired_deps_say "resolving latest LabWired sim release (${repo})"
    version="$(curl -fsSL "https://api.github.com/repos/${repo}/releases/latest" \
      | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -1)"
  fi
  if [[ -z "$version" ]]; then
    labwired_deps_warn "could not resolve sim release tag"
    return 1
  fi

  archive="labwired-${version}-${plat}.tar.gz"
  url="https://github.com/${repo}/releases/download/${version}/${archive}"
  labwired_deps_say "downloading simulator ${version} (${plat}) into prefix"
  tmp="$(mktemp -d)"
  if ! curl -fsSL --retry 3 -o "${cache}/${archive}" "$url"; then
    labwired_deps_warn "prebuilt sim download failed: $url"
    rm -rf "$tmp"
    return 1
  fi
  tar -xzf "${cache}/${archive}" -C "$tmp"
  dest="$(find "$tmp" -type f \( -name labwired -o -name labwired-cli -o -name labwired-sim \) | head -1)"
  if [[ -z "$dest" || ! -f "$dest" ]]; then
    labwired_deps_warn "archive missing labwired binary"
    rm -rf "$tmp"
    return 1
  fi
  cp "$dest" "$tools/labwired-sim"
  chmod +x "$tools/labwired-sim"
  ln -sfn "$tools/labwired-sim" "$bin/labwired-sim"
  ln -sfn "$tools/labwired-sim" "$bin/labwired-cli"
  rm -rf "$tmp"
  # Record pin for portable redistributes
  echo "$version" >"$tools/VERSION"
  labwired_deps_ok "simulator → $tools/labwired-sim (${version})"
  return 0
}

labwired_deps_install_probe_rs() {
  local home tools bin prs
  home="$(labwired_prefix_home)"
  tools="$home/tools/probe-rs"
  bin="$home/bin"
  mkdir -p "$tools" "$bin"

  if [[ -x "$tools/probe-rs" ]]; then
    labwired_deps_ok "probe-rs already in prefix: $tools/probe-rs"
    ln -sfn "$tools/probe-rs" "$bin/probe-rs"
    return 0
  fi

  # Reuse system / cargo install if present — copy into prefix (contained)
  if command -v probe-rs >/dev/null 2>&1; then
    cp "$(command -v probe-rs)" "$tools/probe-rs"
    chmod +x "$tools/probe-rs"
    ln -sfn "$tools/probe-rs" "$bin/probe-rs"
    labwired_deps_ok "probe-rs copied into prefix from PATH"
    return 0
  fi
  if [[ -x "${HOME}/.cargo/bin/probe-rs" ]]; then
    cp "${HOME}/.cargo/bin/probe-rs" "$tools/probe-rs"
    chmod +x "$tools/probe-rs"
    ln -sfn "$tools/probe-rs" "$bin/probe-rs"
    labwired_deps_ok "probe-rs copied into prefix from cargo"
    return 0
  fi

  labwired_deps_say "installing probe-rs into prefix (ST-Link / J-Link / CMSIS-DAP / …)"
  # Official installer often lands in ~/.cargo/bin — then we copy in.
  # Official install script (downloads prebuilt when available)
  if curl -fsSL https://github.com/probe-rs/probe-rs/releases/latest/download/probe-rs-tools-installer.sh 2>/dev/null \
    | bash 2>/dev/null; then
    :
  fi
  if [[ -x "${HOME}/.cargo/bin/probe-rs" ]]; then
    cp "${HOME}/.cargo/bin/probe-rs" "$tools/probe-rs"
    chmod +x "$tools/probe-rs"
    ln -sfn "$tools/probe-rs" "$bin/probe-rs"
    labwired_deps_ok "probe-rs → $tools/probe-rs"
    return 0
  fi
  if command -v probe-rs >/dev/null 2>&1; then
    cp "$(command -v probe-rs)" "$tools/probe-rs"
    chmod +x "$tools/probe-rs"
    ln -sfn "$tools/probe-rs" "$bin/probe-rs"
    labwired_deps_ok "probe-rs → $tools/probe-rs"
    return 0
  fi

  # Cargo compile is slow — only when not in fast mode
  if [[ "${LABWIRED_FAST:-1}" == "1" ]]; then
    labwired_deps_warn "probe-rs not found (fast install skips cargo build)"
    return 1
  fi
  if ! labwired_deps_ensure_rust; then
    labwired_deps_warn "cannot install probe-rs without cargo"
    return 1
  fi
  # shellcheck disable=SC1090
  . "${HOME}/.cargo/env" 2>/dev/null || export PATH="${HOME}/.cargo/bin:${PATH}"
  local cargo_root
  cargo_root="$home/cache/cargo-probe"
  mkdir -p "$cargo_root"
  if CARGO_HOME="${cargo_root}/home" cargo install probe-rs-tools --locked --root "$cargo_root" \
    || cargo install probe-rs-tools --locked; then
    if [[ -x "${cargo_root}/bin/probe-rs" ]]; then
      cp "${cargo_root}/bin/probe-rs" "$tools/probe-rs"
    elif [[ -x "${HOME}/.cargo/bin/probe-rs" ]]; then
      cp "${HOME}/.cargo/bin/probe-rs" "$tools/probe-rs"
    else
      return 1
    fi
    chmod +x "$tools/probe-rs"
    ln -sfn "$tools/probe-rs" "$bin/probe-rs"
    labwired_deps_ok "probe-rs → $tools/probe-rs (cargo)"
    return 0
  fi
  labwired_deps_warn "probe-rs install failed"
  return 1
}

labwired_deps_install_pio() {
  local home tools bin
  home="$(labwired_prefix_home)"
  tools="$home/tools/pio"
  bin="$home/bin"
  mkdir -p "$tools" "$bin"

  if [[ -x "$bin/pio" ]]; then
    labwired_deps_ok "PlatformIO shim already in prefix bin"
    return 0
  fi
  if command -v pio >/dev/null 2>&1; then
    # Wrapper that calls system pio — still one place for PATH
    cat >"$bin/pio" <<'EOF'
#!/usr/bin/env bash
exec "$(command -v pio 2>/dev/null || true)" "$@"
EOF
    # Prefer absolute if we can resolve now
    if command -v pio >/dev/null 2>&1; then
      cat >"$bin/pio" <<EOF
#!/usr/bin/env bash
exec "$(command -v pio)" "\$@"
EOF
    fi
    chmod +x "$bin/pio"
    labwired_deps_ok "PlatformIO linked into prefix bin"
    return 0
  fi

  if ! command -v python3 >/dev/null 2>&1; then
    labwired_deps_warn "python3 missing — skip PlatformIO"
    return 1
  fi

  labwired_deps_say "installing PlatformIO into prefix tools/pio (contained venv)"
  if python3 -m venv "$tools/venv" 2>/dev/null; then
    # shellcheck disable=SC1091
    if "$tools/venv/bin/pip" install -U pip platformio 2>/dev/null; then
      ln -sfn "$tools/venv/bin/pio" "$bin/pio"
      labwired_deps_ok "pio → $tools/venv/bin/pio"
      return 0
    fi
  fi
  labwired_deps_warn "PlatformIO install failed (optional)"
  return 1
}

labwired_install_full_deps() {
  local fail=0
  labwired_prefix_ensure_dirs

  if [[ "${LABWIRED_MINIMAL:-0}" == "1" ]]; then
    labwired_deps_say "LABWIRED_MINIMAL=1 — skipping sim/probe/pio"
    labwired_prefix_write_env
    return 0
  fi

  # Parallel-ish: sim download is the long pole; probe is usually copy/quick zip.
  if [[ "${LABWIRED_INSTALL_SIM:-1}" == "1" ]]; then
    labwired_deps_install_sim || fail=1
  fi
  if [[ "${LABWIRED_INSTALL_PROBE_RS:-1}" == "1" ]]; then
    # Prefer fast path; cargo compile is last resort and slow — skip if
    # LABWIRED_FAST=1 and probe missing after copy/installer attempt.
    if ! labwired_deps_install_probe_rs; then
      if [[ "${LABWIRED_FAST:-1}" == "1" ]]; then
        labwired_deps_warn "probe-rs skipped (fast mode) — later: labwired update --tools-only"
      else
        fail=1
      fi
    fi
  fi
  # PIO is slow (venv + pip) — off by default for one-liner installs
  if [[ "${LABWIRED_INSTALL_PIO:-0}" == "1" ]]; then
    labwired_deps_install_pio || true
  else
    labwired_deps_say "skip PlatformIO (set LABWIRED_INSTALL_PIO=1 to include)"
  fi

  labwired_prefix_write_env
  # shellcheck disable=SC1090
  source "$(labwired_prefix_home)/env.sh" 2>/dev/null || true
  return "$fail"
}
