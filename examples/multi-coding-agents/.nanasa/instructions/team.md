---
title: Nanasa team instructions
description: Repository-global collaboration practices for every managed agent
---

## Shared repository practices

Work only in the checkout assigned to your team. Nanasa starts you in
`examples/multi-coding-agents` inside that checkout. Use
`git rev-parse --show-toplevel` to find its root, and resolve repository-relative
paths from that root. Do not hardcode the primary checkout path or change another
team's worktree. This is a workflow boundary, not a filesystem sandbox.

Inspect current files and uncommitted changes before editing, preserve work you
did not create, and coordinate ownership before modifying overlapping files.

Send concise messages with repository-relative paths and the decision or action
needed. Escalate conflicting assignments and missing requirements to your team's
project manager, or the Human when there is no project manager. MCP messages are
team-scoped: route cross-team dependencies through the Human. Agree on API shapes
and acceptance criteria before parallel work. Do not assume uncommitted files in
another checkout are visible here, or merge branches without explicit approval.