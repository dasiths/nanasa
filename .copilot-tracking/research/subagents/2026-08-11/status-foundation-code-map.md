<!-- markdownlint-disable-file -->
---
title: Agent Status Foundation Backend Code Map
description: Implementation-focused research for the smallest daemon and contracts path to agent status tracking
---

## Research Scope

Investigate the smallest backend implementation path for the agent-status
foundation described in
`.copilot-tracking/research/2026-08-11/agent-status-tracking-research.md`.

Questions:

* Which exact files and symbols own contracts, SQLite schema and snapshots,
  MCP authentication and tools, HTTP routes, run coordination, and tmux
  lifecycle evidence?
* Which migration strategy fits the current SQLite schema and legacy adapter
  columns?
* Where should status reduction, generation fencing, and attention-event
  publication occur?
* What process-exit evidence is available from tmux today, and what is missing?
* What are the smallest MCP tool and HTTP ingestion shapes?
* Which focused tests and validation commands cover the proposed slice?
* Which restart and compatibility risks must the implementation handle?

## Findings

### Smallest coherent backend slice

The smallest coherent slice uses the existing run capability, SQLite store,
domain-event publication, and tmux reconciliation. It needs two new runtime
modules and focused additions to five existing implementation files:

* `packages/contracts/src/index.ts`
  * Add public status enums and `AgentStatusSummarySchema`,
    `AgentStatusDetailSchema`, and a strict normalized
    `AgentStatusEventInputSchema`.
  * Add an optional `agentStatuses` array to `PortalSnapshotSchema`. The daemon
    should always emit it, but keeping it optional avoids forcing portal fixture
    and consumer changes before the portal status phase.
  * Do not add raw hook payloads or reducer-private open-operation sets to the
    public contracts.
* `apps/daemon/src/agent-status-reducer.ts` (new)
  * Add a pure `reduceAgentStatus(previous, observation, context)` function.
  * Keep open tool IDs, open wait IDs, probe count, and lease state in an
    internal reducer-state type. Persist that type as JSON so restart does not
    erase correlation state.
* `apps/daemon/src/store.ts`
  * Raise `DATABASE_SCHEMA_VERSION` from 1 to 2 and split schema-version steps.
  * Add status event/current tables, lifecycle seeding, ingestion, reads,
    deduplication, retention, generation fences, and status-domain-event
    publication.
  * Extend `getSnapshot()` with compact status summaries synthesized for every
    active membership.
  * Delete status rows before deleting runs in `deleteGroup()`.
* `apps/daemon/src/agent-status-routes.ts` (new)
  * Add `registerAgentStatusRoutes()` for a dedicated loopback-only ingestion
    route with its own payload and rate limits.
  * Reuse `McpCredentialIssuer.authenticate()` and reject operator principals.
* `apps/daemon/src/server.ts`
  * Register the status route with the same credential issuer used by MCP.
  * No reporter provisioning is required for the foundation. Add a reporter URL
    to the runtime environment only when harness reporters are implemented.
* `apps/daemon/src/mcp-server.ts`
  * Register `nanasa.list_agent_statuses` and `nanasa.get_agent_status` as
    read-only tools. Reuse `targetGroup()` and the existing MCP rate limiter.
  * Query dedicated store methods instead of hydrating `getSnapshot()` for each
    tool call.
* `apps/daemon/src/tmux-runtime.ts`
  * Extend pane reconciliation with ownership fields and retained process-exit
    formats. Record process evidence before recovery replaces the run.
  * Treat tmux query failure separately from an authoritative missing pane.
* `apps/daemon/src/run-runtime-coordinator.ts`
  * Keep lifecycle serialization in `#serialize()`.
  * Reconcile lease expiry after tmux evidence is recorded and before missing
    runs are replaced. The coordinator should call store/reducer operations,
    not contain status transition rules itself.

`apps/daemon/src/mcp-auth.ts` does not need a credential-format change.
`McpAgentPrincipal` already contains `groupId`, `memberId`, `runId`, and
`generation`, and `#authenticateAgent()` verifies active membership, desired
state, run status, and the latest active generation. Renaming
`McpCredentialIssuer` to a generic capability issuer would create broad churn
without improving the first slice.

`apps/daemon/src/agent-runtime-provisioner.ts` is the later reporter injection
point. Its per-membership directories are private and persistent, but phase 1
does not need to modify generated Copilot, Claude Code, Pi, or OpenCode files.

### Public and normalized contracts

