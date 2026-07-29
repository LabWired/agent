# Deploy install endpoints (Cursor-style)

Mirror Cursor’s CLI install URLs on labwired.com (or any CDN):

| Public URL | File in repo | Client |
|------------|--------------|--------|
| `https://labwired.com/install` | `scripts/public/install` | `curl -fsSL … \| bash` |
| `https://labwired.com/install?win32=true` | `scripts/public/install.ps1` | `irm … \| iex` |
| `https://labwired.com/install.ps1` | same | Windows alias |
| `https://labwired.com/agent-install.sh` | `scripts/agent-install.sh` or `public/install` | legacy alias |
| `https://labwired.com/agent-install.ps1` | `scripts/agent-install.ps1` or `public/install.ps1` | legacy |

## Suggested nginx / Cloudflare Worker logic

```text
GET /install
  if query win32=true  →  text/plain  install.ps1
  else                 →  text/plain  install  (bash)

GET /install.ps1       →  install.ps1
```

Serve with `Content-Type: text/plain; charset=utf-8` (PowerShell `irm` expects script body).

## Docs one-liners (ship these)

```bash
# macOS / Linux / WSL
curl -fsSL https://labwired.com/install | bash
```

```powershell
# Windows
irm 'https://labwired.com/install?win32=true' | iex
```

```bash
# After install
labwired update
labwired doctor --strict
```
