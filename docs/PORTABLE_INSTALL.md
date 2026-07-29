# Portable install — every platform, one model

One product, one prefix, thin PATH shims. Works the same way as rustup / uv-style toolchains.

## Platforms

| Platform | Installer | Local sim (`labwired-sim`) | probe-rs | Agent + skills |
|----------|-----------|----------------------------|----------|----------------|
| **macOS** arm64 / x64 | `install.sh` | prebuilt | prebuilt | yes |
| **Linux** x64 / arm64 | `install.sh` | prebuilt | prebuilt | yes |
| **Windows** x64 | `install.ps1` | when core publishes Windows build; else **hosted MCP** or **WSL** | prebuilt zip | yes |
| **WSL2** | same as Linux | prebuilt | prebuilt | yes |

Windows is a **first-class agent host**. Local twin binary is optional until `w1ne/labwired-core` ships `windows-x86_64` assets; until then `labwired_verify` goes through **hosted MCP** (same oracle, remote runner).

## One-liners

### macOS / Linux / **WSL2** (Cursor-style)

WSL2 is **Linux** for the installer. Use the Unix one-liner inside your distro
(Ubuntu, Debian, …) — **not** the Windows PowerShell installer.

```bash
# Inside WSL or native Linux/macOS (same as Cursor CLI):
curl -fsSL https://labwired.com/install | bash
source ~/.labwired/env.sh
labwired doctor --strict
labwired update
```

Requirements in WSL: `curl`, `bash`, Node 18+ (`npx` / OpenCode).  
`uname -s` → `Linux` → downloads `linux-x86_64` or `linux-aarch64` sim + probe-rs.

**USB / debug probes from WSL:** Windows owns the USB bus. Attach devices with
[usbipd-win](https://github.com/dorssel/usbipd-win), then `labwired probe list`
inside WSL. Serial ports often appear as `/dev/ttyUSB*` or `/dev/ttyACM*` after attach.

### Windows (PowerShell 5.1+) — native (Cursor-style)

```powershell
irm 'https://labwired.com/install?win32=true' | iex
. $HOME\.labwired\env.ps1
labwired doctor
labwired update
```

### Any platform with Node 18+

```bash
npx @labwired/agent
# or
npm i -g @labwired/agent
```

`npx` routes to `install.sh` or `install.ps1` automatically.

## Prefix layout (same idea everywhere)

```text
$LABWIRED_HOME/                 # default: ~/.labwired  or  %USERPROFILE%\.labwired
  agent/                        kit
  tools/sim/                    labwired-sim[.exe]
  tools/probe-rs/               probe-rs[.exe]
  tools/pio/                    optional
  bin/                          shims
  env.sh | env.ps1              activate
  MANIFEST.json
  cache/
```

Custom root:

```bash
./install.sh --prefix /opt/labwired
```

```powershell
.\scripts\install.ps1 -Prefix D:\tools\labwired
```

## Manage

| Action | Unix | Windows | Cursor equivalent |
|--------|------|---------|-------------------|
| **Self-update** | `labwired update` | `labwired update` | `agent update` |
| Tools only | `labwired update --tools-only` | `labwired install-deps` | — |
| Info | `labwired package info` | `labwired package info` | — |
| Path | `labwired package path` | `labwired package path` | — |
| Uninstall | `labwired package uninstall --yes` | `labwired package uninstall --yes` | — |

`labwired update` pulls the latest agent kit (git), re-runs the full installer into
`$LABWIRED_HOME`, and refreshes sim/probe/skills — same job as Cursor’s `agent update`.

## Windows vs WSL — pick one (or both)

| Goal | Use |
|------|-----|
| Windows IDE / native agent | `install.ps1` — hosted MCP twin until Windows sim ships |
| **Local twin + full Linux toolchain** | **WSL2 + Unix install** (recommended for local `labwired-sim`) |
| Physical probe from WSL | `usbipd` attach, then `probe-rs` inside WSL |

### WSL recommended path (local sim on Windows machines)

```powershell
# Windows once: install WSL + Ubuntu if needed
wsl --install
```

```bash
# Inside Ubuntu WSL — same as any Linux box
curl -fsSL https://labwired.com/agent-install.sh | sh
source ~/.labwired/env.sh
labwired doctor --strict
labwired-sim chips
```

Prefix lives in the **Linux home** (`\\wsl$\Ubuntu\home\<user>\.labwired`), not under `C:\Users\...\.labwired`. That is intentional: contained per environment.

### Windows native twin path (honest)

1. **Preferred when available:** local `labwired-sim.exe` in the prefix.
2. **Default today:** hosted MCP verify.
3. **Best local twin today:** WSL2 path above.

Agent authoring, skills, claim gates, and physical `probe-rs` flash all work on **native Windows**; full local oracle is easiest under **WSL** until core ships Windows prebuilts.

## Offline

```bash
./scripts/pack-portable.sh
# ship dist/labwired-agent-*-portable.tar.gz
# on target:
tar -xzf … && cd labwired-agent-* && ./install.sh --prefix …
# Windows: expand zip of the kit, then:
.\scripts\install.ps1 -Prefix $HOME\.labwired -Full
```

## Requirements

| | Unix | Windows |
|--|------|---------|
| Shell | bash | PowerShell 5.1+ |
| Node | 18+ (for OpenCode + MCP) | 18+ |
| Git | for curl bootstrap | for `agent-install.ps1` |
| Network | first install downloads sim/probe | downloads probe-rs (+ sim if published) |

## Relocate

Move the whole `$LABWIRED_HOME` tree, then re-run install with `-Prefix` / `--prefix` so shims and `env.*` rewrite, or edit `env.ps1` / `env.sh` and the user PATH shim.
