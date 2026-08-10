# Install LabWired Agent

LabWired Agent supports macOS and Linux on x86-64 and Arm64. It also supports
Windows 10 and later with PowerShell 5.1 or later.

The Agent is optional. It does not install LabWired Core or the Editor. If Core
is already installed, both products use the same `labwired` command without
changing each other's files or data.

## Install on macOS or Linux

```bash
curl -fsSL https://labwired.com/install/agent | bash
```

## Install on Windows

Run PowerShell:

```powershell
irm https://labwired.com/install/agent.ps1 | iex
```

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
- On Windows, add `%USERPROFILE%\.local\bin` to `PATH`.
- Run `labwired agent doctor` and follow the first reported error.
- Run the install command again to repair or refresh the Agent.
