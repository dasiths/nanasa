<!-- markdownlint-disable-file -->

# Terminal-Only Runtime Architecture Research

## Research scope

* Determine the smallest coherent architecture change that removes Copilot ACP, Pi RPC, `AgentAdapter`, `AgentRuntimeSupervisor`, semantic queue and steer delivery, adapter session state, and worker packaging.
* Preserve tmux and ttyd, terminal message injection, durable message outcomes, start, stop, start-all, interrupt, recovery, and the current SQLite state.
* Identify exact source, contract, portal, packaging, and test files to delete or modify.
* Define schema and database compatibility without legacy filesystem migration.
* Record implementation risks and focused validation needs.

## Findings

The smallest coherent boundary is a terminal-only runtime with four owners:

1. `TmuxRuntime` owns direct CLI launch, pane ownership, paste-and-Enter, Ctrl+C,
	 pane replacement, and owner-pane reconciliation.
2. `TtydSupervisor` and `TerminalEndpointRegistry` continue to own browser
	 terminal access and writer-conflict detection.
3. `RunRuntimeCoordinator` owns serialized start, stop, start-all, interrupt,
	 recovery, and daemon reconciliation without an adapter lifecycle.
4. `DeliveryDispatcher` remains only as a durable terminal-injection pump. It
	 retains SQLite leases, retries, expiry, membership revocation, generation
	 fencing, and dead letters, but removes capability negotiation, fallback,
	 adapter settlement, queue semantics, and steer semantics.

This is smaller and safer than replacing the dispatcher with immediate HTTP
delivery. Immediate delivery would lose queued persistence across stopped runs,
daemon restarts, concurrent daemon instances, writer conflicts, and transient
tmux failures.

`TmuxRuntime` already implements the required terminal primitives:

* Direct profile command launch for `terminal` profiles
* Verified pane ownership through run and generation tmux options
* Bounded paste through a temporary tmux buffer, bracketed paste, and a
	separate Enter key
* Ctrl+C interrupt
* Durable owner panes and deterministic linked ttyd view sessions

The adapter stack currently wraps these primitives and adds semantic workers.
`RunRuntimeCoordinator` can call the terminal primitives directly after the
adapter readiness, capability, session-resume, and shutdown branches are
removed.

The current database is a real compatibility case. Read-only inspection found:

* SQLite integrity is `ok`, with `PRAGMA user_version = 0`
* 3 profiles: one `copilot-cli`, one `pi-rpc`, and one `terminal`
* 4 run generations, 3 with adapter session columns populated
* 2 desired semantic runs whose live owner panes execute `node` workers
* 1 desired terminal run whose live owner pane executes its configured command
* 0 messages and deliveries, 1,403 domain events, and 7 idempotency records
* Agent-profile idempotency responses that contain adapter and capability fields

Ordinary reconciliation would incorrectly preserve the two worker panes because
their tmux ownership tags still match. The terminal-only migration must mark
those active generations for a one-time forced replacement before normal pane
reconciliation.

## Recommended change

### Runtime composition

Keep `DeliveryDispatcher`, but make it terminal-specific and inject the terminal
delivery service directly. Remove its `DeliveryTarget`, capability intersection,
mode fallback, `AdapterDeliveryResult`, asynchronous semantic settlement, and
adapter error vocabulary. A successful paste transitions the durable outcome to
`consumed`; this means terminal injection succeeded, not that the agent processed
the text. Failures retain the existing retry and dead-letter behavior.

Replace `TerminalAdapter` with a small `TmuxTerminalDelivery` service in a
renamed `terminal-delivery.ts`. It should expose only:

* `isAvailable(run)` for a current owned pane
* `deliver(claim)` for writer-conflict checking and paste-and-Enter
* `interrupt(run)` for Ctrl+C, or let the coordinator call
	`TmuxRuntime.interruptRun` directly

Construct the store, tmux runtime, terminal endpoint registry, ttyd supervisor,
terminal delivery service, terminal dispatcher, and coordinator in `server.ts`.
Remove adapter factories and adapter/dispatcher internals from `DaemonContext`.

### Lifecycle and recovery

Simplify `RunRuntimeCoordinator` as follows:

* `startRun` launches the configured profile command directly, creates its view
	session, and starts ttyd.
