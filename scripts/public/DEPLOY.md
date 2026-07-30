# Deploy install endpoints (Cursor-style)

Public URLs on labwired.com:

| URL | Serves |
|-----|--------|
| `https://labwired.com/install` | `scripts/public/install` |
| `https://labwired.com/install.ps1` | `scripts/public/install.ps1` |
| `https://labwired.com/install?win32=true` | same as install.ps1 |
| `https://labwired.com/agent-install.sh` | alias → install |

```bash
# Docs — only these two lines
curl -fsSL https://labwired.com/install | bash
irm https://labwired.com/install.ps1 | iex
```

Serve as `text/plain; charset=utf-8`.
