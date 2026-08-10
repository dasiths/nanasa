<!-- markdownlint-disable-file -->
---
description: Implementation plan for native adapters, repository configuration, recovery, messaging, and portal operations
applyTo: "**"
---

# Adapter, Configuration, and Recovery Plan

## User Requests

* Implement native Pi RPC queue, steer, interrupt, completion, and resume.
* Implement GitHub Copilot CLI messaging and session resume without the Copilot SDK.
* Harden ttyd lifecycle with manifests and process identity validation.
* Simplify messaging choices and ensure selected agents support offered modes.
* Preserve universal tmux send-keys message delivery with bracketed paste and a
  separate Enter key for every running agent.
* Add `.nanasa/config.yaml` for agent types and startup commands.
* Move state under `.nanasa` for repository-local and npm-distributed use.
* Recover running sessions after portal or daemon restart and offer restart only
  when continuation is impossible.
* Add group Start All.
* Add persisted light/dark mode and terminal tab/grid preference.

## Architecture

Configuration and contracts are implemented before adapters. Adapters share one
dispatcher and capability model. Recovery uses tmux as process truth, adapter
session IDs as conversation truth, and ttyd manifests as terminal-provider
identity evidence.

## Checklist

### Phase 1: `.nanasa` configuration and messaging contracts
<!-- parallelizable: false -->

* [x] Add strict YAML configuration schemas and repository-root discovery.
* [x] Add default `.nanasa/config.yaml`, repository-local state paths, and
  ignore rules.
* [x] Add agent-type keys, adapter kinds, recovery policies, and capabilities.
* [x] Reduce structured delivery to queue and steer with deterministic fallback.
* [x] Add explicit terminal-input delivery as a universal live-pane transport
  capability, separate from native queue and steer capabilities.
* [x] Add adapter session, desired-state, recovery, and delivery transition
  contracts and migrations.

### Phase 2: Adapter framework and dispatcher
<!-- parallelizable: false -->

* [x] Implement adapter interfaces, capability resolution, durable delivery
  claims, transitions, retries, and settlement.
* [x] Implement terminal adapter queue delivery and privileged interrupt action.
* [x] Add adapter lifecycle supervision and recovery hooks.

### Phase 3: Pi RPC adapter
<!-- parallelizable: true -->

* [x] Implement strict JSONL process framing and backpressure.
* [x] Implement prompt, follow-up, steer, abort, settlement, and session resume.
* [x] Add Pi capability, recovery, crash, and delivery tests.

### Phase 4: Copilot CLI ACP adapter
<!-- parallelizable: true -->

* [x] Remove the partial Copilot integration and its library dependency.
* [x] Spawn only the installed `copilot --acp --stdio` CLI and implement strict
  ACP NDJSON framing, initialization, session creation/loading, prompts, cancel,
  streamed updates, completion, and resume.
* [x] Advertise only delivery modes supported by the CLI protocol. Queue is
  required; steer must deterministically fall back to queue unless the installed
  ACP server proves a supported mid-turn operation.
* [x] Add permission cancellation policy, process recovery, and CLI adapter tests.

### Phase 5: Recovery and ttyd hardening
<!-- parallelizable: false -->

* [x] Add desired-state reconciliation and resume-or-restart behavior.
* [x] Add atomic ttyd PID manifests and Linux identity validation.
* [x] Add safe stale-manifest handling and crash recovery tests.
* [x] Add group Start All operation and outcomes.

### Phase 6: Portal operations and preferences
<!-- parallelizable: false -->

* [x] Load configured agent types in profile creation.
* [x] Show only delivery modes supported by selected recipients.
* [x] Add recovery status, restart action, and group Start All.
* [x] Add persisted theme and terminal layout with cross-tab synchronization.

### Phase 7: Integration and packaging validation
<!-- parallelizable: false -->

* [x] Validate adapters, delivery settlement, daemon restart, resume fallback,
  manifests, Start All, and portal preferences.
* [x] Validate production and development browser workflows.
* [x] Validate npm package contents and clean-repository startup.
* [x] Update documentation, changes, and review artifacts.

## Package Registry

Every package-manager operation must source `.devcontainer/.env` and preserve
its registry variables. Public npm registry overrides are prohibited.

## Success Criteria

* `.nanasa/config.yaml` controls available agent types and startup argv.
* Repository state lives under `.nanasa/state` and survives daemon restart.
* Pi and Copilot messages reach native CLI sessions with durable outcomes.
* Unsupported delivery modes are not offered by the portal.
* Every running tmux-backed agent offers explicit Terminal input delivery, which
  pastes the message and sends Enter without claiming semantic processing.
* Future MCP `message.send` and `message.broadcast` tools can select terminal
  delivery through the same authenticated message command used by the portal.
* Existing live runs reconnect or resume; restart is offered only after recovery
  fails.
* ttyd manifests never signal an identity-mismatched PID.
* Group Start All is idempotent and reports per-member outcomes.
* Theme and terminal layout survive reload and synchronize across tabs.