* `stopRun` stops ttyd, removes the linked view, then kills the owner pane. It no
	longer waits for adapter shutdown.
* `interrupt` validates a running generation and sends Ctrl+C to the verified
	owner pane. Map ownership or availability failures to a terminal-specific 503
	domain error rather than an adapter error.
* `reconcile` checks tmux ownership, replaces migration-marked worker panes,
	restores missing desired runs, rebuilds views, and reconciles ttyd. Mark a run
	recovered after the tmux/view/ttyd path succeeds; no adapter readiness gate
	remains.
* Recovery always enters `restarting`, never `resuming`, and creates a new run
	generation with the existing bounded attempts, cooldowns, desired-state
	checks, and generation fencing.
* `TmuxRuntime.recoverRun` no longer accepts `preserveAdapterSession`. It must
	safely kill a still-current migration-marked pane before creating the direct
	replacement, otherwise the legacy worker remains alive beside the new run.

`TmuxRuntime` should remove worker commands, runtime/state paths, worker socket
helpers, and adapter-based launch selection. It should always launch
`[profile.command, ...profile.args]` and apply the validated profile environment
to every agent kind, not only profiles formerly labeled `terminal`.

### Contracts and API

Remove these canonical contract concepts:

* Adapter kind, capability, readiness, and adapter status
* Recovery policy and adapter-session metadata
* Queue, steer, and effective delivery mode discovery
* Requested/applied delivery modes, fallback, adapter identity, adapter session
	ID, and adapter message ID

Keep message audience, intent, body, optional expiry, delivery status, attempts,
reason, timestamps, and recipient identity. `queued` remains a durable database
status, not a semantic delivery mode.

Remove `GET /api/runs/:runId/adapter` and
`POST /api/groups/:groupId/delivery-modes`. Keep the interrupt endpoint. Message
submission should always create terminal delivery work, so the portal no longer
needs a mode selector or discovery request.

For compatibility, the configuration loader should accept the old v1
`adapter`, `capabilities`, and `recovery` keys, validate their old shapes, and
project them out of the canonical `NanasaConfig`. This lets the current
`.nanasa/config.yaml` start unchanged. New templates should omit the retired
keys. Likewise, the message input parser can temporarily accept and discard a
legacy `delivery.mode` so old clients and idempotency responses remain readable,
while the inferred canonical type contains only `expiresAt`.

## File plan

### Delete daemon implementation files

* `apps/daemon/src/agent-adapter.ts`
* `apps/daemon/src/agent-runtime-supervisor.ts`
* `apps/daemon/src/copilot-acp-process.ts`
* `apps/daemon/src/copilot-cli-adapter.ts`
* `apps/daemon/src/copilot-cli-worker-client.ts`
* `apps/daemon/src/copilot-cli-worker-protocol.ts`
* `apps/daemon/src/copilot-cli-worker.ts`
* `apps/daemon/src/pi-jsonl.ts`
* `apps/daemon/src/pi-rpc-adapter.ts`
* `apps/daemon/src/pi-rpc-process.ts`
* `apps/daemon/src/pi-rpc-worker-client.ts`
* `apps/daemon/src/pi-rpc-worker-protocol.ts`
* `apps/daemon/src/pi-rpc-worker.ts`

Rename `apps/daemon/src/terminal-adapter.ts` to
`apps/daemon/src/terminal-delivery.ts` and retain only the tmux terminal delivery
service.

### Modify daemon and packaging files

* `apps/daemon/src/config.ts`: accept legacy config keys and emit the
	terminal-only canonical configuration
* `apps/daemon/src/delivery-dispatcher.ts`: hardwire durable terminal delivery
	and remove semantic modes, capabilities, fallback, and settlement
* `apps/daemon/src/index.ts`: remove adapter and supervisor exports
* `apps/daemon/src/run-runtime-coordinator.ts`: remove adapter lifecycle and mode
	discovery; use direct interrupt and restart-only recovery
* `apps/daemon/src/server.ts`: remove worker path discovery, adapter factories,
	semantic routes, and adapter context; wire terminal delivery directly
* `apps/daemon/src/store.ts`: keep durable lease/outcome operations, remove
	adapter-session APIs and writes, normalize terminal-only state, and add the
	one-time compatibility migration
