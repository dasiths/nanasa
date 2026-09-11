---
title: Autonomous Foreman implementation plan
description: Phased contracts, migration, verification, and rollout for unattended repository-level team supervision
ms.date: 2026-09-11
ms.topic: how-to
---

## Status and scope

Proposed plan for review, not an implementation authorization. No phases have
been implemented as part of this planning task. The current portal mock is an
interaction reference only and remains outside this documentation commit.

Architecture and source evidence are in
[autonomous-foreman-research.md](../research/autonomous-foreman-research.md).
The baseline is `cd6ecc702a656dd5238a080648231a9e96679165`; config is v2 and the
database is schema 16. Rebase the plan's migration numbers against the actual
implementation branch before writing migrations.

Goal: the human gives Foreman a long-horizon objective and a bounded grant, then
can leave the portal closed while Foreman provisions workspaces, allocates roles,
delegates tasks, observes progress/transcripts, intervenes when justified,
recovers eligible agents, and produces evidence-backed completion.

Non-goals for the first release: arbitrary administration, unattended login,
unrestricted key injection, automatic permission bypass, cross-repository
federation, automatic protected-branch merge, force push, and production deploy.
These exclusions do not remove the required provisioning, transcript supervision,
or recovery capabilities inside the approved envelope.

## Requirements traceability

| ID    | Required outcome                                    | Phase         | Acceptance evidence                          |
| ----- | --------------------------------------------------- | ------------- | -------------------------------------------- |
| R01   | Foreman is primary human interaction point          | P3, P9        | Dedicated Channel and mission intake         |
| R02   | Repository actor outside team broadcasts            | P1, P2, P3    | No membership or Everyone delivery           |
| R03   | Config selects provider and instructions            | P1            | v2 migration and v3 validation fixtures      |
| R04   | Foreman creates team/worktree assignments           | P5            | Owned team and checkout after restart        |
| R05   | Roles are discovered and work is assigned           | P4, P5        | Validated roster/capacity/reviewer choices   |
| R06   | Long-horizon tasks survive context/process loss     | P4, P6        | Checkpoint and replay fault tests            |
| R07   | Periodic and event-driven checks run without portal | P6            | Fake clock and browser-closed acceptance     |
| R08   | Foreman reads transcripts and chooses input         | P7            | Observation-bound intervention receipt       |
| R09   | Stuck or failed agents can be recovered             | P8            | Bounded incident and new-generation proof    |
| R10   | Tasks reach verified completion                     | P9            | Pinned candidate and independent evidence    |
| R11   | MCP scopes allow Foreman but not ordinary peers     | P2            | Principal/resource authorization matrix      |
| R12   | Team-context Foreman interaction remains dedicated  | P3, P9        | Context reference is not an access grant     |
| R13   | Foreman has native Terminal direct control          | P1, P3, P9    | One run, one controller, no second composer  |
| R14   | Human pause/takeover/revoke overrides autonomy      | P2, P4, P7    | Execution-boundary cancellation tests        |
| R15   | Partial effects and retries are reconciled safely   | P4-P9         | Before/after-write crash injection           |
| R16   | Budgets and approval rules permit safe absence      | P2, P4, P6    | Persistent limits, explicit blocked state    |
| R17   | Agents and Foreman cannot hide uncertainty          | P7-P9         | Unknown/ambiguous results remain visible     |
| R18   | Release works across supported runtime boundaries   | P10           | Packaging, migration, provider certification |

## Architectural decisions to carry into implementation

1. One daemon remains mutation authority. SQLite owns durable domain facts;
   tmux and native providers own process/session/terminal state.
2. Introduce a repository Foreman principal, never a reused operator token or
   fake team membership. Preserve ordinary-agent restrictions.
3. Reuse the current MCP endpoint and provider runtime services, extended through
   an explicit runtime owner union and per-resource policy.
4. Add daemon-owned missions, tasks, due work, observations, interventions, and
   operation journals. A running LLM or browser is not the scheduler.
