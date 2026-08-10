---
title: Adapter, configuration, recovery, and packaging changes
description: Durable change inventory for the native adapter and npm distribution increment
author: Nanasa
ms.date: 2026-08-10
ms.topic: reference
---

## Related plan

`.copilot-tracking/plans/2026-08-10/adapters-config-recovery-plan.instructions.md`

## Package distribution

* Made the root `nanasa` package publishable with Node.js engine, license,
  repository, issue, homepage, keyword, dependency, bin, and file metadata
* Added an executable `nanasa` CLI with init, default start, host, port, ttyd
  path, help, and version handling
* Added upward config and Git-root discovery, exclusive config initialization,
  ttyd preflight, package portal resolution, and child signal forwarding
* Added an esbuild package pipeline that bundles daemon contracts and workers,
  externalizes installable runtime dependencies, and copies Vite portal assets
* Added a safe default config template and package CLI regression tests
* Added npm prepack lifecycle and an archive allowlist for 29 runtime files

## Integration coverage

* Added restart coverage for Pi and Copilot factory selection with universal
  terminal delivery available to both native adapters
* Reused existing Start All, recovery fallback, delivery settlement, manifest,
  malformed preference, and storage-event synchronization tests
* Extended ESLint Node globals and Biome file coverage to package scripts/tests

## Documentation and repository policy

* Documented npm installation, init/start behavior, repository-local config and
  state, environment variables, authentication prerequisites, and ttyd setup
* Documented adapters, messaging, recovery, Start All, theme/layout preferences,
  package validation, and current limitations
* Kept `.nanasa/config.yaml` committable while ignoring `.nanasa/state/` and
  `.nanasa/runtime/`

## Package boundaries

The archive includes the CLI, three daemon bundles, production portal assets,
the config template, README, license, and package metadata. It excludes source,
tests, source maps, tracking files, environment files, repository runtime state,
local data, and `node_modules`.

ttyd is not bundled. It remains a native system or devcontainer dependency and
is checked before daemon startup.

## Browser acceptance

* Started the packaged CLI from an isolated repository with three dynamic agent
  type keys: `alpha`, `beta`, and `claude-copilot`
* Added Alpha and Beta terminal fixtures through the portal and confirmed that
  Start All reported two started agents with no failures
* Sent a group broadcast through explicit Terminal input and confirmed that both
  delivery records reached `consumed` on the first attempt
* Captured both tmux panes and confirmed that each fixture received the message
  followed by Enter
* Confirmed light, dark, and system theme selection, reload persistence, and
  cross-tab synchronization
* Confirmed tabbed and grid terminal layouts, reload persistence, and cross-tab
  synchronization
* Confirmed the 390 by 844 viewport has no horizontal overflow, compact header
  controls do not overlap, and grid terminals stack vertically
* Restarted the isolated packaged daemon while preserving its tmux panes and
  confirmed both runs recovered at generation 1 with their original pane IDs

The VS Code forwarded browser tunnel did not restore event WebSocket upgrades
after the daemon listener restarted. A direct WebSocket client opened the same
endpoint and replayed all persisted events, so daemon event recovery passed and
the remaining browser badge behavior was classified as a remote tunnel
limitation.

## Known limitations

* GitHub Copilot CLI ACP is a preview protocol boundary
* ttyd 1.7.7 is the validated compatibility target
* Terminal input confirms paste and Enter injection, not model processing
* OpenCode and Claude Code native structured adapters remain pending