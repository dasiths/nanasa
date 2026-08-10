<!-- markdownlint-disable-file -->
---
title: Adapter, configuration, and recovery implementation details
description: Phase operations and validation gates for the second Nanasa increment
author: Nanasa
ms.date: 2026-08-10
ms.topic: reference
---

## Context

* Plan: `.copilot-tracking/plans/2026-08-10/adapters-config-recovery-plan.instructions.md`
* Research: `.copilot-tracking/research/2026-08-10/adapters-config-recovery-research.md`
* Existing ttyd migration remains authoritative for terminal rendering.

## Configuration

Use `yaml` v2 with `parseDocument`, YAML 1.2, duplicate-key rejection, alias
limits, one-document validation, strict Zod schemas, and a bounded file size.
Discover the repository root by walking upward for `.nanasa/config.yaml`, then
fall back to the Git root.

Keep YAML agent types authoritative. Profiles and groups remain operator-managed
SQLite state under `.nanasa/state`, allowing repository-specific runtime data
without forcing config edits for every portal operation.

## Adapter Runtime

Use a shared `AgentAdapter` interface and a serialized delivery lane per run.
Adapters expose capabilities, state, delivery, interrupt, reconcile, and close.
No database transaction remains open while waiting on an external process.

Native capabilities remain `queue` and `steer`. `terminal` is a separate
universal delivery mode resolved from a current running tmux pane. It uses a
unique buffer loaded through stdin, bracketed paste, and a separate Enter key.
It is consumed after verified injection and has no semantic processed
settlement.

The future MCP surface should map a `terminal` channel selection to
`delivery.mode: terminal` rather than implementing another input path. Agent
senders remain subject to active membership and run validation, and group
broadcast fan-out excludes the sender.

## Recovery

Persist adapter session identifiers and delivery cursors. Reconciliation first
checks the owner tmux pane, then adapter state, then ttyd. Operator stop fences
all pending recovery callbacks.

## Universal Terminal Delivery

Explicit `terminal` delivery is resolved independently from native adapter
readiness. The runtime verifies the stored server, session, window, pane, run
ID, and generation before loading a unique tmux buffer, pasting with bracketed
paste enabled, and sending Enter separately. Known ttyd writers cause retry and
eventual dead-letter handling without converting the request to queue.

The portal requests effective modes whenever its audience or recipient
selection changes. Native queue and steer capabilities are intersected across
ready adapters. Terminal input is added only when every selected recipient has
a current running pane, and it remains separate from Terminal Mode keyboard
input.

## Validation Gates

1. Configuration parser and repository-local state tests
2. Delivery dispatcher and capability tests
3. Pi framing and adapter tests
4. Copilot CLI ACP framing, fake-process, and compatibility tests
5. Real tmux/ttyd recovery and manifest tests
6. Portal unit and browser tests
7. Full repository and package validation

## Phase 2 Implementation Log

Phase 2 completed on 2026-08-10 with the following bounded decisions and
deviations:

* Pi RPC and Copilot CLI remain injectable factories without concrete adapters,
	as required for this phase.
* Terminal queue delivery becomes `consumed` after verified tmux injection and
	remains unprocessed because terminal output is not a semantic acknowledgement.
* Delivery claims require an active membership and running recipient run. Work
	without a running recipient remains queued without consuming an attempt.
* Known ttyd WebSocket writers block terminal injection. External tmux clients
	are outside the daemon's writer registry, while owner-pane identity is still
	fenced through run ID and generation pane metadata.
* Terminal delivery uses a unique tmux buffer loaded through stdin, bracketed
	paste, and a separate Enter key. Unsafe or unavailable panes retry through the
	dispatcher rather than receiving blind input.

## Phase 3 Implementation Log

Phase 3 completed on 2026-08-10 with these architecture decisions and
validation results:

* Each `pi-rpc` run launches one generation-fenced worker in its authoritative
	tmux pane. The worker owns the only Pi RPC subprocess; ttyd renders concise
	worker lifecycle and delivery events instead of a second Pi conversation.
* Daemon IPC uses a `0600` Unix socket below a `0700` runtime directory. Every
	request carries the run ID and generation. Pi argv, cwd, and profile
	environment travel through the socket during initialization and are retained
	only in worker memory.
* Graceful daemon shutdown disconnects from the worker without terminating Pi.
	Operator stop sends worker shutdown before stopping ttyd, removing the view,
	and killing the owner pane.
* The worker deduplicates immutable delivery IDs and retains bounded settlement
	history. Reconnecting adapters replay authoritative `agent_settled` batches
	into SQLite, including the consumed-before-daemon-crash window.
* Session IDs and validated absolute session files are persisted through run
	store methods and domain events. Session storage is member-scoped below
	`.nanasa/state/pi` so a surviving worker remains conversation-authoritative
	across daemon and browser restarts.