5. Separate queued task intent from exact run-bound actions. One task dispatch
   has one terminal-input effect; a linked chat record must not inject again.
6. Provision teams from approved templates into durable local allocations;
   reconcile them separately from authored groups without rewriting mission
   details into checked-in configuration.
7. Use fresh bounded transcript evidence plus provider-reviewed input guards.
   Unsupported/ambiguous TUI states are read-only until human review.
8. Completion is a validated evidence gate, not a message, badge, or agent claim.
9. Explicit human takeover pauses automated interference; ordinary observation
   does not. Context selection changes neither permissions nor runtime cwd.

## Proposed contracts

All names below are design targets, not claims about existing APIs.

### Persistence

Keep tables in the current store/migration system. Exact table names may change,
but their ownership and uniqueness must not.

| Record                  | Key facts and constraints                                               |
| ----------------------- | ----------------------------------------------------------------------- |
| Actor                   | Repository, owner kind, stable ID; one active Foreman per repository    |
| Runtime owner           | Run to actor; conditional membership; generation unique per actor       |
| Mission                 | Objective/acceptance/grant revisions, state, priority, limits           |
| Mission task            | Dependencies, scope, required role, current owner, revision, evidence   |
| Task attempt            | Target run/generation/action, effect certainty, previous attempt        |
| Mission operation       | Idempotency key/digest, principal, grant revision, lease, result        |
| Provisioned team        | Mission owner, template digest, origin, checkout, allocation state      |
| Resource reservation    | Mission/task scope, actor/checkout capacity, lease and ownership        |
| Scheduled review        | Due time, reason, dedupe identity, attempts, lease, daemon epoch        |
| Foreman inbox turn      | Mission/context, source events, acceptance state, target generation     |
| Foreman message         | Repository channel sequence, sender, context, reply/provenance          |
| Agent observation       | Bounded capture metadata, source, prompt state, digest, expiry          |
| Intervention attempt    | Observation/plan/target identity, input kind, digest, receipt           |
| Recovery incident       | Diagnosis, affected identities, cooldown, persistent retry counters     |
| Decision request        | Human question, exact operation/targets, expiry, granted/denied outcome |
| Mission evidence        | Candidate commit, task, recipe/reviewer identity, hashes, acceptance    |

Use unique constraints for idempotency within principal/mission/operation kind,
one active actor allocation per execution slot, one active incident operation
per target, and due-work deduplication. Persist large evidence by bounded owned
artifact reference; do not grow snapshot responses without limits.

Migrate runs without changing historical IDs/generations. Team endpoints keep
legacy group-shaped responses, filtering repository actors. Shared internals
use an explicit owner union; Foreman endpoints serialize its owner separately.
Keep foreign-key checks and explicit conditional scope constraints.

### State and effect certainty

Mission lifecycle includes planning, ready, running, waiting, verifying,
awaiting-acceptance, completed, blocked, paused, cancelling, cancelled, and failed.
Task lifecycle is independently queued, assigned, running, blocked, verifying,
accepted, failed, cancelled, or superseded. Define transition tables before code.

Operation states distinguish prepared, pending, running, blocked, succeeded,
failed, cancelled, and ambiguous. Timeout is not proof of failure before effect.
Recovery cannot transition ambiguous to pending solely because a lease expired.
Task completion may be accepted only from current evidence and acceptance revision.

### Service and API boundary

Extend the typed route registry, control client, CLI registry, and MCP registry
together. The REST naming below is illustrative; all mutating operations require
authenticated principals, canonical request digest, expected revisions, and audit.

* Repository Foreman snapshot, lifecycle, channel history/send, and terminal endpoint
* Missions create/read/plan/activate/pause/resume/cancel and grants approve/revoke
* Tasks assign/read/evidence and mission completion proposal/acceptance
* Team provisioning prepare/execute plus operation status/reconcile
* Agent observation capture plus intervention prepare/execute
* Recovery diagnose/prepare/execute and operator decision reply