Retain the researched public dimensions exactly:

```text
state: not_started | starting | working | waiting | idle |
       suspected_stuck | stopped | crashed
phase: startup | model | tool | retry | compaction | permission | question |
       plan_approval | settled | exited
outcome: unknown | succeeded | failed | cancelled
confidence: high | medium | low
attention: none | input_required | decision_required | reporter_stale |
           progress_stale | process_failed
```

The external ingestion contract should normalize vendor hooks before they
reach the reducer. A strict discriminated union is smaller and safer than
teaching the reducer every Claude, Copilot, Pi, and OpenCode event name:

```text
harness_ready
activity_started
tool_started / tool_finished
wait_opened / wait_closed
retry_scheduled
settled
fatal
transport_heartbeat
```

Every event includes a required `eventId`, `source`, and `kind`; an optional
source timestamp; and bounded correlation metadata. `tool_started` and
`tool_finished` require `toolId`. Wait events require `requestId`; an open wait
also requires `waitKind`, a bounded summary, and `replyChannel`. Tool arguments,
prompts, results, transcripts, and reasoning are not accepted.

The daemon supplies identity and `observedAt`. The body cannot contain
`runId`, `generation`, `groupId`, or `memberId`. Source timestamps are evidence
metadata only and never advance leases because a local process can retry old
events or have a skewed clock.

Process observations are trusted internal inputs, not accepted from the HTTP
route:

```text
spawn_requested | process_alive | process_exited | pane_missing |
operator_stop_requested | daemon_reconciled
```

`AgentStatusSummary` should include member identity, alias, agent type, current
run ID/generation, existing `runStatus`, state, phase, confidence, attention,
state age, last activity, and last progress summary. `AgentStatusDetail` adds
outcome, leases, open wait, process exit fields, bounded evidence, and recent
transitions. Keeping `runStatus` beside semantic `state` avoids pretending that
process liveness proves useful work.

### Reducer boundary and precedence

`reduceAgentStatus()` should be deterministic and side-effect free. The store
loads the current public record and private reducer state, invokes the reducer
inside the write transaction, and persists both results. The reducer does not
query SQLite, publish events, inspect authentication, or call tmux.

Reducer-private state must include sets or maps for open tool IDs and wait IDs.
Completion closes only the matching ID. A late `tool_finished` cannot settle a
newer tool, and unrelated activity cannot clear an outstanding wait.

Apply this precedence:

1. Confirmed process death or owned-pane disappearance
2. Explicit fatal or clean terminal result
3. Any unresolved interaction request
4. Explicit work, retry, compaction, queue, or background activity
5. Explicit settled event
6. Lease expiry plus two active no-progress probes
7. Terminal output hints

Operator stop intent overrides unexpected-exit classification. An operator
stop produces `stopped` with `outcome=cancelled`, even if the subsequent pane
death has a signal. A desired-running run that exits, including exit status 0,
is `crashed` unless a clean terminal event was already recorded. Exit status 0
does not prove task success.

During the foundation-only phase, an existing live pane with no semantic
reporter must not be called `working` or `idle`. Keep it in startup with low
confidence and expose `runStatus=running` plus `tmux.process_alive` evidence.
After the startup lease, set `attention=reporter_stale`; do not infer
`suspected_stuck`. Semantic reporters in phase 2 resolve this bootstrap state.

### SQLite migration strategy

The current migration has one versioned step and a separate legacy-column
normalizer. A direct change of `DATABASE_SCHEMA_VERSION` to 2 is unsafe:
`#migrateTerminalRuntime()` compares `user_version` to the current constant, so
a version-1 database would rerun the version-1 terminal migration before the
new step.

Refactor `#migrate()` into ordered steps:

1. Read `PRAGMA user_version` and reject values greater than 2 before any DDL or
   compatibility updates.
2. Run the existing baseline `CREATE TABLE IF NOT EXISTS` block and
   `#migrateLegacyColumns()`.
3. If the original version is below 1, run the current terminal-only migration
   unchanged and set `user_version=1` in its transaction.
4. Re-read the version. If below 2, run `#migrateAgentStatusFoundation()` in one
   transaction and set `user_version=2`.

Use these minimal version-2 tables:

