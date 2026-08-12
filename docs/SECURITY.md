# LabWired Agent — Security

Contact: **security@labwired.com**

## Tokens and sessions

- Cloud session: `~/.labwired/session/cloud.json` (access + refresh tokens). Treat as a password.
- Never commit tokens, paste them into public issues, or log full Bearer headers.
- Hosted MCP and model gateway use the same account session as `labwired agent login`.
- Revoke / re-login if a machine is lost: `labwired agent logout` then login again.

## Prompt and tool exfiltration

- The agent can call hosted `labwired_*` tools and local shell tools. Do not put secrets in project prompts that will be sent to the model.
- Prefer environment variables and the session file over pasting keys into chat.
- Skills that say **never invent** (pins, registers, green claims) reduce false confidence — they do not replace access control.

## Desk flash risk

- `labwired probe flash` writes real silicon when a physical probe is attached.
- Prefer twin prove (`model_verified`) before desk promote (`hardware_observed`).
- Never treat desk success as twin green (dual-claim rule).

## Reporting

Email **security@labwired.com** for vulnerabilities. Do not open public issues for exploitable flaws without coordinated disclosure.

## Related

- [SELF_HOST.md](./SELF_HOST.md) — airgap / self-host posture  
- [LEGAL.md](./LEGAL.md) — Privacy & Terms  