Do not expose an unrestricted Foreman-to-REST proxy. Policy lives at service
execution, not solely in route handlers. Existing external-effect routes marked
idempotency-forbidden remain so; new mission wrappers journal and reconcile
effects rather than relabel those routes as exactly-once.

Use the proposed MCP families from the research. Every principal receives only
eligible tools; direct calls to hidden tools still fail authorization. Worker
progress and escalation tools are restricted to owned tasks, with no implicit
repository-wide read authority.

### Inspect-and-input contract

Capture accepts mission/task and exact actor/run/generation, source, and bounds.
Result returns observation ID, current ownership/reporter/binding, capture time,
digest, prompt classification, truncation/alternate-screen metadata, and permitted
input kinds. Authorization occurs before reading content.

Prepare intervention accepts observation ID, intended input kind, bounded payload,
reason, evidence references, expected outcome, and idempotency key. It returns
an immutable plan/digest, expiry, permissions, and blockers.

Execute accepts only the prepared identity plus confirmation when required.
Inside the input lock, revalidate mission/grant, run/generation, process/reporter,
manual takeover state, recent interactive input, observation freshness, and
adapter prompt guard. Reject stale plans and newly appearing permission/login
prompts. Persist the attempt before I/O; return effect certainty, not guessed
semantic success. An arbitrary raw-key string is not an accepted input kind.

Typed wait replies use their exact request IDs when supported. Native fallback
is adapter-specific and must pass separate certification. Read-only observation
can ship before native input; the product must report unsupported write capability
instead of silently bypassing the guard.

## Implementation phases

Each phase is independently reviewed and tested before the next phase that
depends on it. No unattended mutations are enabled before P10's rollout gates.
Avoid a broad provider or portal rewrite beyond ownership changes required here.

### P0 - Confirm design and threat model

Dependencies: none. Documentation and experiments only, on an implementation
branch after approval of this plan.

* Confirm mission ownership, grant model, trusted-local disclosure, and initial
  provider capability requirements.
* Decide the exact actor/run migration with a reference inventory of group-only
  assumptions; prohibit fake Foreman membership.
* Write transition tables, failure taxonomy, effect boundaries, and acceptance
  criteria for the first unattended mission.
* Choose initial certified provider and define a supported fallback for missing
  reporter/input capabilities. Do not promise all providers on day one.

Exit: reviewed design, immutable requirements, and no unresolved choice affecting
authorization, data loss, or migration. Confirm user approval before source edits.

### P1 - Configuration and repository runtime ownership

Dependencies: P0.

Owning surfaces:
[config.ts](../../packages/contracts/src/config.ts),
[config-loader.ts](../../apps/daemon/src/config-loader.ts),
[config-repository.ts](../../apps/daemon/src/config-repository.ts),
[schema.ts](../../apps/daemon/src/persistence/schema.ts),
[store.ts](../../apps/daemon/src/store.ts),
[provider-runtime-provisioner.ts](../../apps/daemon/src/provider-runtime-provisioner.ts),
[instruction-resolver.ts](../../apps/daemon/src/instruction-resolver.ts).

* Add proposed v3 Foreman/template fields with strict references and bounded
  limits; normalize v2 with no Foreman and provide an explicit migration preview.
* Add actor/runtime owner identity, backfill team records, and preserve run/session
  references. Adapt shared provision/launch/status/recovery code without parallel
  Foreman implementations.
* Add private Foreman state and stable coordination cwd; no sharing a team home.
* Add Foreman-specific built-in and authored instruction scope with revisions,
  size/path checks, and no team-context-driven prompt mutation.
* Extend auth/setup/doctor, consent, reporter issuance, native session reservation,
  package adoption, shutdown, and terminal endpoint lookup for repository owners.

