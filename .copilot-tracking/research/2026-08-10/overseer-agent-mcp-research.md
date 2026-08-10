<!-- markdownlint-disable-file -->
---
title: Overseer/team-lead agent MCP integration research
description: Repository-grounded constraints and a phased design for an overseer agent coordinating delegation over Nanasa's authenticated MCP messaging
ms.date: 2026-08-10
ms.topic: reference
---

## Scope

* Determine how an overseer/team-lead agent can reliably coordinate and delegate work to other agents using only Nanasa's current, authenticated MCP surface.
* Distinguish transport-level delivery guarantees (terminal injection succeeded) from semantic guarantees (a recipient received, accepted, and completed an assignment).
* Recommend an in-band (no-code) coordination protocol usable today, and phase the minimal daemon/contract changes that would make delegation materially safer.
* Preserve Nanasa's existing authority boundary: human/operator retains exclusive control over run lifecycle and control-intent messaging.
* This is a research and recommendation document, not an implementation plan. No repository files other than this one were modified while producing it.

## Evidence

### Current capabilities

* The Fastify daemon (`apps/daemon/src`) owns all state in SQLite via `NanasaStore` (`store.ts`) and exposes two asymmetric surfaces: REST (`server.ts`, full CRUD for groups/profiles/memberships plus run start/stop/interrupt) and MCP (`mcp-server.ts`, four tools only: `nanasa.list_members`, `nanasa.send_dm`, `nanasa.send_multicast`, `nanasa.broadcast_group`).
* Every MCP-originated message is forced to `delivery: { mode: "terminal" }` (`mcp-server.ts` `commandBase`) and is delivered by pasting text plus a separate Enter keystroke into the recipient's tmux pane (`delivery-dispatcher.ts` via `TerminalDeliveryTarget`). Before injection, the daemon prepends a trusted, non-forgeable envelope, e.g. `[From: X | Member: Y | Intent: Z]` (`README.md`).
* `nanasa.list_members` (`mcp-server.ts:121-159`) returns, per active membership: `memberId`, `alias`, `agentType`, a collapsed `runStatus` of `starting|running|stopping|offline`, and `isCaller`. Status is derived from the *latest-generation run only* — there is no history, no queue depth, and no indication of what the recipient is currently doing.
* `packages/contracts/src/index.ts` defines `RunStatusSchema` (`starting|running|stopping|stopped|failed`) and a separate, richer `RecoveryPhaseSchema` (`idle|reconciling|resuming|restarting|recovered|failed`) plus `recoveryAttempts`/`recoveryNotBefore`/`recoveryReason` on `AgentRun`. None of this recovery detail is surfaced over MCP — only `runStatus` collapsed to four values, and even `stopped`/`failed` run statuses collapse to `offline`.
* `MessageIntentSchema` = `inform | request | response | control`. A `superRefine` in `packages/contracts/src/index.ts` (~line 496) enforces that only `sender.kind === "operator"` may send `control`-intent messages. An MCP agent principal (including an overseer) is schema-rejected from sending `control`.
* `MessageCommandService.submit` / `NanasaStore.submitMessage` (`store.ts:921-928`) accept an optional **idempotency key**, executed through a generic `#executeIdempotent` helper that persists and replays prior results for the same scope+key. This exists today for REST callers; the MCP tool schemas (`mcp-server.ts`) do not currently accept or forward a caller-supplied idempotency key.
* Conversation threading fields (`conversationId`, `replyTo`, `rootId`, `causationId`, `hop` capped at 8) exist on every message but are pure caller convention — nothing in the store enforces that a `replyTo` actually references a real prior message directed at the replier, so a delegation chain can drift or be spoofed by a careless (not malicious — sender identity itself is still trusted) participant.
* Audience is a closed, validated union (`AudienceSchema`): `dm` (one recipient), `multicast` (2+ unique recipients), `group` (broadcast, fenced by `membershipRevision`). Agent broadcasts always exclude the caller; agent DM/multicast calls reject the caller as a recipient (`README.md`, `mcp-server.ts`).

### Delivery reliability is real, but it is transport-level