* `apps/daemon/src/tmux-runtime.ts`: remove worker launch options/helpers, launch
	every profile command directly, and support forced replacement of a live
	legacy worker pane
* `scripts/build-package.mjs`: remove the `pi-rpc-worker` and
	`copilot-cli-worker` esbuild entry points

Do not manually edit generated `apps/*/dist`, `packages/contracts/dist`, or root
`dist` output. Run clean builds so stale worker files cannot survive in a
published package. The package build already removes root `dist` before bundling.

### Modify shared contracts, portal, configuration, and documentation

* `packages/contracts/src/index.ts`
* `templates/config.yaml`
* `apps/portal/src/api.ts`
* `apps/portal/src/App.tsx`
* `apps/portal/src/components/message-workspace.tsx`
* `apps/portal/src/styles.css` to remove unused delivery-mode and semantic
	warning styles
* `README.md`
* `apps/portal/README.md`

Do not rewrite `.nanasa/config.yaml`. Backward-compatible parsing is the safer
upgrade path and avoids changing operator-owned local configuration.

### Delete obsolete daemon tests

* `apps/daemon/test/agent-runtime-supervisor.test.ts`
* `apps/daemon/test/copilot-acp-compatibility.test.ts`
* `apps/daemon/test/copilot-acp-process.test.ts`
* `apps/daemon/test/copilot-cli-adapter.test.ts`
* `apps/daemon/test/copilot-cli-worker.test.ts`
* `apps/daemon/test/pi-jsonl.test.ts`
* `apps/daemon/test/pi-rpc-adapter.test.ts`
* `apps/daemon/test/pi-rpc-process.test.ts`
* `apps/daemon/test/pi-rpc-worker.test.ts`

Rename `apps/daemon/test/terminal-adapter.test.ts` to
`apps/daemon/test/terminal-delivery.test.ts`.

### Modify remaining tests

* `apps/daemon/test/config.test.ts`
* `apps/daemon/test/delivery-dispatcher.test.ts`
* `apps/daemon/test/run-runtime-coordinator.test.ts`
* `apps/daemon/test/server.test.ts`
* `apps/daemon/test/store.test.ts`
* `apps/daemon/test/terminal-proxy.test.ts`
* `apps/daemon/test/ttyd-manifest.test.ts`
* `apps/daemon/test/ttyd-runtime.test.ts`
* `apps/daemon/test/ttyd-supervisor.test.ts`
* `packages/contracts/test/contracts.test.ts`
* `apps/portal/src/api.test.ts`
* `apps/portal/src/App.test.tsx`
* `apps/portal/src/components/terminal-workspace.test.tsx`
* `test/package-cli.test.mjs`

## Database compatibility

Use an in-place, transactional SQLite migration. Do not create a new database,
copy records, search alternate paths, import worker session files, or move the
current `.nanasa/state/nanasa.sqlite` file. Retain the current additive
`CREATE TABLE IF NOT EXISTS` and column compatibility logic for older supported
database shapes.

Introduce a schema version with `PRAGMA user_version`. When upgrading from 0:

1. In one immediate transaction, identify desired active runs joined to profiles
	 whose stored adapter is `copilot-cli`, `pi-rpc`, or historical `copilot-sdk`.
2. Mark those generations with a durable `terminal_runtime_migration` recovery
	 reason, phase `reconciling`, no cooldown, and a reset migration recovery
	 attempt budget. This marker must survive a daemon crash before replacement.
3. Normalize persisted profiles to compatibility placeholders such as
	 `adapter = 'terminal'` and `capabilities_json = '[]'`. New profile inserts
	 write the same placeholders because the existing strict table columns are
	 `NOT NULL`, even though the canonical domain model no longer exposes them.
4. Normalize any `resuming` run phase to `restarting`. Preserve historical run
	 rows, IDs, generations, terminal bindings, timestamps, and domain events.
5. Reset pending delivery leases (`received` or `delivering`) to immediately
	 claimable terminal work. New and pending deliveries use terminal placeholder
	 values in the retained mode/adapter columns. Leave completed historical
	 outcomes and adapter identifiers intact for forensic continuity, but do not
	 hydrate them into the canonical API.
6. Set `PRAGMA user_version` only after all updates succeed.