```sql
CREATE TABLE agent_status_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL,
  run_id TEXT NOT NULL REFERENCES runs(id),
  generation INTEGER NOT NULL,
  source TEXT NOT NULL,
  kind TEXT NOT NULL,
  source_occurred_at TEXT,
  observed_at TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  UNIQUE (run_id, generation, event_id)
) STRICT;

CREATE TABLE agent_status_current (
  run_id TEXT PRIMARY KEY REFERENCES runs(id),
  generation INTEGER NOT NULL,
  status_json TEXT NOT NULL,
  reducer_state_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE INDEX agent_status_events_run_sequence
  ON agent_status_events (run_id, generation, sequence);
```

The current record can stay JSON-backed because list reads are bounded by group
membership and the application must parse the public schema anyway. Do not add
duplicated query columns until a measured query needs them.

Do not backfill guessed semantic history. `createRun()` should seed `starting`
inside the existing run-created transaction. For a migrated database,
`listAgentStatuses()` can synthesize `not_started`, stopped, and failed records
from membership/latest-run data, while startup reconciliation seeds current
records for live or missing active runs.

Cap detailed status observations per run, for example at 256 rows, after each
successful insert. Do not persist one process event per one-second reconcile;
record the first alive observation, material liveness changes, and exits. The
materialized current record retains the latest process-seen time. This prevents
status storage from becoming an unbounded transcript.

`agent_task_reports` and `nanasa.report_progress` belong to the later progress
phase. Omitting that unused table from version 2 is the smallest foundation and
allows a version-3 migration to introduce its final contract together with the
write tool.

### Legacy adapter-column constraints

The adapter columns are compatibility storage, not canonical domain state:

* `agent_profiles.adapter` and `capabilities_json` remain `NOT NULL` and are
  normalized to `terminal` and `[]` by the version-1 migration.
* `runs.adapter_session_id` and `adapter_session_json` remain in SQLite but are
  projected out by `AgentRunSchema` and `#hydrateRun()`.
* Delivery adapter/session columns remain for historical completed rows and are
  cleared only for pending delivery during the terminal migration.
* Idempotency response JSON can still contain old adapter fields; canonical
  Zod transforms remove them when replayed.

Do not drop, rename, or use these columns to select a status reporter. Current
rows usually say `terminal` even when the profile kind is Copilot, Pi, OpenCode,
or Claude Code. Reporter selection must use canonical `profile.kind` and
`agentType`. A table rebuild to remove legacy columns would risk foreign keys,
idempotent response replay, historical delivery assertions, and existing
migration tests.

### Transactional generation fencing and deduplication

HTTP authentication is necessary but not sufficient. There is an
authenticate-then-write race if recovery replaces a run between
`McpCredentialIssuer.authenticate()` and status insertion.

`NanasaStore.ingestAgentStatusEvent(principal, event)` should open
`BEGIN IMMEDIATE` and verify all identity fields again inside the transaction:

* The run ID, generation, group ID, and member ID match the principal.
* The membership remains active.
* The run remains desired-running and has `starting` or `running` status.
* The run is still the highest active generation for that group member.

The insert can use `INSERT ... SELECT ... WHERE EXISTS (...)` and check
`changes`, or perform a guarded select followed by the insert under the same
immediate transaction. Return `status_generation_fenced` with HTTP 409 when the
guard fails. Do not trust a prior in-memory `AgentRun` object.

The `(run_id, generation, event_id)` unique constraint makes reporter retries
idempotent. A duplicate returns the existing current record without invoking
the reducer or publishing another domain event. Internal tmux events should use
stable IDs based on run, generation, evidence kind, and dead time when
available.

### Event publication

Status observation, current-record update, and any public domain event must
commit atomically. After commit, call the existing `#publish()` for each
appended domain event. Add a small local loop rather than publishing while the
transaction is open.

Do not mirror every raw status event into `domain_events`. That table backs the
replaying `/api/events` WebSocket, so tool-level mirroring would wake every
client and duplicate the bounded status history.

Append `agent-status.changed` only when public state, phase, attention, outcome,
or displayed summary changes. Append `agent-status.attention-required` only
when entering `waiting`, `suspected_stuck`, or `crashed`; repeated observations
in the same attention state do not republish it. Include compact status and
generation data, never raw reporter payloads. The existing WebSocket replay
then provides durable publication across daemon restart.

There is no current MCP subscription or principal-agent wake consumer. Domain
event publication prepares that path, but principal agents still poll the two
read tools in the foundation. Automatically injecting terminal messages would
couple status to messaging and should not be part of this slice.

### Tmux process-exit evidence

`TmuxRuntime.#launch()` already sets global `remain-on-exit on` and stores
`@nanasa-run-id` plus `@nanasa-generation` on the owned pane. With tmux 3.3a,
the installed manual documents these formats:

* `pane_dead`: whether the pane is dead
* `pane_dead_status`: exit status of the process in a dead pane
* `pane_dead_signal`: exit signal of the process in a dead pane
* `pane_dead_time`: process exit time
* `pane_pid`: PID of the first process in the pane
* `pane_start_command`: command used to start the pane
* `pane_current_command`: current command name

Extend `#reconcile()` format output with all ownership and process fields. It
currently matches only session, window, pane, and `pane_dead`; unlike
`#ownedPaneStatus()`, it does not verify the run ID or generation. Require both
user options before applying process evidence. This closes pane-identifier reuse
and stale-binding hazards.

For a dead owned pane, persist `process_exited` with parsed status, signal, dead
time, and PID before `RunRuntimeCoordinator.#recoverMissingRun()` marks the old
run failed and creates a new generation. For an absent pane, record
`pane_missing` with medium confidence and null exit fields. Missing panes cannot
reveal exit code or signal.

Do not classify a failed `tmux list-panes` command as an empty authoritative
pane list. Current code uses an empty map when that command fails, and
`isCurrentRun()` also converts every inspection error to `false`; a transient
tmux failure can therefore initiate recovery. Return or throw an explicit
inspection-unavailable result and preserve prior process state. Observability
failure is not process-death evidence.

Natural exits leave dead panes because of `remain-on-exit`; recovery should
remove the verified dead pane after recording evidence to prevent dead-window
accumulation. Operator `kill-pane` removes the pane and may erase retained exit
fields, but operator intent is already persisted before the kill and is enough
to classify `stopped`.

Tmux cannot prove task success, expose child-process OOM details reliably, or
distinguish useful progress from a spinner. `pane_pid` is the pane's first
process, and `pane_current_command` is liveness context only. The launch command
uses shell `exec`, which improves correspondence between the pane process and
the agent CLI but does not turn tmux into semantic supervision.

### HTTP ingestion route

Register `POST /api/agent-status/events` separately from the MCP handler:

* Require the existing bearer capability and accept agent principals only.
* Derive all run and membership identity from `McpAgentPrincipal`.
* Reject non-loopback peer addresses even when Host is valid. The normal daemon
  starts on loopback when MCP is enabled, but `createDaemon()` can be embedded
  and listened elsewhere by tests or another caller.
* Apply the existing Host and Origin validation pattern to prevent local DNS
  rebinding.
* Use a route body limit around 16 KiB and strict bounded Zod fields.
* Use a separate per-run limiter, initially 120 events per minute with short
  bursts. Do not consume the MCP limit of 30 calls per minute.
* Return 202 with `{ accepted, duplicate, observedAt, status }`; retries of a
  known event ID return the same current status with `duplicate=true`.
* Fail open in reporters with a short client timeout. The route itself remains
  fail closed for auth, validation, generation, and size errors.

Do not expose this route through a generic unauthenticated `/api` assumption.
Its explicit authentication and peer checks are part of the route contract.

### MCP tool shapes

Use the same group targeting rule as messaging tools:

```json
{
  "name": "nanasa.list_agent_statuses",
  "input": {
    "groupId": "optional for agents, required for operators",
    "attentionOnly": false
  }
}
```

The structured result is `{ groupId, statuses }`, with one compact summary for
every active membership, including `not_started` members. Stable sort by
`memberId`, matching `nanasa.list_members`.

```json
{
  "name": "nanasa.get_agent_status",
  "input": {
    "groupId": "optional for agents, required for operators",
    "memberId": "required"
  }
}
```

The structured result is `{ groupId, status }`. It includes the current detail,
open wait, latest bounded evidence, and at most 20 recent status transitions.
Return a tool error when the member is not active in the selected group. Agents
cannot override their group, but they may inspect any active member in their
own group, including themselves.

Tool text should be concise and derived from the structured result. Do not
return raw payload JSON. Add the read tools after `nanasa.list_members` in
`createMcpServer()` and update the exact tool-list assertion.

### Daemon restart behavior

The current design provides useful restart guarantees and several required
repairs:

* The signing secret persists on disk, so an unchanged live run's bearer token
  remains valid across daemon restart. `mcp-auth.test.ts` already proves secret
  persistence and active-generation revocation.
