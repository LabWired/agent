# Deploy Agent install endpoints

Publish these files as plain text with UTF-8 encoding:

| Public URL | Repository file |
|---|---|
| `https://labwired.com/install/agent` | `scripts/public/install` |
| `https://labwired.com/install/agent.ps1` | `scripts/public/install.ps1` |

Public guides use these commands:

```bash
curl -fsSL https://labwired.com/install/agent | bash
```

```powershell
irm https://labwired.com/install/agent.ps1 | iex
```