Tests: extend existing
[config.test.ts](../../apps/daemon/test/config.test.ts),
[agent-runtime-provisioner.test.ts](../../apps/daemon/test/agent-runtime-provisioner.test.ts),
and [contracts.test.ts](../../packages/contracts/test/contracts.test.ts).
Add migration/reopen cases, preserved IDs and home isolation, v2 fixtures,
invalid Foreman references, comments-preserving YAML edits, and stale config CAS.

Exit: one Foreman can start, recover, and stop with no group membership; v2
repositories and ordinary group actors behave unchanged; Foreman remains disabled
unless configured. No new autonomous powers yet.

### P2 - Foreman principal and bounded grants

Dependencies: P1.

Owning surfaces:
[mcp-auth.ts](../../apps/daemon/src/mcp-auth.ts),
[mcp-server.ts](../../apps/daemon/src/mcp-server.ts),
[tool-registry.ts](../../apps/daemon/src/mcp/tool-registry.ts),
[peer-capability-policy.ts](../../apps/daemon/src/actions/peer-capability-policy.ts),
and typed HTTP/control-client contracts.

* Introduce a repository-bound Foreman capability with audience, expiry, current
  actor/run/generation, and grant-revision checks.
* Add service-level resource policy and immutable operator-issued mission grants.
  Ordinary agents retain cross-team and privileged-wait denials.
* Define supervised versus bounded mode, immediate revocation, execution-boundary
  checks, and explicit capability denials for unsupported providers.
* Add redacted audit and decision requests, separate credential classes, and
  per-principal bounded tool exposure/rate limits.

Tests: extend
[mcp-auth.test.ts](../../apps/daemon/test/mcp-auth.test.ts) and
[mcp-server.test.ts](../../apps/daemon/test/mcp-server.test.ts).
Cover wrong repo/run/audience, stale generation/grant, expiry, forged sender,
hidden-tool direct invocation, worker escalation limits, and operator revocation
between prepare and execute.

Exit: no tool surface can promote Foreman to operator or worker to Foreman;
capability manifests accurately describe allowed effects. No token is written
into prompts or passed through to another actor.

### P3 - Dedicated Channel and native Terminal

Dependencies: P1, P2.

* Add repository message history/send/reply with stable channel sequence and
  typed mission/team provenance. Keep team message APIs and broadcasts unchanged.
* Add a durable Foreman input inbox; one accepted input path per instruction.
  Expose exact delivery state independent of provider acceptance/completion.
* Reuse terminal gateway/lease/effect/reconnect mechanisms for the Foreman run.
  Channel and Terminal share one native session; no extra command composer.
* Validate context references server-side. Bad context stays unavailable; query
  strings never grant authority or change the Foreman cwd.
* Retain active mission evidence or declare unavailable sources explicitly.

Tests: real safe-echo terminal fixture; one-run two-view identity; control versus
observe; old generation writes rejected; reconnect; team Everyone excludes
Foreman; cross-scope reply references; deleted team; history retention; protected
terminal effects. Existing terminal gateway tests must stay green.

Exit: a human can converse with and directly drive Foreman from the portal without
a team membership or a second session. Worker escalations do not expose other
teams' channel content.

### P4 - Mission tasks and operation journal

Dependencies: P2, P3.

Owning surfaces:
[agent-action-service.ts](../../apps/daemon/src/actions/agent-action-service.ts),
[agent-action-scheduler.ts](../../apps/daemon/src/actions/agent-action-scheduler.ts),
[actions.ts](../../packages/contracts/src/actions.ts), and store/events.

* Implement mission/task transitions, acceptance revisions, dependency validation,
  assignment history, evidence references, and checkpoint reconstruction.
* Add task-level queue, capacity reservations, mission fairness, and persistent
  budgets. Create exact actions only at verified dispatch readiness.
* Make delegation a journaled operation with one input effect, not independently
  injected message plus action. Resolve cancellation and ambiguous outcomes.
* Add human pause/takeover/revoke state, preventing new input and disruptive
  operations without claiming already-submitted provider work has stopped.