The coordinator must consume the migration marker by stopping ttyd, removing the
linked view, verifying and killing the old owner worker pane, marking the old run
generation failed/replaced, and launching the configured CLI as a new generation.
After successful recovery, the normal recovery reason replaces the migration
marker. This avoids both preserving a worker pane and repeatedly restarting a
new terminal-only pane.

Keep `runs.adapter_session_id`, `runs.adapter_session_json`, and the delivery
adapter columns physically present in this release. Dropping them requires table
rebuilds, risks current state, and provides no runtime benefit. Stop writing and
reading them in domain hydration. The existing `.nanasa/state/copilot`,
`.nanasa/state/pi`, `.nanasa/runtime/copilot`, and `.nanasa/runtime/pi`
directories become inert orphaned state. Do not scan, migrate, or automatically
delete them.

Old agent-profile idempotency responses are compatible if the reduced profile
schema strips retired unknown fields. Old message-submission responses require a
legacy-input transform because the current nested delivery policy is strict.
Add a fixture containing old config, profile idempotency JSON, adapter session
columns, a `resuming` run, and pending queue/steer deliveries to prove startup,
snapshot hydration, replay, and terminal dispatch.

## Test plan

Replace semantic adapter coverage with tests at the surviving boundaries:

* Contracts accept legacy config and message mode fields as input but emit no
	adapter, capability, session, queue, or steer fields in canonical objects.
* Config loads the current old-style v1 file unchanged and loads the new minimal
	template.
* Store migration preserves IDs, rows, events, idempotency responses, run
	generations, and terminal bindings; marks active semantic runs exactly once;
	normalizes `resuming`; and does not touch session directories.
* Dispatcher leases once across concurrent ticks and database connections,
	retries writer conflicts and tmux failures, honors expiry and revocation,
	dead-letters at the cap, reclaims stale leases after restart, generation-fences
	delivery, and records successful injection as `consumed`.
* Terminal delivery verifies pane ownership, blocks injection while ttyd owns a
	writer, pastes body text, sends Enter separately, and rejects oversized input.
* Coordinator preserves stop ordering, start-all idempotency, direct Ctrl+C,
	bounded restart-only recovery, migration-forced replacement of an otherwise
	current worker pane, and no replacement after operator stop.
* Server keeps start, stop, start-all, interrupt, message submission, delivery
	outcome, snapshot, event, terminal status, and proxy routes; removed semantic
	routes return 404.
* Real tmux/ttyd smoke coverage continues to verify two-run isolation, daemon
	restart, ttyd crash recovery, owner-pane exit recovery, and cleanup. Add one
	message injection assertion through the REST API and one interrupt assertion.
* Portal tests verify a fixed terminal message flow without mode discovery,
	preserve audience and intent controls, and display durable outcome status and
	reason without requested/applied mode text.
* Package tests assert the generated config has no adapter/capability/recovery
	keys and packaged daemon output contains no worker entry files or ACP/Pi RPC
	implementation strings.

## Risks

* Forced migration restarts active Copilot and Pi workers, so in-flight prompts
	and resumable semantic sessions are intentionally lost. Preserve old rows and
	session directories for diagnosis, but do not resume them.
* Direct terminal injection has no semantic acknowledgement. `consumed` can only
	mean verified paste-and-Enter completion.
* A live ttyd browser writer blocks automated paste. Existing retries and dead
	letters remain necessary, and the portal should keep the warning concise.
* CLI behavior may differ from worker behavior. Copilot and Pi commands must
	start interactive TUIs with the stored command and arguments; reserved ACP/RPC
	flags must not be synthesized.
* A crash between profile normalization and run marking would preserve a worker
	pane forever. Both operations and `user_version` must be in one transaction,
	and the marker must be durable before reconciliation starts.
* Killing a pane by ID without ownership verification could terminate the wrong
	process after tmux ID reuse. Forced replacement must use the existing run and
	generation tmux options before kill.
* Removing API fields and routes is a breaking change for external clients. A
	short legacy request acceptance window reduces input breakage, but response
	consumers still need updating.
* Keeping obsolete SQLite columns is deliberate compatibility debt. A later
	opt-in compaction can rebuild tables only after backup and explicit operator
	consent.

## Clarifying questions

None. The requested preserved behavior can be implemented without retaining an
agent abstraction or worker process.
