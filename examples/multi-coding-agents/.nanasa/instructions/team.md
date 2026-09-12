---
title: Shared project conventions
description: Repository practices shared by team members and the repository Foreman
---

## Shared repository practices

The starting directory is `examples/multi-coding-agents`, not the Git root. Use
`git rev-parse --show-toplevel` to find its root, and resolve repository-relative
paths from there. Do not hardcode the primary checkout path.

Inspect current files and uncommitted changes before editing, preserve work you
did not create, and coordinate ownership before modifying overlapping files.

Agree on shared API shapes and acceptance criteria before parallel work. Do not
assume uncommitted files in another checkout are visible here, or merge branches
without explicit Human approval.