* Pi command responses mark delivery acceptance. Queue maps to `prompt` while
	idle and `follow_up` while busy; steer maps to `prompt` while idle and `steer`
	while busy. The interrupt API has no replacement prompt, so it sends `abort`
	and awaits settlement only when Pi is busy.
* Strict framing splits only on LF, strips an optional CR, preserves Unicode
	line separators and fragmented UTF-8, bounds records and stderr, rejects
	malformed protocol output, and waits for writable-stream drain.
* An offline `get_state` smoke against installed Pi 0.83.0 succeeded and
	returned a persisted session, but provider and model were `unknown` in this
	environment. The adapter reports `pi_model_unavailable` and does not accept
	delivery in that state.
* Validation passed for focused Pi tests, the full workspace test suite,
	typecheck, lint, format check, and production build.

## Phase 4 Implementation Log

Phase 4 completed on 2026-08-10 with these protocol and capability decisions:

* The authoritative Copilot process is the installed
	`copilot --acp --stdio` CLI. Nanasa implements bounded ACP NDJSON and JSON-RPC
	directly and has no separate protocol or integration library dependency.
* The client offers ACP protocol version 1 with filesystem and terminal client
	capabilities disabled. The installed CLI accepted an initialize-only probe;
	the probe did not create a session or send a model prompt.
* The installed ACP surface remains a preview integration boundary. It exposes
	prompt and cancel operations but no proven mid-turn steering operation, so the
	adapter advertises queue only and the shared dispatcher falls back from steer
	to queue.
* One generation-fenced worker in the owner tmux pane owns the ACP process.
	Queue delivery is acknowledged after the prompt request frame is written and
	settled from the prompt response stop reason. Reconnects replay bounded
	settlements.
* Persisted ACP session identifiers are loaded when supported. Failed or
	unsupported loads create a replacement session under the configured
	resume-or-restart policy and persist its exact identifier.
* Permission requests receive a cancelled outcome. Other unsupported client
	requests receive an explicit JSON-RPC method-not-found error.

## Phase 5 Implementation Log

Phase 5 completed on 2026-08-10 with these recovery and process-identity
decisions:

* Persisted `desiredState=running` remains authoritative when the daemon
	restarts. Reconciliation validates the generation-owned tmux pane, reconnects
	the adapter and ttyd when it survives, or starts one replacement generation
	when it is missing.
* Recovery persists `reconciling`, `resuming`, `restarting`, `recovered`, and
	`failed` transitions as domain events. Replacement generations carry adapter
	session metadata only for `resume-or-restart`; `restart` starts without
	semantic session metadata.
* Automatic recovery allows three persisted attempts. Failed launches wait for
	cooldowns of 1 second, 5 seconds, and 30 seconds. Exhaustion leaves the latest
	run in recovery phase `failed` until an operator action. Operator stop changes
	desired state to `stopped` even when the latest generation already failed,
	fencing late adapter and recovery callbacks.
* ttyd manifests live in the configured runtime directory under `ttyd`. Writes
	use a `0600` temporary file, file sync, rename, and best-effort Linux directory
	sync beneath a `0700` directory. Scans accept at most 256 files of 64 KiB each
	and reject symlinks, path escapes, wrong ownership or mode, malformed content,
	oversized files, and unsupported schema versions.
* Each manifest records the run generation, endpoint key and base path, PID,
	Linux start ticks, executable path and device/inode, UID, exact launch argv,
	exact observed `/proc` argv, tmux server and view session, binding fingerprint,
	and creation time. It never records environment variables, tokens, or upstream
	credentials.
* ttyd mutates `--client-option name=value` argv storage in place on Linux. Spawn
	validation accepts only the exact launch argv or that specific observed
	`name`, `value` split. Later identity checks compare the exact observed argv
	from the manifest, preventing a broader normalization from weakening PID reuse
	protection.
* Orphan adoption is intentionally disabled. Node cannot acquire a safe child
	handle, reap lifecycle state, or recover ttyd's ephemeral upstream port from an
	inherited process. Startup therefore signals only an exact manifest-to-`/proc`
	identity match, records whether the process was an otherwise adoptable active
	run or stale binding, removes the manifest, and starts a replacement. A PID,
	executable, start-time, UID, inode, or argv mismatch is never signaled.
* `POST /api/groups/:groupId/runs/start-all` starts active members in stable
	member order, reports `started`, `already-running`, or `failed` per member,
	continues after failures, and shares the coordinator serialization lane with
	stop, membership removal, and reconciliation. Persisted idempotency keys replay
	one operation outcome and never create duplicate runs.
* Focused recovery, Start All, store, manifest, supervisor, API, and real
	tmux/ttyd tests passed (37 tests). Full validation passed workspace typecheck,
	144 tests (25 contracts, 101 daemon, and 18 portal), ESLint, Biome format
	check, production build, and the real tmux/ttyd smoke. The smoke covers daemon
	reconnection, ttyd crash replacement, desired-running owner-pane generation
	replacement, endpoint recovery, and operator stop cleanup.