* `createDaemon()` calls `coordinator.reconcile(true)` before starting the
  dispatcher and before the server begins listening. Reporters cannot deliver
  during that gap. Long-lived reporters should retry with the same event ID.
  One-shot command hooks remain best effort unless a later reporter phase adds
  a small per-membership spool; event loss during daemon downtime must not be
  interpreted as process failure or stuck evidence.
* Persist `reducer_state_json`; otherwise open waits and tools disappear on
  restart and a waiting agent can be misclassified.
* Re-evaluate leases from daemon receipt timestamps during startup
  reconciliation. Do not recreate timers from source timestamps.
* A live pane plus an expired reporter lease becomes `reporter_stale`, not
  `crashed` and not `suspected_stuck`.
* A dead or absent desired-running pane must record old-generation process
  evidence before recovery creates the replacement. The old current row stays
  historical; list reads select the latest generation.
* Recovery gives the replacement a new token. Any late old-process request is
  rejected by auth and by the store-side generation fence.
* In-memory `onEvent()` listeners reset on restart, but persisted
  `domain_events` replay through `/api/events?after=`. Attention transitions
  must commit there to survive reconnect.

Avoid republishing unchanged attention state on every startup. Transition
comparison against persisted current state prevents duplicate coordinator
alerts.

## Recommended Implementation Path

Implement in this order to keep every step independently testable:

1. Add public contracts and pure reducer tests.
2. Refactor schema version handling, add version-2 tables, and implement store
   ingest/read/synthesis with duplicate and generation-fence tests.
3. Integrate run creation, stop/failure transitions, and snapshot summaries in
   the store.
4. Extend tmux ownership inspection and exit capture, then call the same store
   reducer path from coordinator reconciliation.
5. Add the authenticated ingestion route and focused route tests.
6. Add the two MCP read tools and tool-list/result tests.
7. Run daemon typecheck and the tmux-backed natural-exit test.

This sequence ships the foundation without harness-specific hooks,
`agent_task_reports`, progress writes, portal rendering, terminal scraping, or
structured protocol workers.

## Focused Validation

The following commands are appropriate after implementation. They were not run
during this research task. Before every `pnpm` operation, load the repository's
authoritative registry environment as required by `AGENTS.md`:

```bash
set -a
source .devcontainer/.env
set +a
pnpm --filter @nanasa/contracts exec vitest run test/contracts.test.ts
pnpm --filter @nanasa/contracts build
pnpm --filter @nanasa/daemon exec vitest run \
  test/agent-status-reducer.test.ts \
  test/store.test.ts \
  test/agent-status-routes.test.ts \
  test/mcp-auth.test.ts \
  test/mcp-server.test.ts \
  test/run-runtime-coordinator.test.ts
pnpm --filter @nanasa/daemon exec vitest run test/terminal-delivery.test.ts
pnpm --filter @nanasa/daemon typecheck
```

Focused test additions:

* `packages/contracts/test/contracts.test.ts`
  * Accept every public enum and normalized event variant.
  * Reject caller-selected identity, unknown keys, oversized summaries, and
    missing correlation IDs.
* `apps/daemon/test/agent-status-reducer.test.ts` (new)
  * Cover precedence, parallel tools, out-of-order completion, wait dominance,
    operator stop, clean settle, fatal exit, lease expiry, two-probe stuck
    threshold, and source timestamp non-authority.
* `apps/daemon/test/store.test.ts`
  * Cover version 0 to 1 to 2 and direct version 1 to 2 migration.
  * Assert old adapter columns and historical data remain unchanged.
  * Cover reopen persistence, duplicate event ID, transaction-time generation
    replacement, inactive membership, bounded retention, group deletion, and
    snapshot synthesis for not-started members.
* `apps/daemon/test/agent-status-routes.test.ts` (new)
  * Cover bearer requirement, operator rejection, loopback/Host/Origin checks,
    body limit, strict schema, derived identity, duplicate retry, stale token,
    generation race, and independent rate limit.
* `apps/daemon/test/mcp-server.test.ts`
  * Update the exact tool list and cover agent/operator group selection,
    stable summaries, attention filtering, detail history, and inactive member
    errors.
* `apps/daemon/test/run-runtime-coordinator.test.ts`
  * Assert process evidence is recorded before old-run failure and generation
    replacement, and tmux inspection failure does not initiate recovery.
* `apps/daemon/test/terminal-delivery.test.ts`
  * Add a tmux-backed command that exits with a known status and another killed
    by signal. Assert retained exit evidence, ownership generation, and dead-pane
    cleanup.

## Risks And Open Questions

### Material risks

