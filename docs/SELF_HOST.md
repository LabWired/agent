# LabWired Agent — Self-host and airgap

## Profiles

| Profile | Config | Network |
|---------|--------|---------|
| Hosted (default after login) | `opencode.hosted.json` | api.labwired.com MCP + model |
| Local BYO | env model URL/key | optional remote MCP |
| **Airgap** | `config/opencode.airgap.json` | no cloud; local MCP entry required |

## Airgap requirements

1. Set `LABWIRED_PROFILE=airgap` (or install with airgap mode if provided).
2. Provide a **local MCP entry** so tools are not the hosted URL:
   - `LABWIRED_MCP_ENTRY` — path or command for the local MCP server (e.g. `npx @labwired/mcp` or a vendored `mcp/vendor/index.js`).
3. Local model: set `LABWIRED_MODEL_URL` + `LABWIRED_MODEL_KEY` (or provider keys your airgap config expects).

Without `LABWIRED_MCP_ENTRY` (or an equivalent local MCP binary), **doctor / install must fail closed** — do not silently fall back to cloud.

## What still may need cloud

- Device login / account entitlement for hosted model gateway  
- Hosted part-knowledge / datasheet corpus (unless you mirror it offline)  
- CI builders that target builder.labwired.com  

Airgap Agent is for **local twin + local tools**, not a full clone of every hosted knowledge object.

## Checks

```bash
# Fail closed when airgap without MCP entry
LABWIRED_PROFILE=airgap bash tests/airgap-install.sh

# Security contact
grep -q security@labwired.com docs/SECURITY.md
```

See [SECURITY.md](./SECURITY.md) and [PORTABLE_INSTALL.md](./PORTABLE_INSTALL.md).