## Phase 6 Implementation Log

Phase 6 completed on 2026-08-10 with these portal decisions and validation
results:

* The portal loads `/api/config` separately from the snapshot and validates it
	with `NanasaConfigSchema`. Configuration failures use a dedicated blocking
	state so profile creation never falls back to hardcoded agent kinds.
* Profile creation lists every configured agent type by display name and key.
	Existing profile choices and member metadata also expose the configured name
	and key. Tests cover a future custom key and the `claude-copilot` payload.
* Start All uses one browser-generated idempotency key for each in-flight group
	operation. The selected-group header remains disabled until completion, and an
	announced result panel reports started, already-running, and failed members
	with failure reasons before refreshing the snapshot.
* Member status distinguishes reconciling, resuming, restarting, recovered, and
	failed recovery. Active continuation exposes Stop instead of Start. Retry uses
	the existing run API only when continuation cannot proceed, which creates a
	new generation and resets bounded recovery attempts; no dedicated retry
	endpoint was needed.
* Light, dark, and system theme selection and terminal tab or grid layout share
	the versioned `nanasa.portal.preferences.v1` key. The saved theme applies before
	React mounts, system mode follows `matchMedia`, and storage events synchronize
	open tabs. Malformed or unavailable storage falls back without disabling
	controls.
* Terminal Mode and Message Mode remain separate. The effective-mode composer
	continues to offer explicit Terminal input only when every selected recipient
	has a current pane, and its direct paste-and-Enter warning remains covered.
* Focused portal validation passed 34 tests. Full validation passed workspace
	typecheck, 160 tests (25 contracts, 101 daemon, and 34 portal), ESLint, Biome
	format check, and production build.
* Package-manager commands loaded `.devcontainer/.env`; resolved npm and Corepack
	registry hostname was `packagefeedproxy.microsoft.io`.
* Long-running desktop, mobile, cross-tab, and live ttyd browser checks remain
	deferred to Phase 7 as planned.

## Phase 7 Implementation Log

Phase 7 completed on 2026-08-10 with these package and integration decisions:

* The repository root is the distributable unscoped `nanasa` package. It exposes
	an executable `nanasa` bin, requires Node.js 22 or later, and publishes only
	the CLI, bundled daemon, production portal, config template, README, license,
	and package metadata.
* esbuild bundles daemon code and `@nanasa/contracts` into separate daemon,
	Pi worker, and Copilot worker entry points. Fastify, WebSocket, YAML, and Zod
	remain normal runtime dependencies installed by npm. The package does not
	depend on workspace layout or unpublished workspace packages.
* `nanasa init` discovers an existing config or Git root upward from the current
	directory and creates `.nanasa/config.yaml` with an exclusive write. It does
	not create or overwrite state. `nanasa start`, also the default command,
	discovers config upward, sets the package portal path, checks `ttyd --version`,
	and forwards termination signals to the daemon child.
* ttyd remains a system or devcontainer prerequisite. The npm archive does not
	include a native ttyd binary. The validated version remains 1.7.7.
* A clean tarball install created config without state, started on a random
	loopback port, served health and portal HTML, returned parsed config, created
	a group and Copilot profile, persisted SQLite only below the temporary
	repository, and stopped both CLI and daemon after `SIGTERM`.
* The final npm dry-run contained 29 files, measured 398,707 bytes compressed
	and 847,459 bytes unpacked, and preserved executable mode on `bin/nanasa.js`.
	It excluded source maps, tests, tracking files, environment files, local data,
	`.nanasa/state`, and `node_modules`.
* Payload scans found no private registry URLs, credentials, local workspace
	paths, source-map references, or unresolved `@nanasa/contracts` imports.
* Integration coverage now recreates both Pi and Copilot factories after an
	adapter-supervisor restart while preserving explicit terminal delivery for
	both native runs. Existing tests already cover Start All idempotency, recovery
	resume fallback, malformed preferences, and storage-event synchronization.
* Full validation passed typecheck, 161 workspace tests, 3 package CLI tests,
	ESLint, Biome format check, production build, package build, npm pack dry-run,
	and the real tmux/ttyd recovery smoke. Package-manager commands used registry
	hostname `packagefeedproxy.microsoft.io`.
* Final browser acceptance remains an orchestrator handoff: production desktop
	and 390 by 844 mobile layout, cross-tab theme and terminal-layout sync, Start
	All result rendering, recovery controls, live ttyd tab/grid interaction, and
	Vite `/api` plus `/terminals` same-origin proxying. No long-running server or
	fixture process remains.

Known limitations remain the preview Copilot ACP surface, ttyd 1.7.7 compatibility
scope, non-semantic terminal injection settlement, and pending native OpenCode
and Claude Code adapters.