* Version progress/report correlation and worker task ownership; no alias/time joins.

Tests: extend
[agent-actions.test.ts](../../apps/daemon/test/agent-actions.test.ts).
Cover busy targets, duplicate/reordered deliveries, crash before/after write,
cyclic dependencies, competing owners, stale reporter, generation replacement,
retained accepted results, persistent budgets, and no double task execution.

Exit: a queued task survives daemon restart and dispatches once when eligible;
ambiguous attempts cannot auto-replay; mission scope/acceptance cannot be weakened
by an agent. This is a new task layer, not a rewrite of exact action meaning.

### P5 - Template teams and worktree provisioning

Dependencies: P1, P2, P4.

Owning surfaces:
[topology-service.ts](../../apps/daemon/src/topology-service.ts),
[worktree-service.ts](../../apps/daemon/src/git/worktree-service.ts),
[checkout-service.ts](../../apps/daemon/src/git/checkout-service.ts),
and [run-runtime-coordinator.ts](../../apps/daemon/src/run-runtime-coordinator.ts).

* Add runtime allocation origin/mission ownership and desired-topology composition.
  Preserve authored groups and prevent config reload from removing allocated teams.
* Implement prepare/execute provisioning with template/base/config revisions,
  resource reservations, expected checkout revision, and provider preflight.
* Restrict new resources to approved namespaces and managed paths; existing human
  resources require an adoption grant. Refresh Git identity before assignment.
* Record each stage and reconcile partial outcomes; retain dirty work and branches
  on failure. Do not retry Git creation as if it were DB-only idempotency.
* Add role/capability-aware candidate selection, capacity checks, writer ownership,
  and independent reviewer constraints. No automatic provider installation or
  credential copying to fill missing roles.

Tests: extend
[worktree-service.test.ts](../../apps/daemon/test/worktree-service.test.ts) and
[two-team-workspaces.test.ts](../../apps/daemon/test/two-team-workspaces.test.ts).
Use disposable repositories/worktree roots under `/tmp`. Verify stopped-only
assignment, exclusivity, immutable run cwd, dirty preservation, collisions with
existing worktrees, config reload, manual edits, and crash at every step.

Exit: one mission provisions and owns a team/worktree end to end, survives a
partial provisioning crash, and dispatches only after all required actors are
ready. Failure does not steal or delete a human workspace.

### P6 - Durable supervision and Foreman continuity

Dependencies: P4, P5.

* Add due-work store and deterministic clock-injected reconciler, distinct from
  bounded Foreman review turns. Subscribe to canonical events, not UI Attention.
* Coalesce duplicate/out-of-order events and missed ticks. Persist wake leases,
  cooldowns, next review, and incident reasons.
* Gate wake input on Foreman readiness; do not interrupt a busy session with
  repeated status prompts. Reconstruct after context/daemon/provider restart.
* Detect dependency deadlocks, repeated unchanged output, stale progress, and
  exhausted budgets without misclassifying expected long tools.
* Add durable blocked incidents and an optional redacted notification outbox.
  Browser presence and notification delivery are not safety dependencies.

Tests: fake clock, clock jump, overdue tick after restart, busy Foreman, duplicated
events, replay gaps/reset, disk failure, provider outage/backoff, no-message team,
and browser-closed execution. Assert persistent limits across new generations.

Exit: supervision survives daemon restarts and closed browsers without prompt
storms. Foreman failure pauses new coordination while bounded work and evidence
remain recoverable.

### P7 - Transcript observation and guarded intervention

Dependencies: P2, P4, P6. Read-only observation may land before native input.

Owning surfaces:
[terminal-read-service.ts](../../apps/daemon/src/terminal/terminal-read-service.ts),
[terminal-input-arbiter.ts](../../apps/daemon/src/terminal/terminal-input-arbiter.ts),
[agent-open-wait-service.ts](../../apps/daemon/src/actions/agent-open-wait-service.ts),
and provider capability/recognition contracts.

