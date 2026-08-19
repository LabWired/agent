# shellcheck shell=bash
# Canonical pack classification for the labwired harness.
# Sourced by tests/skills-inventory.sh and tests/harness-portable.sh.
# UNIVERSAL_PACKS: SKILL.md-standard packs installable into any agent host.
# OPENCODE_ONLY_PACKS: packs about the opencode config surface; never
# installed by a universal/foreign path.
UNIVERSAL_PACKS=(
  golden-path develop bringup prove observe desk-hw import-circuit
  using-superpowers brainstorming test-driven-development systematic-debugging
  verification-before-completion writing-plans executing-plans writing-skills
  dispatching-parallel-agents subagent-driven-development requesting-code-review
  receiving-code-review finishing-a-development-branch using-git-worktrees
)
OPENCODE_ONLY_PACKS=(
  customize-labwired-agent
)
