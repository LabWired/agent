# Portable install

## One line (that’s it)

```bash
# macOS / Linux / WSL2
curl -fsSL https://labwired.com/install | bash
```

```powershell
# Windows
irm https://labwired.com/install.ps1 | iex
```

Then run `labwired`. Re-run the same line to **update**.

No `source`, no extra PATH steps — the installer puts a shim on your PATH
(`~/.local/bin` or user PATH on Windows).

---

## What you get

```text
~/.labwired/          # or %USERPROFILE%\.labwired
  agent/              kit (skills, catalog, scripts)
  tools/sim/          labwired-sim
  tools/probe-rs/     probe-rs
  bin/                shims
  env.sh | env.ps1    optional activate
  MANIFEST.json
```

## Optional flags

| Flag | Meaning |
|------|---------|
| `--prefix DIR` | Custom root |
| `--minimal` | Kit only (no sim download) |
| `--airgap` | Vendored MCP (no npx) |
| `--with-pio` | Include PlatformIO (slower) |

```bash
curl -fsSL https://labwired.com/install | bash -s -- --prefix /opt/labwired
```

## Platforms

| Platform | Installer | Local sim |
|----------|-----------|-----------|
| macOS / Linux / WSL2 | bash one-liner | prebuilt |
| Windows | PowerShell one-liner | when published; else hosted MCP |

WSL: run the **bash** line inside the distro. USB probes: [usbipd-win](https://github.com/dorssel/usbipd-win).

## Deploy public URLs

See [scripts/public/DEPLOY.md](../scripts/public/DEPLOY.md).
