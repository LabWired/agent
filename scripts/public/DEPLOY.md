# Deploy Agent install endpoints

Publish these files as plain text with UTF-8 encoding on the landing site
(`labwired-landing-deck` / `astro/public/`):

| Public URL | Repository file |
|---|---|
| `https://labwired.com/install` | `scripts/public/install` |
| `https://labwired.com/install.ps1` | `scripts/public/install.ps1` |
| `https://labwired.com/agent-install.sh` | same body as `install` (legacy alias) |
| `https://labwired.com/agent-install.ps1` | same body as `install.ps1` (legacy alias) |

Public guides use these commands:

```bash
curl -fsSL https://labwired.com/install | bash
```

```powershell
irm https://labwired.com/install.ps1 | iex
```

Note: nested paths like `/install/agent` are not used on GitHub Pages; keep
flat URLs so macOS and Windows one-liners keep working.