* `delivery-dispatcher.ts` implements a genuine lease-and-claim dispatch loop: `claimDeliveries` (leased batch claim), `beginDelivery`, `markDeliveryConsumed`, `failDeliveryAttempt` (exponential backoff: `retryBaseMs * 2^attempts`, capped at `retryMaxMs`), `revokeClaim` (on membership removal), and `rejectClaim` (on `delivery.expiresAt` passing). `failDeliveryAttempt` (`store.ts:1143-1151`) transitions to `dead-letter` once `attempts >= maxAttempts` (default 5), otherwise `retrying`.
* This means `DeliveryStatusSchema`'s `retrying`/`dead-letter`/`revoked`/`rejected` states are live and exercised today, contradicting a looser reading of the README roadmap line "Delivery retries, dead letters, and cost controls" — retries and dead-letters exist; **cost controls** (rate/spend limiting beyond the flat 30-req/min MCP rate limit) are the part still open.
* Critically, every one of these signals answers "did the text reach the recipient's terminal," not "did the recipient read, accept, or finish the work." `DeliveryStatusSchema` does include a `processed` status in the contracts, and tests cover non-terminal/migrated adapter cases, but the current MCP/terminal path exercised by `delivery-dispatcher.ts` only proves transport progression (`queued` → `received` → `delivering` → `consumed`, or retry/dead-letter variants). It does **not** provide recipient-level semantic acknowledgement. The README states this limitation explicitly: "A successful outcome means terminal injection completed; it does not claim that the CLI processed or completed the request."

### Hard constraints (cannot be worked around in-band)

1. An overseer agent cannot send `control`-intent messages — only `inform`/`request`/`response`. Any "stop what you're doing" signal to a peer is advisory text, not an enforced control primitive.
2. An overseer agent cannot start, stop, or interrupt another member's run over **agent MCP**. Those verbs exist on the daemon's REST/portal surface (`server.ts`) and are intentionally absent from the current agent MCP toolset (`mcp-server.ts`). A separate privileged operator-side companion could use them, but an ordinary agent principal cannot.
3. `runStatus` visibility over MCP cannot distinguish "idle and available" from "running and mid-task" from "running but stuck in recovery." `running` only means *the process is alive*, not *the process is free to take new work*.
4. There is no persisted task/assignment/work-item entity anywhere in the contracts or store. Everything above the `Message` primitive must be invented by the overseer in message text.

## Running means reachable, not idle

The single most important semantic gap for an overseer is conflating `runStatus: "running"` with "available for a new assignment." Nothing in Nanasa's data model tracks what an agent is doing — only whether its process is alive. An overseer must **not** treat `list_members` as a work queue signal.

Recommended interpretation until richer status exists:

* Treat `runStatus` as coarse *transport readiness*, not availability: `running` is currently deliverable; `starting` is warming/queueable but not yet safe to expect a prompt reply from; `stopping`/`offline` are unavailable.
* Derive actual *availability* from an **overseer-maintained ledger**, not from Nanasa state: a local (in the overseer's own context/memory, or a message-log-derived structure) map of `memberId → { currentAssignment: taskId | null, lastAck: timestamp, lastStatus: "idle"|"working"|"blocked" }`.
* The ledger is updated *only* from explicit protocol replies (see below), never inferred from `runStatus` or from silence. A member that has not explicitly ACKed release of its last assignment is treated as still occupied even if `runStatus` says `running` (it may simply not have replied yet).
* Silence is not idleness. Absence of a `DONE`/`BLOCKED` reply within a timeout is a *state to escalate*, not a signal that the slot is free — a stalled or crashed agent otherwise looks identical to a merely slow one.

## Recommended design — Phase 1: in-band coordinator (no daemon changes)

Given the constraints above, Phase 1 uses only what exists today: `nanasa.list_members` plus `nanasa.send_dm`/`nanasa.send_multicast` (never `nanasa.broadcast_group` for assignments — see Delegation rules). The overseer layers a structured text protocol on top of ordinary `request`/`inform`/`response` intents.

### Structured protocol messages

All protocol messages are plain-markdown DM bodies with a machine-parseable header block the overseer and delegates agree on by convention (e.g. a fenced block or leading key: value lines), followed by human-readable prose. Suggested message types:

* `ASSIGN` — overseer → one delegate. Carries `taskId`, `dedupeKey`, `assignmentRevision`, optional `dependsOn` (list of `taskId`), optional `expiresAt`/`timeoutSeconds`, and the task body. Sent as `intent: request`.
* `ACK` — delegate → overseer, sent immediately on receipt, before starting work. Confirms `taskId` + `assignmentRevision` received and accepted (or rejects it, e.g. already busy). Sent as `intent: response`, `replyTo` the `ASSIGN` message ID.
* `STATUS` — delegate → overseer, periodic or on-request progress update for an in-flight `taskId`. Sent as `intent: inform`.
* `DONE` — delegate → overseer, terminal success for `taskId`, carrying a result summary/pointer. Sent as `intent: response`.
* `BLOCKED` — delegate → overseer, terminal-for-now failure/stall for `taskId`, carrying a reason and whether it is retryable. Sent as `intent: response`.

### Why this needs explicit IDs and revisions

Because delivery is at-least-once-ish under retry (see Evidence) and there is no server-side task concept, the *overseer's own message protocol* must carry the identifiers that the daemon does not track:

* `taskId` — stable identity of the unit of work, chosen by the overseer, unique for the lifetime of the delegation.
* `dedupeKey` — lets a delegate recognize and no-op a re-delivered `ASSIGN` (e.g. after a dispatcher retry) rather than starting the same work twice.
* `assignmentRevision` — monotonically increasing per `taskId`, bumped every time the overseer reassigns, cancels, or reissues. A delegate must reject/ignore any `ACK`/`STATUS` it is asked to produce against a revision it is not currently holding, and the overseer must ignore replies carrying a stale revision. This is the in-band substitute for the daemon's own `membershipRevision` fencing pattern already used for group broadcasts.

## State models

Two ledgers, maintained by the overseer (in memory/context, or persisted to a file the overseer manages — Nanasa itself has no place to store this yet):

**Agent ledger** (per member):

| Field | Purpose |
|---|---|
| `memberId` | Stable Nanasa identity, from `list_members` |
| `reachable` | Derived from Nanasa `runStatus` (`running` = deliverable now; `starting` = warming/queueable, not promptly available) |
| `currentTaskId` | Null when free; set on a delegate's `ACK` |
| `currentAssignmentRevision` | The revision the delegate last ACKed |
| `lastContactAt` | Timestamp of last *any* protocol reply from this member |
| `lastReportedStatus` | `idle` \| `working` \| `blocked` |

**Task ledger** (per delegated unit of work):

| Field | Purpose |
|---|---|
| `taskId` | Stable identity, chosen once |
| `dedupeKey` | Detects redundant re-delivery of the same `ASSIGN` |
| `ownerMemberId` | Current holder, null if unassigned |
| `conversationId` | Stable thread identifier used across `ASSIGN`/`ACK`/`STATUS`/`DONE`/`BLOCKED` |
| `assignmentMessageId` | The latest `ASSIGN` message ID workers should `replyTo` |
| `assignmentRevision` | Bumped on every reassignment/cancel/reissue |
| `dependsOn` | Other `taskId`s that must reach `DONE` first |
| `expiresAt` / `timeoutSeconds` | When to treat the assignment as stalled |
| `state` | `pending` \| `assigned` \| `acked` \| `in-progress` \| `blocked` \| `done` \| `cancelled` |
| `attempt` | How many times this task has been (re)assigned |

Timeout/escalation policy: if no `ACK` arrives within a short bound (e.g. seconds — bounded by tmux/CLI wake latency, not network latency) or no `STATUS`/`DONE`/`BLOCKED` arrives within `timeoutSeconds` of the last contact, the overseer bumps `assignmentRevision`, marks the task `blocked` in its own ledger, and either re-`ASSIGN`s (same `taskId`, new revision) to the same or a different member, or escalates to a human/operator. The overseer must never silently retry indefinitely — Nanasa's own dispatcher caps retries at 5 attempts by default; the overseer's coordination layer should apply an analogous, explicit cap.

## Delegation rules

* **Never broadcast an owned assignment.** `nanasa.broadcast_group` excludes the sender but still reaches every other active member — it is unsuitable for anything with a single intended owner, because every non-owner receiving it has no way to know it wasn't meant for them, and a naive delegate might act on it. Use `nanasa.send_dm` for any message with exactly one intended owner (an `ASSIGN`).
* **Use `nanasa.send_multicast` only for genuinely shared, ownerless information** (e.g. an `inform` about a schema change everyone should know), never for a task that only one recipient should act on.
* **Revision fencing prevents duplicate work.** Because delivery can retry and a delegate might see the same `ASSIGN` twice, or a human/operator might race the overseer, every stateful reply (`ACK`, `STATUS`, `DONE`, `BLOCKED`) must echo the `assignmentRevision` it is responding to. The overseer discards any reply whose revision does not match the task's current `assignmentRevision`, and a delegate should discard/no-op an `ASSIGN` whose `dedupeKey` it has already accepted at the same or higher revision.
* **One in-flight owner per task at a time.** The overseer must not `ASSIGN` the same `taskId` to a second member before either receiving `DONE`/`BLOCKED` from the first or explicitly bumping the revision to reassign (which implicitly invalidates the first owner's standing).

## Authority boundary

* Human/operator remains the intended authority for run lifecycle (start/stop/interrupt) and `control`-intent messaging. For MCP, this is enforced by the contracts-level `superRefine` restricting `intent: "control"` to `sender.kind === "operator"`; operationally, run-control verbs live on the daemon's local REST/portal surface (`server.ts`) rather than the current agent MCP toolset (`mcp-server.ts`).
* An overseer agent is a **coordinator among peers**, not a supervisor with enforcement power, until/unless Phase 3 introduces a first-class, authorized delegation capability. Phase 1 and Phase 2 designs below deliberately do not attempt to route around this boundary — an overseer that needs a run stopped or a control action taken must ask a human/operator, the same as any other agent.

## Recommended design — Phase 2: minimal MCP extensions

If the team decides to invest in daemon changes, the smallest additions that meaningfully improve delegation reliability, in priority order:

1. **Inbox/history tool** — an MCP-reachable equivalent of the daemon's existing REST observability surfaces (`/api/snapshot`, `/api/events`, and per-message delivery inspection) scoped to the caller's group/membership, so an overseer (and any delegate) can recover protocol state after a restart instead of relying purely on its own possibly-lost context. This directly serves the Phase 1 protocol's need to reconstruct ledgers.
2. **Richer status in `list_members`** — surface `RecoveryPhase` (already in contracts) instead of collapsing everything to `offline`, so an overseer can distinguish "genuinely gone" from "mid-recovery, will likely come back." Low risk: purely additive field on an existing read tool.
3. **Idempotency key on the three send tools** — thread the store's existing `idempotencyKey` parameter (already used internally, e.g. `submitMessage(groupId, command, idempotencyKey?)`) through `mcp-server.ts`'s tool schemas, so a retried `ASSIGN` (from the overseer's own retry logic, or from an MCP client-side retry) is guaranteed not to double-submit as a *new* message. This is a narrow, additive schema change, not a new capability.
4. **Delivery outcome visibility over MCP** — a tool or field returning `DeliveryOutcome`/`DeliveryStatus` for messages the caller sent, so an overseer can distinguish "never reached the recipient's terminal" (dispatcher-level: `dead-letter`/`revoked`/`rejected`) from "reached the terminal, delegate simply hasn't replied yet" (application-level: silence) — these currently require different responses (redeliver vs. escalate-for-a-human).
5. **Expiry on send tools** — expose `delivery.expiresAt` (already in `DeliveryPolicySchema`) on the MCP tool schemas so an `ASSIGN` with a hard deadline can be authored declaratively instead of the overseer tracking timeouts purely client-side.
6. **Cancel/supersede signal** — a narrowly-scoped way for the *original sender* to mark a previously sent message as superseded (e.g. by a `causationId`/`replyTo`-linked control-adjacent inform), so a delegate mid-task can be told "this assignment is stale" even though it already reached the terminal. This is the one item that brushes against the `control`-intent boundary and should be scoped carefully — see Risks.

None of these require relaxing the operator-only `control`-intent restriction or granting agent principals run-lifecycle access; all are additive read/schema surface on the existing agent-messaging capability.

## Recommended design — Phase 3: first-class tasks/assignments (larger change, longer-term)

Only pursue if Phase 1/2 prove the coordination pattern is valuable and the ad hoc protocol becomes a maintenance burden. This would add new, persisted domain entities alongside the existing Group/Membership/Run/Message model:

* A `Task`/`Assignment` aggregate in `packages/contracts/src/index.ts` with server-enforced `taskId`, `assignmentRevision`, `ownerMemberId`, `state`, `dependsOn`, and `expiresAt` — moving the Phase 1 ledger fields from overseer-managed convention into daemon-persisted, store-validated state (mirroring how `membershipRevision` already fences group broadcasts).
* Store-level enforcement of the invariants Phase 1 can only ask nicely for: one active owner per task, monotonic revisions, dependency ordering, automatic timeout transitions (the daemon already runs a comparable background loop for delivery retry and run recovery — `delivery-dispatcher.ts`, `run-runtime-coordinator.ts` — this would be a third such coordinator).
* New MCP tools (`nanasa.assign_task`, `nanasa.ack_task`, `nanasa.report_task`, etc.) layered on top of the existing message transport, so the human-readable message timeline is preserved but task state is no longer solely inferred from text.
* This is explicitly out of scope to design in detail here — it is a substantial contracts/store/mcp-server change requiring its own research and plan documents once/if Phase 1 usage justifies it.

## Message flows

**Happy path (single task, no contention):**

1. Overseer calls `nanasa.list_members`, picks a reachable, not-currently-owning member from its own agent ledger.
2. Overseer `nanasa.send_dm` → `ASSIGN taskId=T1 dedupeKey=T1-r1 assignmentRevision=1 expiresAt=...`.
3. Delegate replies `ACK taskId=T1 assignmentRevision=1` (intent `response`, `replyTo` the ASSIGN message ID). Overseer sets agent ledger `currentTaskId=T1`, task ledger `state=acked`.
4. Delegate optionally sends one or more `STATUS` informs as it works.
5. Delegate replies `DONE taskId=T1 assignmentRevision=1` with a result summary. Overseer sets task `state=done`, frees the agent ledger slot.

**Timeout/escalation path:**

1. Overseer sends `ASSIGN taskId=T2 assignmentRevision=1`, receives no `ACK` within the bound.
2. Overseer bumps to `assignmentRevision=2`, either re-sends the same `ASSIGN` to the same member (covers a lost/racing paste) or reassigns to a different reachable member, and records the escalation.
3. If a stale `ACK`/`DONE` for `assignmentRevision=1` later arrives, the overseer discards it (revision mismatch) rather than double-crediting or double-freeing.
4. If retries are exhausted (mirror the dispatcher's capped-attempt pattern rather than retrying forever), the overseer sends an `inform` to a human/operator describing the stalled task rather than attempting any control action itself.

**Reassignment due to `BLOCKED`:**

1. Delegate replies `BLOCKED taskId=T3 assignmentRevision=1 reason="missing dependency output" retryable=true`.
2. Overseer resolves the dependency (or asks a human), bumps `assignmentRevision=2`, and re-`ASSIGN`s — to the same delegate if the block was environmental, or a different one if the block was delegate-specific.

## Risks

* **Text-protocol drift.** Because the `ASSIGN`/`ACK`/`STATUS`/`DONE`/`BLOCKED` header block is a convention, not a schema, a delegate agent that does not follow the convention (or a different overseer instance with a slightly different dialect) will silently desynchronize the ledger. Mitigate by keeping the header format extremely simple and by having the overseer treat any DM reply it cannot parse as `STATUS`-equivalent (do not assume unparseable = done or = failed).
* **False idleness from `runStatus`.** Reiterating the core finding above: never free an agent-ledger slot just because `list_members` shows `running` — only explicit `DONE`/`BLOCKED`/cancellation should free it.
* **Unbounded retry loops.** An overseer that keeps re-`ASSIGN`ing on timeout without a cap can itself become a source of duplicate work if a slow-but-alive delegate eventually processes an earlier revision. Always cap attempts and always fence on `assignmentRevision`.
* **Cancel/supersede (Phase 2 item 6) brushing the control boundary.** A "this is stale, stop" signal is semantically adjacent to `control` intent. It must remain advisory (the delegate chooses to honor it) and must not be implemented by relaxing the operator-only `control` restriction, or it reintroduces an agent-authorized control path the current model deliberately excludes.
* **Broadcast misuse.** The single highest-likelihood implementation mistake is using `nanasa.broadcast_group` for anything with an intended single owner; every finding above assumes DMs are used for owned work.
* **Confusing transport success with task success.** Any future dashboard/log built on `DeliveryOutcome` must be labeled as delivery status, not task status, to avoid an operator believing "delivered" means "done."

## Security constraints

* No change proposed here weakens the existing boundary that agent MCP principals cannot forge sender identity, select another group, or address themselves in a DM/multicast/broadcast (`mcp-auth.ts`, `mcp-server.ts`).
* No change proposed here grants agent principals `control`-intent messaging or REST run-lifecycle access; Phase 2's "cancel/supersede" item is explicitly scoped as an advisory, non-`control` signal (see Risks).
* Any Phase 2 idempotency-key or expiry field added to MCP tool schemas must reuse the store's existing validated types (`IdentifierSchema`, `TimestampSchema`) rather than introducing new unbounded string inputs.
* Any Phase 2 inbox/history tool must respect the same group-scoping as `nanasa.list_members` (`targetGroup` in `mcp-server.ts`) — an agent must not be able to read another group's message history.
* The overseer's own ledgers (Phase 1) contain no secrets and should not be treated as an authoritative audit trail; the daemon's persisted `messages`/`deliveryOutcomes` tables remain the source of truth for what was actually sent and delivered.

## Likely files and tests to change (if Phase 2/3 are pursued)

* `packages/contracts/src/index.ts` — additive schema fields (idempotency key, expiry, recovery-phase-aware status) for Phase 2; new Task/Assignment aggregate for Phase 3.
* `apps/daemon/src/mcp-server.ts` — extend `ListMembersSchema`/`MessageFieldsSchema` and add any new read tools (inbox/history, delivery outcomes) for Phase 2; new tools for Phase 3.
* `apps/daemon/src/message-command-service.ts` / `store.ts` — thread idempotency key and expiry from MCP callers into the existing `#executeIdempotent`/`submitMessage`/delivery-policy machinery (already present for other callers).
* `apps/daemon/src/mcp-auth.ts` — unaffected for Phase 2 (no new principal kind needed); a Phase 3 task-capable principal/scope would live here.
* `apps/daemon/test/mcp-server.test.ts`, `apps/daemon/test/mcp-auth.test.ts`, `apps/daemon/test/store.test.ts` — mirror any schema/tool additions.
* `apps/portal/src/components/message-workspace.tsx` — only if the portal should visualize the Phase 1 protocol header block distinctly (not required for Phase 1 to function).

## Validation

* Phase 1 requires no code change; validate by dry-running the `ASSIGN`/`ACK`/`STATUS`/`DONE`/`BLOCKED` protocol between two live memberships in a group and confirming the overseer's ledger stays consistent under an induced retry (e.g. a deliberately delayed `ACK`) and an induced timeout (a delegate that never replies).
* Confirm, by inspection of `delivery-dispatcher.ts` and `store.ts`, that `dead-letter`/`revoked`/`rejected` outcomes are observable (today only via REST snapshot, not MCP) and that Phase 2's proposed MCP delivery-outcome tool would surface exactly these existing statuses rather than inventing new ones.
* For any Phase 2 schema addition, unit-test idempotency-key replay (same key + same scope returns the prior result, per the existing `#executeIdempotent` contract) and expiry rejection (a message whose `delivery.expiresAt` has passed is rejected by the dispatcher, matching current `rejectClaim` behavior).
* Verify no Phase 2 change adds agent-MCP access to run-lifecycle verbs or relaxes the `control`-intent restriction — this should remain enforced by the existing contracts-level `superRefine`, with any new MCP surface staying read-only or message-oriented unless a separate operator path is intentionally introduced.
