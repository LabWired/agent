# Install LabWired Agent

Native Agent support is continuously checked on GitHub-hosted macOS, Ubuntu,
and Windows runners. Windows 10 and later requires PowerShell 5.1 or later.
Release evidence records the runner architecture in `platform.txt`; an
installer code path by itself is not evidence that a particular architecture
was exercised.

The Agent is optional. It does not install LabWired Core or the Editor. If Core
is already installed, both products use the same `labwired` command without
changing each other's files or data.

## Install on macOS or Linux

```bash
curl -fsSL https://labwired.com/install | bash
```

Legacy aliases also work: `https://labwired.com/agent-install.sh`

## Install on Windows

Run PowerShell:

```powershell
irm https://labwired.com/install.ps1 | iex
```

Legacy aliases also work: `https://labwired.com/agent-install.ps1`

The Agent and hosted workflow run natively on Windows. When a matching native
simulator release is unavailable, use hosted verification or WSL for local
twin simulation. The install evidence records simulator and probe availability
instead of treating optional hardware tooling as present.

Start the Agent after installation:

```bash
labwired agent
```

## Update

```bash
labwired agent update
```

The update changes Agent-owned files only.

## Check the installation

```bash
labwired agent doctor
```

Warnings explain optional tools or services that are not available. An error
means the Agent needs attention.

## Remove

```bash
labwired agent package uninstall --yes
```

Removal deletes Agent-owned files. It keeps Core, shared tools, login data, and
unknown files in the LabWired directory.

## Troubleshooting

- If `labwired` is not found, open a new terminal and try again.
- If that does not help, add `$HOME/.local/bin` to `PATH` on macOS or Linux.
- The Windows installer normally adds `%LOCALAPPDATA%\LabWired\bin` to your user
  `PATH`. Add that directory manually if the command is still unavailable.
- Run `labwired agent doctor` and follow the first reported error.
- Run the install command again to repair or refresh the Agent.

## Use with other agents

The LabWired harness is a standard Agent Skills pack (SKILL.md format). Any
agent host that understands the format can load it.

### Skills

With the Vercel skills CLI (supports 40+ agents):

```bash
npx skills add LabWired/agent
```

Or copy the `skills/` directory into your host's skills directory by hand;
that also copies `customize-labwired-agent`, which you can skip.

`customize-labwired-agent` documents the LabWired Agent's own runtime
configuration and is not useful to other hosts.

The `observe` and `desk-hw` packs additionally need the LabWired Agent CLI
installed (`labwired agent …` on PATH). The other packs and the MCP tools
work without it.

### Instructions

`config/AGENTS.md` is host-agnostic. Use it as your host's instruction file
(AGENTS.md, CLAUDE.md, or equivalent), or merge its claim-vocabulary section
into your existing one: twin verification comes only from `labwired_verify`,
desk hardware claims only from physical hardware with independently captured
evidence, and a build is never a behavior proof. The exact evidence statuses
are defined in `config/AGENTS.md` and [docs/VERIFY.md](VERIFY.md).

### MCP server

Firmware tooling (`labwired_compile`, `labwired_verify`, knowledge tools) is
served over MCP. Add the server to your host's MCP configuration:

```json
{
  "mcpServers": {
    "labwired": {
      "command": "npx",
      "args": ["-y", "@labwired/mcp"]
    }
  }
}
```

For the hosted variant (authenticated tools, twin verification), first run
`labwired agent login` with the LabWired Agent installed, then point your host
at the hosted endpoint instead:

```json
{
  "mcpServers": {
    "labwired": {
      "url": "https://api.labwired.com/mcp?toolNames=unprefixed",
      "headers": { "Authorization": "Bearer <token from labwired agent login>" }
    }
  }
}
```

Hosts differ in envelope: Claude Code expects `"type": "http"` on the entry,
and opencode uses its own top-level `mcp` key with the same URL. The token is
read from the session file at `~/.labwired/session/cloud.json` after
`labwired agent login`. It expires after about an hour, and a foreign host
cannot refresh it; re-run the LabWired Agent to renew.

Hosts without MCP support can still use the skills and instructions, but no
firmware tool calls are possible there.