* Add mission-authorized bounded capture, ephemeral observations, redaction,
  provenance, source/truncation metadata, and controlled checkpoint retention.
* Add observation-bound proposal/execute operations with reason, payload digest,
  input kind, expiry, expected outcome, and incident budget.
* Prefer exact actions and typed waits; add native prompt/selection input only
  through reviewed adapter capabilities and refreshed prompt-state guards.
* Recheck manual input/takeover, waits, reporter and process identity, grants, and
  observation freshness inside the automated-input boundary.
* Persist effect certainty and inspect ambiguous writes instead of auto-resending.
  No free-form keystroke injection or implicit permission approval.

Tests: extend
[terminal-read-service.test.ts](../../apps/daemon/test/terminal-read-service.test.ts)
and action/wait tests with transcript fixtures. Include secret-like data, injected
instructions, alternate screen, truncation, false idle, stale prompt, unexpected
approval, controller race, same text on a replacement run, wrong mission, grant
revocation, repeated nudge, and crash immediately after paste.

Exit: Foreman can read an idle/stalled target, choose a useful instruction, and
execute it once against a positively verified prompt. Unsupported states produce
an explicit blocked result. No auto-answer test may cross a permission boundary.

### P8 - Diagnosed recovery and safe reassignment

Dependencies: P5, P6, P7.

* Integrate missing-process recovery with mission incidents and common leases.
* Add evidence-based live-stagnation recovery proposals, graceful interrupt,
  checkpoint/adopt/resume/restart choice, and consent/readiness rechecks.
* Maintain cumulative per-incident and mission retry limits across generations;
  repeated same failures circuit-break instead of producing restart storms.
* Reconcile old task effects before new attempts or reassignment. Preserve dirty
  changes, accepted evidence, and native-session provenance.
* Restore Foreman with daemon supervision and mission reconstruction, not a
  second unconstrained recovery agent.

Tests: extend
[native-recovery-coordinator.test.ts](../../apps/daemon/test/native-recovery-coordinator.test.ts).
Inject missing pane, indeterminate process, stale reporter, real approval wait,
duplicate recovery controllers, interrupted restart, provider version drift,
manual stop, dirty checkout, failure exhaustion, and old-generation late results.

Exit: eligible mission-owned failures recover within limits; uncertainty escalates
without data loss, privilege escalation, or duplicate task execution.

### P9 - Verification and production portal integration

Dependencies: P3-P8.

* Add pinned candidate/evidence receipts and approved verification recipes.
  Reject outdated commits, altered criteria, weakened recipes, or producer-only
  review where independent acceptance is required.
* Integrate exact team commits into an owned candidate worktree, run required
  checks, and issue bounded corrective tasks for failures.
* Implement completion proposal and structural acceptance gates; final human
  acceptance or preauthorized criteria decides closure.
* Replace mock Foreman data with real contracts. Show missions, next review,
  limits, decisions, interventions, provenance, recovery, pause/takeover/resume,
  dedicated Channel and native Terminal, plus contextual team return paths.
* Preserve simple team composer routing. Clarify delegation receipt versus
  action acceptance and remove fixture health claims.

Tests: independent review, stale evidence, required task missing, pending decision,
weakened tests, failed integration, partial publication, bad context query, and
no premature completion. Portal desktop/mobile, keyboard/focus, 200% zoom,
screen-reader status, retained terminal mounts, and reconnect tests.

Exit: human sees a trustworthy completed candidate or an actionable blocked
mission, never a fabricated success. No deployment/publication occurs by default.

### P10 - Certification and bounded-autonomy rollout

Dependencies: all earlier gates.

* Update generated HTTP/MCP/event/CLI references, user config examples, auth/setup
  guidance, security disclosures, operational runbook, and package migrations.
* Run required CI and safe-echo fault tests without provider credentials.
* Separately certify each supported provider for Foreman bootstrap, exact actions,
  transcript bounds, native input guard, permission handling, continuation,
  context rollover, native-session recovery, and shutdown.