* The public model has no neutral `alive_but_semantics_unknown` state. Keeping a
  live unreported process in low-confidence startup is the least misleading
  phase-1 behavior, but product owners should confirm this presentation before
  exposing it widely.
* `McpCredentialIssuer.authenticate()` is synchronous and strong, but only the
  store transaction closes replacement races.
* Current tmux inspection collapses command failure into absence. Fix this
  before using missing-pane evidence for `crashed`.
* Natural dead panes can accumulate under `remain-on-exit` unless verified
  cleanup follows evidence capture.
* Old adapter columns look authoritative but are intentionally compatibility
  residue. Using them for reporter selection would disable or misclassify every
  terminal-migrated profile.
* Persisted semantic state can outlive its reporter across daemon restart.
  Startup lease evaluation must surface `reporter_stale` without erasing the
  last useful progress summary.
* Publishing every observation to `domain_events` would create an unbounded,
  noisy replay stream. Publication must remain transition-based.
* The fixed 120-event rate is an initial operational value, not a measured
  harness limit. Make it configurable before high-volume reporter rollout.

### Clarifying decisions for implementation

* Confirm whether low-confidence `starting` is acceptable for a live pane that
  has no harness-ready event, or extend the public state model with an explicit
  unknown/alive state.
* Confirm whether `agentStatuses` should be optional in the first snapshot
  contract for compatibility, as recommended here, or required with immediate
  portal fixture updates.
* Choose the initial per-run observation retention count and status-route rate
  after golden traces are available. The proposed 256 rows and 120 events per
  minute are conservative starting points.

## Evidence Index

* `.copilot-tracking/research/2026-08-11/agent-status-tracking-research.md`
  defines the status model, precedence, storage recommendation, ingestion
  requirements, MCP reads, leases, and delivery phases.
* `packages/contracts/src/index.ts` centralizes all public Zod schemas and
  `PortalSnapshotSchema`; `packages/contracts/test/contracts.test.ts` verifies
  canonical projection of legacy adapter/session fields.
* `apps/daemon/src/store.ts` contains `DATABASE_SCHEMA_VERSION`, `#migrate()`,
  `#migrateLegacyColumns()`, `#migrateTerminalRuntime()`, `createRun()`,
  `updateRunStatus()`, `transitionRunRecovery()`, `getSnapshot()`,
  `#appendEvent()`, and post-commit `#publish()`.
* `apps/daemon/test/store.test.ts` proves reopen persistence, transaction-fenced
  recovery, one-time terminal migration, retained adapter compatibility rows,
  unchanged event IDs, and canonical snapshot projection.
* `apps/daemon/src/mcp-auth.ts` defines the signed generation capability,
  `McpAgentPrincipal`, `issueAgent()`, and active-generation authentication.
* `apps/daemon/test/mcp-auth.test.ts` proves secret persistence and revocation
  after stop, replacement, or membership removal.
* `apps/daemon/src/mcp-server.ts` defines `targetGroup()`, the 30-call MCP rate
  limiter, `listMembersResult()`, `createMcpServer()`, Host/Origin validation,
  and bearer setup.
* `apps/daemon/test/mcp-server.test.ts` asserts the exact tool list, derived
  agent identity, group confinement, stopped-generation revocation, and rate
  limiting.
* `apps/daemon/src/server.ts` wires the shared store, credential issuer, runtime,
  coordinator, MCP route, snapshot route, and replaying event WebSocket.
* `apps/daemon/test/server.test.ts` proves committed event replay and live
  post-commit WebSocket publication, plus snapshot persistence across reopen.
* `apps/daemon/src/run-runtime-coordinator.ts` serializes reconcile/start/stop,
  performs startup reconciliation, and replaces missing runs with incremented
  generations.
* `apps/daemon/src/tmux-runtime.ts` enables `remain-on-exit`, writes pane run and
  generation options, inspects owned panes, and currently reads only
  `pane_dead` during broad reconciliation.
* The installed tmux 3.3a manual documents `pane_dead_status`,
  `pane_dead_signal`, `pane_dead_time`, `pane_pid`, and `pane_start_command`.
* `apps/daemon/test/terminal-delivery.test.ts` provides tmux-available guarded
  integration tests and verifies pane ownership fences.
* `apps/daemon/test/ttyd-runtime.test.ts` proves daemon restart recovery and one
  replacement generation after an owner pane disappears.
* `apps/daemon/src/agent-runtime-provisioner.ts` proves that future reporters can
  use private per-membership configuration and the existing bearer environment.
