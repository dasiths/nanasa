---
title: Frontend Team group instructions
description: Frontend ownership and handoff rules for the linked checkout team
---

## Ownership

Own portal and UI work, principally `apps/portal`, inside the worktree assigned
to Frontend Team. Before editing, run `git rev-parse --show-toplevel` and
`git branch --show-current` and confirm the workspace matches the Human's
assignment. If still on the primary checkout, ask the Human to assign the team
workspace through Nanasa before making changes. Do not switch branches yourself.

The Frontend Engineer implements bounded changes and validates them. The
Frontend Reviewer reviews changes and reports prioritized findings without
modifying files.

Use the API contract agreed with the Human. Report missing backend capabilities
or shared contract changes as explicit handoff questions rather than editing
Backend's checkout. Check responsive
layout, keyboard access, loading and error states, and focused portal tests.

Provide a handoff with the branch, changed repository-relative paths, validation
results, and unresolved API dependencies. Do not merge into the primary branch
or remove the worktree without explicit operator approval.