* Run shadow recommendations first, then human-confirmed operations, then bounded
  autonomous missions in disposable repositories. Keep provider capability gaps
  explicit; unsupported adapters cannot silently inherit certification.
* Conduct browser-closed and overnight trials with finite mission limits,
  intentional process/daemon failures, manual takeover, storage pressure, and
  verification failures. Record latency, intervention precision, duplicate work,
  recovery exhaustion, cost coverage, and completion evidence.

Exit: exact pinned build/provider versions pass the rollout checklist. This gate
is empirical work still to be done, not a claim proven by this planning document.

## First end-to-end acceptance scenario

Use a disposable repository and safe scripted providers in required CI. A real
provider trial repeats the workflow later; deterministic tests prove state and
authorization, not the quality of LLM judgment.

1. The human configures Foreman and approved implementor/reviewer templates,
  grants a finite mission, and submits an objective with testable acceptance.
2. Foreman discovers role/capability availability, records a plan, provisions a
  mission-owned worktree/team, and starts the required actors.
3. A task targeting a busy actor remains queued. When the actor becomes eligible,
  one exact action is created and one input is delivered.
4. The human closes the portal. Scheduled supervision and event processing continue.
5. The builder becomes idle with unfinished work. Foreman captures bounded terminal
  evidence and proposes a clarifying input. A fresh matching prompt allows it.
6. A second attempt observes a changed permission prompt. The daemon refuses input
  and creates a durable operator decision; no generic Enter or `y` is sent.
7. A different worker loses its process. The coordinator recovers it once within
  policy, preserving the task's completed evidence and reconciling unfinished effects.
8. The daemon and Foreman restart during a pending operation. Journals and due work
  restore without duplicate worktree, task dispatch, intervention, or recovery.
9. The reviewer rejects incomplete evidence. Foreman issues a bounded correction,
  obtains independent review, and verifies a pinned integration candidate.
10. Mission closes only when structural acceptance passes, or waits explicitly for
   required final human acceptance. No protected branch or deployment is changed.

The workflow must also demonstrate a safe blocked outcome. An operator being
away is not permission to solve an unavailable credential or ambiguous effect by
bypassing the boundary.

## Failure-injection matrix

| Boundary                           | Injected failure                         | Required result                                    |
| ---------------------------------- | ---------------------------------------- | -------------------------------------------------- |
| Mission intake                     | Duplicate request with same key          | Same mission; conflicting payload rejected         |
| Resource reservation               | Concurrent missions choose one actor     | One owner; other task remains queued               |
| Team allocation                    | Config reload after runtime allocation   | Allocation retained; authored teams unchanged      |
| Git create                         | Crash after Git write before receipt     | Inspect/reconcile; no duplicate or force cleanup   |
| Worktree assignment                | Human switches checkout after prepare    | Stale revision rejected before stopping actors     |
| Task dispatch                      | Crash after paste before durable result  | Ambiguous attempt; no blind replay                 |
| Transcript capture                 | Wrong mission target or secret output    | Deny before capture or redact within policy        |
| Transcript interpretation          | Embedded request to elevate authority    | No policy/grant change                             |
| Intervention                       | New login/approval screen before write   | Reject stale plan and request human decision       |
| Intervention                       | Same prompt text on new generation       | Reject identity mismatch                           |
| Native input                       | Unsupported provider or prompt state     | Observe-only capability and explicit blocker       |
| Human takeover                     | Concurrent automatic prompt/restart      | Execution fence prevents interference              |
| Recovery                           | Two controllers diagnose same incident   | One recovery lease; no duplicate replacement       |
| Foreman outage                     | Repeated restart with unchanged fault    | Budget survives and circuit breaker opens          |
| Timer restore                      | Hours of missed intervals                | One coalesced review, no prompt storm              |
| Progress                           | Heartbeats without meaningful changes    | No-progress remains detectable                     |
| Evidence                           | Candidate changes after review           | Reverification required                            |
| Acceptance                         | Agent weakens criteria or tests          | Revision/authority rejection                       |
| Storage                            | Disk full while recording intent         | No new external effect                             |
| Notification                       | Delivery endpoint unavailable            | Durable decision remains; mission stays safe       |

