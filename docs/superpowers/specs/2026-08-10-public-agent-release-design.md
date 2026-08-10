# Public LabWired Agent Release

**Date:** 2026-08-10

## Goal

Release LabWired Agent as a public product that is easy to install and use.
The release covers the agent only. LabWired Core and LabWired Editor are separate products.

## Product commands

LabWired uses one command with clear product names:

```text
labwired core     Run the simulator and core tools.
labwired agent    Start the firmware agent.
labwired editor   Start the editor.
```

Running `labwired` with no arguments shows short product help:

```text
LabWired

Start:
  labwired agent     Write and test firmware

Other tools:
  labwired core      Run the simulator
  labwired editor    Open the editor
```

The first public release implements `labwired agent`. It preserves `labwired core` and reserves `labwired editor`.

## Installation

Each product has its own one-line installer. A product installer does not install other optional products.

Install the agent:

```bash
curl -fsSL https://labwired.com/install/agent | bash
```

Install Core:

```bash
curl -fsSL https://labwired.com/install/core | bash
```

Install the editor:

```bash
curl -fsSL https://labwired.com/install/editor | bash
```

The agent installer installs the shared `labwired` command if it is missing. It then installs only the agent and the dependencies that the agent needs. It does not install the editor. It does not replace an existing Core installation.

The installer must be fast. It must not require a second install command. After it finishes, the user runs:

```bash
labwired agent
```

## Compatibility

The current Core simulator binary uses the name `labwired`. The new shared command must not break existing scripts.

Known legacy Core commands continue to work during the migration. For example, an existing `labwired test ...` command forwards to the Core component. New documentation uses `labwired core test ...`.

The shared command uses explicit component paths. It does not depend on PATH order to find Core or Agent.

Installation, update, and removal must preserve:

- User projects
- Login data
- Configuration that is not owned by the agent
- Core binaries and data
- Editor binaries and data
- Caches that another LabWired product owns

Removing the agent removes only agent-owned files.

## Agent behavior

The agent follows this task flow:

1. Understand the firmware task.
2. Identify the board and parts.
3. Write or repair the firmware.
4. Build the firmware.
5. Test the firmware on the LabWired twin.
6. Report the result in plain language.
7. Offer a physical-board test when it is useful.

The agent must not say that firmware works after only reading or building the code. It may report a passed twin test only when `labwired_verify` returns `model_verified`.

Internal evidence may include exact status names. The main user message explains the result in normal language.

Errors are short and include the next action. Example:

```text
The twin test could not start.

Run:
  labwired login

Then try again.
```

## Public documentation

The public package includes only documents that users and contributors need:

- `README.md`: purpose, one-line install, and first task
- `docs/INSTALL.md`: supported systems, update, removal, and troubleshooting
- `docs/USAGE.md`: common tasks with short examples
- `docs/VERIFY.md`: the meaning of a passed twin test
- `docs/DEVELOPMENT.md`: tests and contribution steps
- `CHANGELOG.md`: user-visible changes

Internal plans, internal screenshots, raw QA dumps, obsolete product documents, and unpublished assets are not part of the public package.

All public documents follow these rules:

- Use simple technical English.
- Keep sentences short.
- Put one main idea in each sentence.
- Use one term for each concept.
- Explain uncommon terms once.
- Put commands before long explanations.
- State limits clearly.
- Do not use internal marketing or engineering jargon.

## Release checks

The release must pass these checks:

1. Install on clean macOS, Linux, and Windows environments.
2. Install beside an existing LabWired Core without changing it.
3. Start with `labwired agent`.
4. Preserve known legacy Core commands during migration.
5. Complete one firmware task on the twin.
6. Reject false success claims.
7. Update the agent without deleting user data.
8. Remove only the agent.
9. Pass shell, JavaScript, configuration, and documentation checks.
10. Contain no secrets, private paths, internal QA dumps, or unpublished assets.

The test suite has five clear groups:

- Fast local tests
- Clean installation tests
- Live twin tests
- Optional physical-board tests
- Optional paid-model tests

A missing board or API key is reported as `not run`. It is not reported as passed.

## Public release scope

This work includes:

- The shared command behavior needed by `labwired agent`
- The one-line agent installer
- Safe coexistence with Core
- Agent update and removal behavior
- Agent instructions and skills
- Public agent documentation
- Public package contents
- Automated release checks

This work does not include:

- Shipping LabWired Editor
- Redesigning the editor interface
- Adding new simulator features
- Adding new board models
- Changing the hosted service product

Cursor, BootLoop, and Embedder are reference products. We may copy useful product patterns, such as a short install path, clear help, and outcome-first examples. We do not copy their code, names, or private assets.

## Success criteria

A new user can run one install command, start `labwired agent`, and complete a verified firmware task. An existing Core user can install or remove the agent without breaking Core. Public documentation is short, consistent, and written in simple technical English.
