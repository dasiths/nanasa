<!-- markdownlint-disable-file -->
---
title: Integration isolation research
description: Final design for repository-local coding-agent homes and lifecycle commands
ms.date: 2026-08-11
ms.topic: concept
---

## Scope

Nanasa must configure supported coding agents without writing provider-global
settings or hooks. Agent types need configurable shared or member-isolated homes,
and installed-package users need setup, authentication, and diagnostic commands.

## Selected design

* `agentConfigHome` defaults to `{ scope: agent-type }`.
* Supported scopes are `agent-type`, `member`, and `custom`.
* Custom paths are relative to `.nanasa/integrations` and may use only
  `{agentType}` and `{membershipId}` placeholders.
* All Nanasa-generated provider files live beneath `.nanasa/integrations`.
* Provider-global homes are never used for Nanasa-generated files.
* Authentication uses each provider's native interactive client inside the
  selected isolated home or inherited token environment variables.
* No compatibility migration, provider-default mode, or legacy cleanup command
  is required for this proof-of-concept project.

## Evidence

* GitHub documents `COPILOT_HOME` as replacing the complete `~/.copilot` tree,
  including hooks, MCP configuration, plugins, permissions, logs, and sessions.
* GitHub documents `COPILOT_CACHE_HOME` as the separate cache override.
* Claude supports `CLAUDE_CONFIG_DIR`.
* Pi supports `PI_CODING_AGENT_DIR`.
* OpenCode requires its config variables plus XDG data, state, and cache roots
  for full provider-state isolation.
* The existing runtime provisioner already controls each managed process
  environment after profile environment merging.

## Success criteria

* No managed launch writes Nanasa files beneath the user's normal provider home.
* Shared homes persist across members and restarts for one configured agent type.
* Member homes persist across run generations for one membership.
* Setup is idempotent and updates only Nanasa-owned repository files.
* Auth launches the configured provider in its selected isolated home.
* Doctor validates configuration, executables, and private integration paths.