## Verification commands and infrastructure

For implementation, use the repository's published gates in
[docs/development/testing.md](../../docs/development/testing.md) and
[docs/development/contributing.md](../../docs/development/contributing.md).
Load registry environment before every package-manager operation. Never print
or replace it, and do not override it with a public registry.

```bash
if [[ -f .devcontainer/.env ]]; then
  set -a
  source .devcontainer/.env
  set +a
fi
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm smoke
pnpm docs:check
```

Run focused tests from the owning workspace so portal JSDOM configuration is
used; root Vitest invocation is not equivalent. New test names are to be added
during their phases. Reuse existing fixture helpers and test files before adding
parallel frameworks. Mutation tests use disposable `/tmp` repositories and
dedicated tmux server names, not the current checkout or live user's teams.

Required CI uses safe echo agents and no provider keys. Real-provider certification
is separate and must retain credentials only in private provider homes. External
certification records exact provider versions and capability observations; it
does not turn skipped/missing checks into a pass.

Validate APIs, CLI and generated docs, package content exclusion, release/adoption,
DB migration/reopen, reporter/gateway compatibility, provider-state isolation,
performance with many teams, event storms, and bounded transcript reads. Use
load fixtures to tune limits before making scalability claims.

For this documentation-only task, validate Markdown frontmatter, code fences,
headings, tables, links, requirement/phase references, and staged diff scope. Do
not claim the implementation gates above were run or passed by writing the plan.

## Rollout and rollback

Progressively enable: Foreman disabled, read-only/shadow recommendations,
supervised mutations, then bounded autonomous missions. Keep a repository kill
switch and per-mission pause/revoke controls independent of the Foreman process.
Do not enable an unattended provider lacking required reporting/input capability.

Rollback operationally means disable new Foreman effects, pause missions, retain
tasks/evidence/worktrees, drain or reconcile submitted actions, and return to
manual portal operation. Stopping Foreman must not destroy teams or mission state.
Revoking a grant fences queued work as well as future requests.

Do not assume an older binary can read a newly migrated actor/run schema. Before
upgrade, take a consistent supported backup and record schema/build identity.
Downgrade requires the documented compatibility path or restore of a stopped,
consistent snapshot after external effects are reconciled. Never roll the DB back
while leaving newer live tmux/provider state claiming the old identity.

Remove automatically created resources only after verified mission termination,
no active owners, preserved branches/evidence, checked provenance and revisions,
and explicit cleanup policy. Dirty or unowned resources require human review.

## Open decisions before implementation

* Select the first provider and reviewed native-input adapter; prototype against
  real prompt transitions before declaring unattended intervention supported.
* Review the actor/run table migration and stable public compatibility responses.
* Confirm template-managed runtime team lifecycle versus human adoption/export.
* Set initial trusted-local disclosures and the requirements for isolated mode.
* Decide local commit and branch/PR publication grants separately from team execution.
* Tune review/stagnation thresholds, intervention/recovery limits, and notification
  delivery from measured finite trials.

Suggested implementation order is P0 through P10. P3 can provide a supervised
Foreman workspace before broader autonomy; P7 observation can precede guarded
native input. Neither milestone should be advertised as a 24/7 operator replacement
until provisioning, supervision, intervention/recovery, and verification gates pass.

## Publication boundary

Commit and push only this plan and its companion research on
`planning/autonomous-foreman`. Existing portal mock changes remain local and
uncommitted. The tracking directory is ignored, so stage these exact documents
explicitly rather than changing ignore policy or adding all tracking artifacts.
No source implementation, config migration, provider launch, or mission execution
is included in the planning commit.
