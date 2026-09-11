---
title: Autonomous Foreman architecture research
description: Evidence and design decisions for a repository Foreman that supervises long-horizon team work
ms.date: 2026-09-11
ms.topic: concept
---

## Scope and status

Research and planning only. No implementation is authorized by this document.
The portal prototype remains uncommitted and is not part of the documentation
branch's publication. Implementation begins only after review of the completed
research and plan.

The requested outcome is a primary operator interaction point that can accept
a long-horizon objective, prepare team workspaces, select roles, delegate work,
monitor progress, recover eligible stalled agents, and present evidence of
completion while the operator is away. Foreman owns one dedicated repository
conversation and one native terminal, outside every team's broadcast audience.

The source baseline is Nanasa commit `cd6ecc702a656dd5238a080648231a9e96679165`.
Existing portal worktree changes are design experiments, not backend evidence.
Findings distinguish current source behavior from proposed contracts.

## Recommended architecture

Reuse the daemon's single-writer authority and existing domain services. Add a
repository-scoped Foreman principal, a durable mission controller, and explicit
authorization for bounded cross-team operations. Do not make Foreman an operator
token holder or a hidden ordinary team member.

Separate Foreman's judgment from execution guarantees. The agent decides how to
decompose objectives, assign roles, interpret evidence, intervene, and integrate
results. A daemon-owned mission controller persists tasks, operations, timers,
grants, budgets, and acceptance gates. Existing domain services remain the only
owners of Git, topology, provider state, terminals, exact actions, and recovery.

Keep the existing MCP endpoint and add a distinct authenticated Foreman principal
and tool pack. A new channel is a domain model, not a reason to create a second
server or control plane. Foreman should be allowed to create approved teams and
workspaces, inspect transcripts, send guarded input, and recover eligible agents.
Those capabilities explicitly supersede the earlier coordination-only mock idea.

Unattended operation means useful work inside a reviewed permission envelope,
not a guarantee of completion for every request. Foreman may block and await a
decision when identity, authority, evidence, budget, or effect certainty is
insufficient. It must never turn an unknown outcome into success to keep moving.

## Verified starting constraints

* [packages/contracts/src/config.ts](../../packages/contracts/src/config.ts)
  defines integrations, reusable roles, and group-owned agents. Roles describe
  instructions, permissions, and presentation; they do not create authority
  across groups.
* [apps/daemon/src/mcp-auth.ts](../../apps/daemon/src/mcp-auth.ts)
  authenticates operator or group-agent principals. Agent authentication checks
  current membership, active run, desired state, and exact generation. A new
  Foreman identity cannot pass this path without a deliberate contract change.
* [apps/daemon/src/actions/peer-capability-policy.ts](../../apps/daemon/src/actions/peer-capability-policy.ts)
  denies peer cross-group actions, working-target overrides, privileged wait
  decisions, unrestricted terminal access, and peer run control. Preserve these
  restrictions for ordinary agents.
* [apps/daemon/src/actions/agent-action-service.ts](../../apps/daemon/src/actions/agent-action-service.ts)
  requires a live target and current reporter before creating an exact action.
  Linked messages must belong to that target group. Cancellation after submission
  is not equivalent to cancelling an unsubmitted action.

## Source findings and corrections

### Identity and provider ownership

[apps/daemon/src/persistence/schema.ts](../../apps/daemon/src/persistence/schema.ts)
is at schema version 16. Runs require group/member IDs, messages reference groups,
and actions target group members. Reporter sessions reference runs. Provider
profiles are separate from memberships, providing a useful reuse boundary.

[apps/daemon/src/provider-runtime-provisioner.ts](../../apps/daemon/src/provider-runtime-provisioner.ts)
takes a run, membership, and provider profile. Private homes, model selection,
permission floors, prompts, native sessions, and provider files depend on that
membership. Generalize runtime ownership there rather than writing an independent
Foreman provider launcher.

[apps/daemon/src/instruction-resolver.ts](../../apps/daemon/src/instruction-resolver.ts)
orders built-in, global, group, role, and agent instructions, validates bounded
repository-relative files and ownership, and calculates a prompt digest. Foreman
needs its own instruction scope, not implicit inheritance from the selected team.

### Provisioning and checkout state

[apps/daemon/src/topology-service.ts](../../apps/daemon/src/topology-service.ts)
creates groups and members through YAML mutation. Reconciliation deletes groups
absent from authored config. Runtime team allocations therefore require an
explicit ownership change, not a direct insert into existing group tables.

[apps/daemon/src/config-repository.ts](../../apps/daemon/src/config-repository.ts)
rewrites selected top-level keys and checks the config revision before rename.
Adding schema fields alone is insufficient: parser, serialization, reconciliation,
manual edits, and concurrent writes must be covered.

[apps/daemon/src/git/worktree-service.ts](../../apps/daemon/src/git/worktree-service.ts)
serializes Git operations, validates branches and bases, records operation intent,
and recovers interrupted creation/removal. Create may return an existing worktree;
this is not evidence that a mission owns it.

[apps/daemon/src/git/checkout-service.ts](../../apps/daemon/src/git/checkout-service.ts)
rechecks checkout/repository identity. `assignGroupCheckout` in
[apps/daemon/src/run-runtime-coordinator.ts](../../apps/daemon/src/run-runtime-coordinator.ts)
uses expected checkout revisions and explicit require-stopped, stop-and-switch,
or stop-switch-restart policies. Partial failure may leave some actors stopped.
Failed restart does not undo a successfully changed binding.

### Work dispatch is not task queueing

[apps/daemon/src/actions/agent-action-scheduler.ts](../../apps/daemon/src/actions/agent-action-scheduler.ts)
defers starting actors but rejects a working target without `allowWorking`.
The existing action queue is not a general wait-until-idle task queue. Missions
need durable queued tasks above exact actions; pin the target run only when it
is eligible. Never emulate queueing by repeatedly resubmitting rejected actions.

The portal mock's message-then-action path can create two input paths and partially
succeed. Production delegation must record one communication item and one execution
intent, with linked communication excluded from independent terminal dispatch.
One action owns the task input effect. A human Message remains communication-only.

Progress reports in
[packages/contracts/src/status.ts](../../packages/contracts/src/status.ts)
have stage, summary, next step, blocker, and outcome but lack mission/task IDs.
Threaded progress needs validated correlation and bounded history. Do not join
reports to tasks by alias, latest message, or nearest timestamp.

### Recovery and input ownership

The runtime coordinator distinguishes present, missing, dead, and indeterminate
processes. It confirms missing panes, supports native-session recovery, respects
launch consent, and bounds attempts/cooldowns. It does not implement general
reasoning about a live but unproductive agent.

[apps/daemon/src/terminal/terminal-input-arbiter.ts](../../apps/daemon/src/terminal/terminal-input-arbiter.ts)
serializes automated writes and checks interactive controller leases. It does not
provide a mission-wide manual takeover policy. Human takeover needs an explicit
supervision inhibit, not just mutual exclusion while bytes are being written.

[apps/daemon/src/terminal/terminal-read-service.ts](../../apps/daemon/src/terminal/terminal-read-service.ts)
already reads visible, history, or alternate-screen content. Requests default to
200 lines and 65,536 bytes, bounded by contracts. Results contain run/generation,
binding, capture time, size, truncation, and alternate-screen state. Checkpoints
are opt-in and owner-scoped. The read method itself takes no principal; a new
Foreman tool must add authorization, freshness, and current-owner checks.

[apps/daemon/src/actions/agent-open-wait-service.ts](../../apps/daemon/src/actions/agent-open-wait-service.ts)
already guards typed replies with exact wait, reporter, process, and generation
checks. Reuse it for supported waits. Generic terminal text must not be a shortcut
around permission or plan-approval boundaries.

### MCP and host trust

[apps/daemon/src/mcp-server.ts](../../apps/daemon/src/mcp-server.ts)
creates principal-specific servers on a stateless HTTP handler with Host/Origin
validation and a 30-request-per-minute principal limit.
[apps/daemon/src/mcp/tool-registry.ts](../../apps/daemon/src/mcp/tool-registry.ts)
centralizes tool schemas, scopes, and eligibility. Reuse these abstractions,
but enforce permissions in services as well as in tool discovery.

Current agent capabilities include issue time but no explicit expiration field;
validity depends on current membership/run. Foreman tokens should add audience,
expiry, and authorization revision. This is a proposed extension, not an existing
guarantee.

[docs/concepts/security.md](../../docs/concepts/security.md) states that all
agents run under the same OS user. An unrestricted native shell can bypass MCP
restrictions through accessible files, credentials, Git, or daemon processes.
Trusted-local mode must disclose that limit. High-assurance unattended mode needs
process isolation; worktrees and read-only prompts are not a hostile-code sandbox.

## External evidence

CCCC was reviewed at commit
[`22733e9`](https://github.com/ChesterRa/cccc/tree/22733e9ac607989bb095a4a6b7cb0e518bab9d08).
Its [CCCS v1 standard](https://github.com/ChesterRa/cccc/blob/22733e9ac607989bb095a4a6b7cb0e518bab9d08/docs/standards/CCCS_V1.md)
defines group-owned foreman/peer actors, not a repository supervisor. It separates
runtime delivery, explicit Mail consumption, replies, and tasks. Current normative
Mail cursors are Mail-only; older release-note descriptions of PTY read marking
must not be treated as current receipt semantics.

CCCC's [agent help](https://github.com/ChesterRa/cccc/blob/22733e9ac607989bb095a4a6b7cb0e518bab9d08/resources/cccc-help.md)
assigns Foreman integration and acceptance, requires explicit outcome/owner/done
criteria, and treats peer reports as evidence rather than closure. Bootstrap
restores tasks, decisions, open loops, and commitments. Adopt those concepts,
not its group membership or broad documented peer restart permissions.

Anthropic's [long-running harness guidance](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)
(November 26, 2025) identifies partial work across context windows, premature
completion, and weak end-to-end testing. Its remedies are incremental tasks,
durable handoffs, explicit feature criteria, and user-workflow verification.
For Nanasa, store those facts structurally and prevent the producing agent from
weakening acceptance criteria. The article is guidance, not empirical proof of
reliable unattended multi-team completion.

Temporal's [workflow execution overview](https://docs.temporal.io/workflow-execution)
separates durable transitions, commands, timers, and replay. Use those semantics
without requiring a Temporal deployment: SQLite plus a bounded mission state
machine fits Nanasa's current single-daemon architecture. Replay recorded intent
and effects, not nondeterministic LLM reasoning or ambiguous terminal/Git writes.

The [MCP authorization specification](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization)
requires audience validation and rejects token passthrough for OAuth deployments.
Apply that separation of caller and resource authority. Nanasa's managed local
capabilities are not a full OAuth server; generic remote-client OAuth discovery
and flows remain a separate compatibility requirement.

## Configuration and actor model

### Versioned authoring

Propose config version 3 with optional `foreman`, `teamTemplates`, and role
coordination hints. Retain `integrations` as the provider configuration map:
Foreman references an existing integration through `integrationId`. A wholesale
rename from integrations to providers is unrelated migration work.

Accept v2 through tested normalization with Foreman disabled. Offer an explicit
conversion preview and write with expected revision; never rewrite YAML on
startup. Authored policy holds authority ceilings. Mission grants and local
checkout IDs remain in daemon state, not checked-in YAML.

The sketch below is proposed syntax, not configuration accepted today. The
referenced integration/role definitions must already exist and pass preflight.

```yaml
version: 3
foreman:
  id: repository-foreman
  name: Foreman
  enabled: true
  integrationId: coordinator-provider
  instructions:
    - .nanasa/instructions/foreman.md
  supervision:
    reconcileIntervalSeconds: 30
    reviewIntervalSeconds: 300
    staleProgressSeconds: 900
  autonomy:
    mode: supervised
    permittedTeamTemplates: [delivery-team]
    workspacePolicy: managed-only
    maxActiveMissions: 1
    maxTeamsPerMission: 3
    maxConcurrentTasks: 4
    maxMissionHours: 24
    maxForemanTurns: 200
    transcript:
      access: mission-owned
      maxLines: 200
      maxBytes: 65536
    intervention:
      idlePrompt: true
      routineWaitReply: true
      nativeInput: approved-adapter-only
      maxPerIncident: 2
    recovery:
      restartMissionOwnedAgents: true
      maxAttemptsPerIncident: 2
      maxAttemptsPerMission: 6
      cooldownSeconds: 120
teamTemplates:
  delivery-team:
    instructions:
      - .nanasa/instructions/delivery-team.md
    members:
      builder:
        integrationId: implementation-provider
        roleId: implementor
      reviewer:
        integrationId: review-provider
        roleId: reviewer
```

The proposed limits are initial conservative settings to measure, not guaranteed
optimal defaults. `supervised` requires approval of mutations; opt-in bounded
mode permits preauthorized effects. Enabling Foreman does not authorize unlimited
work. A human-approved mission grant selects a subset of policy, including bases,
branch namespace, templates, resource ownership, effects, duration, and budgets.

### Instructions, credentials, and runtime owner

Compose built-in Foreman protocol, repository-global instructions, and
Foreman-specific instructions. Mission briefs, transcript captures, and team
content are lower-trust contextual data with provenance. Team selection in the
portal must not replace Foreman's instructions or change its working directory.

Use a stable private coordination workspace and provider home keyed by repository
and Foreman actor ID, separate from team worktrees and shared integration homes.
Reuse provider-file composition, launch snapshots, model selection, reporter
bootstrap, and environment-referenced tokens. Add Foreman-aware auth/setup/doctor
commands rather than borrowing a team agent's account/session.

Introduce an internal discriminated runtime owner: team member or repository
Foreman. Add stable actor records, backfill existing membership identities, and
link runs to owners without changing historical run IDs or generations. Preserve
conditional group constraints and uniqueness; do not make every identity field
an arbitrary nullable string. Group API responses stay group-shaped and filtered;
new Foreman routes expose the repository actor separately.

Generalize shared runtime operations rather than duplicate them. Migration must
cover provider homes, native sessions, reporter identity, launch consent, model
source labels, status/progress, URL requests, terminal endpoints, checkpoints,
recovery, package upgrade/adoption, and shutdown. This is the highest-risk phase.

## Mission, task, and durable operation records

A mission is durable operator intent, not one provider turn. Store objective,
constraints, immutable acceptance revision, grant, priority, owned resources,
budgets, checkpoints, dependencies, due reviews, and final evidence. Foreman
may revise its plan; it cannot expand the grant or weaken acceptance.

Proposed mission states: draft, planning, ready, running, waiting, verifying,
awaiting-acceptance, completed, blocked, paused, cancelling, cancelled, failed.
The daemon validates transitions and prerequisites. A completion report cannot
skip verification.

Tasks contain scope, required role/capabilities, dependencies, owner history,
checkout/base revision, attempt references, deadlines, and evidence. Proposed
states: queued, assigned, running, blocked, verifying, accepted, failed,
cancelled, superseded. Enforce acyclic dependencies and one execution owner.
Independent reviewer requirements must not be satisfied by the producing actor.

Persist operation intent before any mutation. Each operation stores mission,
principal, grant revision, target identities, payload digest, expected revisions,
attempt count, state, and effect receipts. DB-only operations may be atomic;
Git/terminal/config/process effects require recoverable multi-step journals.
Unknown outcomes are not retryable by default. Mission pause/revoke is rechecked
at the execution boundary, including already-queued operations.

A durable mission queue reserves target capacity before creating an exact action.
Busy targets wait at task level. A replaced run invalidates its old action; create
a linked new attempt only after reconciling previous effects and remaining work.

One Foreman runtime initially serves the repository. Serialize reasoning turns
with explicit mission IDs and fairness across active missions. Persist bounded
mission briefs, decision logs, unresolved questions, artifacts, checkpoint schema,
and event cursors. On restart, reconstruct from those records and fresh external
observations. Missing history requires snapshot reconciliation, not guessed memory.

## Team provisioning and role selection

Keep hand-authored groups in config and allocate mission teams from approved
templates in SQLite. Persist origin, mission ID, template revision, and generated
member identity. Extend topology reconciliation to combine authored groups and
active runtime allocations, so YAML reload cannot delete a mission team.

This is an explicit architectural extension, not reuse of `createGroup` unchanged.
Use a reserved ID namespace, reject collisions, and make export-to-config an
operator action. Manual edits/deletion suspend affected operations until ownership
is reconciled. Existing active human teams need an adoption grant.

Provision through prepare/execute semantics:

1. Reserve allowed template, resource capacity, and mission-owned branch namespace.
2. Resolve an approved base to an immutable commit and validate repository identity.
3. Create a managed worktree, or explicitly adopt an authorized existing checkout.
4. Allocate the team and roles without starting processes.
5. Assign the checkout with expected revision and require-stopped policy.
6. Provision private homes, prompts, provider files, credentials, and reporters.
7. Start actors, confirm readiness, and release eligible tasks for dispatch.

Record results after every step. After a crash, inspect effects before replay.
Preserve branches, existing worktrees, and dirty changes on partial failure.
No automatic force-clean or branch deletion. Separate teams get separate
worktrees; members inside a team share a checkout, so file ownership or serialized
writers are needed for overlapping tasks. Shared primary checkouts are not the
default autonomous target.

Foreman discovers roles from IDs, descriptions, instructions, permission floors,
provider capabilities, and live readiness, not alias heuristics. Optional role
tags and concurrency hints aid selection but grant no authority. Foreman proposes
task assignments; the daemon validates template slots, capabilities, scope,
capacity, independent review, and checkout ownership. Missing roles lead to a
permitted template allocation or a blocked request, never an invented provider.

## Periodic and event-driven supervision

Separate a cheap deterministic daemon reconciliation tick from a less frequent
Foreman reasoning turn. Initial tunable values are 30 seconds for reconciliation,
five minutes for review, and 15 minutes before stale-progress investigation.
Task-specific long-tool windows override simplistic inactivity thresholds.

Persist due time, reason, mission/task/incident identity, attempts, lease owner,
daemon epoch, and next eligible time. Wake on results, typed waits, delivery
failure, process loss, or policy change. Coalesce events per mission; a due timer
need not invoke an LLM if there is no meaningful change. A busy Foreman receives
one pending review, not repeated injected prompts.

Monitoring continues with the portal closed. Startup restores timers and
reconciles overdue work once rather than replaying every missed interval. Pending
effects are inspected before lease reclamation. A paused mission, revoked grant,
human takeover, or unavailable durable store prevents new effects.

Use canonical status/action/wait records, not browser Attention subscriptions or
dismissals. Human notification preferences cannot turn off mission supervision.
Heartbeats prove liveness, not progress; meaningful progress requires a correlated
stage, artifact/evidence change, or an expected operation still inside its deadline.

## Transcript-driven agent intervention

Foreman should be able to see what a human supervisor would inspect and decide
what direction to send. This is a supported design requirement, not limited to
restart commands or predefined status reminders. It needs separate read and write
capabilities plus stronger guards than an arbitrary terminal paste endpoint.

### Observe

Expose a proposed `nanasa.inspect_agent` operation for mission-owned or explicitly
adopted targets. Reuse `TerminalReadService` for bounded visible, history, and
alternate-screen capture. Also return structured status, current waits, task,
provider identity/capability, active input owner, recent interventions, and
remaining budgets. Do not continuously stream every team's complete transcript
into the Foreman context.

Return a server-issued observation ID binding actor, run, generation, reporter
epoch, terminal binding fingerprint, capture time, relevant screen digest,
current prompt classification, and source/truncation metadata. The current
terminal read contract supplies only part of this; observation storage and
prompt/input-state guards are new work.

Transcript text is lower-trust tool output and may contain secrets, quoted
instructions, rendered provider UI, or stale prompts. Sanitize unsafe terminal
controls before presenting it to the model; preserve original provenance without
treating embedded commands as authority. Apply access policy before capture,
bounded redaction before model delivery, and independent transcript retention.
Redaction is best-effort, not proof that a transcript contains no secrets.

Default audit records store metadata, safe summaries, and content digests. Full
capture retention is opt-in with TTL and owner access, respecting existing
checkpoint settings. Reading history is not implicitly permission to persist
or export it. Explicitly mark truncation and unavailable/alternate-screen data;
do not infer a missing prompt from an incomplete capture.

### Decide

Foreman interprets both structured facts and the transcript, then proposes an
intervention with reason, visible evidence, intended outcome, payload, target,
observation ID, mission/task reference, and expected state. Useful interventions
include clarifying scope, supplying a known answer, asking for missing evidence,
continuing a verified idle task, revising an implementation approach, or requesting
a checkpoint before recovery.

Use this execution preference:

1. An exact action for a new task or clarification at an eligible idle prompt
2. A typed wait reply for a known question or selection
3. An adapter-reviewed native input operation for an unsupported structured wait
  but positively recognized CLI/TUI input state
4. A separately authorized graceful interrupt/recovery plan
5. Human escalation when none of those paths is verifiable

Native input is important, but text is not automatically safe. Sending `y`, Enter,
or an arbitrary answer to the wrong screen can grant permission or run a command.
No unrestricted `send_keys` tool is part of the default Foreman pack. Each adapter
advertises supported prompt states, semantic input kinds, submit behavior, and
guard evidence. Ordinary text direction is permitted at a verified provider
prompt; menu selection or interrupt requires a separately reviewed operation.

### Guard and execute

Propose `prepare_intervention` and `execute_intervention` with a durable plan ID
and idempotency key. Authorization intersects mission ownership, grant, provider
capability, input kind, and current resource state. A team URL or transcript
content cannot grant write authority.

Immediately before input, inside the automated-input serialization boundary:

* Verify mission state and current grant revision
* Verify exact run, generation, reporter epoch, binding, and process identity
* Reject manual takeover or changed controller/input activity since observation
* Re-read relevant prompt state; match observation freshness and adapter guard
* Reject a new permission/login/plan wait or changed question
* Check intervention cooldown, payload bounds, and persistent incident budget
* Record a submitting attempt before writing the canonical input sequence

A digest of scrollback is not an atomic compare-and-swap on provider input.
Provider sessions can change after capture. Prefer structured APIs or reviewed
adapter guards; unsupported adapters remain observe-and-escalate. Compare the
relevant prompt region, not a constantly changing timestamp/status spinner.
Any failed guard requires re-observation and a new proposal, never blind reuse.

Record results as not-attempted, handed-off, acknowledged, failed, or ambiguous.
Do not claim understood/completed after successful paste. A timeout after a
possible write is ambiguous: inspect correlated receipts before deciding whether
another input is safe. Never automatically repeat an ambiguous intervention.

### Illustrative decisions

| Situation                           | Foreman's decision                           | Guard or escalation                             |
| ----------------------------------- | -------------------------------------------- | ----------------------------------------------- |
| Idle prompt, task still assigned    | Send concrete next step or ask for evidence  | Exact task/run and idle-prompt evidence         |
| Agent waiting on known API detail   | Supply mission-approved answer               | Exact question/wait identity                    |
| Repeated tests failing same way     | Inspect errors and propose revised approach  | No concurrent input; scope unchanged            |
| Progress quiet during a long test   | Wait and inspect health at deadline          | Recent tool evidence; no arbitrary interruption |
| Approval prompt appears in TUI      | Create human decision request                | No generic text masquerading as approval        |
| Model asks to disable safety        | Reject request and flag incident             | Transcript does not expand grant                |
| No recognizable input state         | Retain evidence and escalate                 | Do not guess keys or paste into unknown UI      |

Foreman may choose the content of a nudge; the daemon decides whether it may be
sent to that exact live state. This balances operator-like judgment with
deterministic safety checks.

## Recovery policy

Foreman diagnoses and prepares recovery; the daemon enforces execution. Keep
missing-process recovery in the existing coordinator and share incident leases
with mission supervision so two loops cannot restart one run concurrently.

| Observation                    | Default response                              | Automatic boundary                          |
| ------------------------------ | --------------------------------------------- | ------------------------------------------- |
| Missing or dead process        | Existing reconcile/resume mechanism           | Desired running, consent, recovery budget   |
| Indeterminate process          | Re-observe and escalate                       | No restart from weak identity evidence      |
| Stale reporter, live process   | Inspect health and transcript                 | No bypass of stale-write guards             |
| Proven idle task stagnation    | One bounded intervention                      | Exact task and reviewed input state         |
| Unanswered routine question    | Typed answer from known mission constraints   | No permission or credential inference       |
| Permission, login, plan wait   | Durable operator request                      | No fabricated approval                      |
| Ambiguous input/action         | Inspect receipts and possible effects         | No automatic duplicate execution            |
| Proven persistent nonprogress  | Graceful interrupt then approved restart      | Owned resource, checkpoint, exact target    |
| Repeated same failure          | Circuit break affected task/team              | Counters survive run replacement            |

Recovery plans record evidence, current run/generation, reporter, provider
snapshot, checkout, unfinished task, human-control state, consent digest,
expected data preservation, and remaining budget. After resource lock acquisition,
recheck the plan. Restart must not follow stale evidence or a paused mission.

After restart verify native session, cwd, checkout, provider snapshot, credentials,
and reporter readiness. Preserve completed work and inspect unfinished effects.
Create a new task attempt only if the prior attempt's outcome permits it; never
replay all historical messages into a replacement runtime.

Foreman itself can fail. The daemon restores its run and reconstructs missions
from durable state. If it cannot recover within limits, bounded worker tasks may
finish but new coordination pauses with a persistent incident. No infinite
self-restart loop or second unconstrained supervisor.

## Foreman capabilities and MCP

### Authority model

Keep human, Foreman, and team-agent principals distinct. Authorization is the
intersection of repository policy, mission grant, resource ownership, provider
capability, and operation guards. Revocation is effective at dispatch. Ordinary
agents retain current cross-team denials and cannot masquerade as Foreman.

| Capability                   | Bounded autonomous permission                  | Escalation                                       |
| ---------------------------- | ---------------------------------------------- | ------------------------------------------------ |
| Discover teams and roles     | Authorized summary reads across repository     | Restricted or sensitive details                  |
| Create team/worktree         | Approved template, base, namespace, budget     | New provider, human checkout, conflict           |
| Start or stop actors         | Mission-owned, pretrusted, exact identity      | Human takeover, shared ownership, new consent    |
| Assign and reprioritize      | Existing scope and immutable acceptance        | Objective or permission expansion                |
| Inspect transcript           | Bounded mission-target capture                 | Unauthorized target or disallowed persistence    |
| Intervene with input         | Reviewed adapter, fresh observation, grant     | Unknown prompt, login, approval, ambiguous write |
| Recover agent                | Diagnosed plan, cooldown, incident budget      | Data-loss risk or uncertain old effects          |
| Verify and integrate         | Pinned candidate, approved recipe/workspace    | Missing evidence or changed acceptance policy    |
| Prepare local commits        | Explicit Git grant and owned candidate         | Human changes, secrets, protected paths          |
| Publish branch or PR         | Separate publication grant                     | External visibility not preauthorized            |
| Merge, deploy, destroy       | Off by default                                 | Operation-specific approval                      |

Other valuable capabilities are dependency deadlock detection, duplicate-work
prevention, queue fairness, reallocation after failure, bounded artifact inspection,
budget forecasting, resource cleanup proposals, change-risk summaries, and
resumable operator decisions. They belong in mission records and checked services,
not scripts that bypass the control plane.

### Tool families

Reuse `/mcp` with per-principal registration and service-layer authorization.
New endpoint aliases, if ever needed, must share the same daemon and services.
The following names describe proposed tools, not existing contracts:

* `foreman_bootstrap`: bounded inbox, missions, authority, checkpoint, and cursor
* `list_teams`, `get_team_context`: roles, capacity, checkout, status, permitted evidence
* `plan_mission`, `revise_mission_plan`: task/dependency proposals without grant expansion
* `prepare_team`, `execute_team_plan`: checked provisioning operations
* `assign_task`: durable intent and role/actor selection
* `get_mission`, `get_operation`: bounded progress and effect reconciliation
* `inspect_agent`, `prepare_intervention`, `execute_intervention`: transcript-to-input path
* `diagnose_agent`, `prepare_recovery`, `execute_recovery`: diagnosed runtime recovery
* `request_decision`: durable human request with affected identities and exact payload
* `record_evidence`, `propose_completion`: claims subject to acceptance validation
* `foreman_reply`: authored reply in the repository conversation
* `report_task_progress`, `escalate_to_foreman`: worker tools restricted to owned tasks

Use the `nanasa.` namespace. Tool inputs carry explicit mission/task and resource
IDs; the caller cannot choose trusted sender identity. Long operations return
operation IDs with pending/blocked/ambiguous/failed/succeeded states. Bound wait
calls and page sizes; do not hold an MCP request open for a whole mission.

Foreman credentials bind actor kind, repository, run/generation, audience,
issue/expiry times, nonce, and authorization revision. Resolve grants server-side
on every effect. Keep operator, Foreman, worker, and reporter credentials separate;
never pass Foreman's token to a worker. Add Foreman-specific rate keys and bounded
batch summary reads without removing normal-agent limits.

### Permission and isolation limits

Provider read-only settings and MCP scopes do not prevent arbitrary native shell
access under the same OS user. Trusted-local mode must state this clearly.
Certified isolated mode needs restricted mounts, credentials, processes, network,
and a narrow authenticated daemon connection. No claim of complete least privilege
is justified by prompt instructions or worktree placement alone.

Preflight exposes effective provider approval settings. If an adapter cannot allow
needed MCP operations without unrestricted native approvals, block unattended mode
or obtain an informed separate grant; never silently enable a bypass flag.

Human-authored mission constraints and control-plane grants outrank team output,
transcripts, repository content, and model requests. Those inputs cannot expand
authority, rewrite acceptance, or approve themselves. Audit visible reasons and
evidence references, not secrets or hidden reasoning.

## Channel, Terminal, and human control

One stable Foreman Channel exists per repository. Mission and team references
scope individual threads without adding Foreman to group broadcasts. A team's
Everyone audience contains only that team's members. Worker escalations and
Foreman delegations use explicit provenance-linked communication.

Use repository-scoped message records for the genuinely new domain while retaining
team message APIs and persistence. Share validation/rendering where suitable,
not duplicate durable messages. Cross-scope provenance is not a foreign key into
group-only reply ancestry. Retain mission evidence references when routine chat
retention advances, or block with evidence-unavailable rather than inventing data.

Selecting `/foreman?team=...` grants no authority. The server validates actual
reads against policy and ownership. Unknown/deleted team context is explicitly
unavailable, not silently replaced with unrestricted repository context.

Channel and Terminal refer to one Foreman run and provider session. Terminal is
the native CLI/TUI gateway with control/observe, focus, sizing, effects, reconnect,
and generation fencing. No second textarea or input simulation is needed. Native
input is not itself a mission mutation or durable completion receipt.

Explicit human Take over pauses autonomous input and disruptive operations for
the resource. Viewing a terminal does not stop overnight supervision. Resume
reconciles manual changes and rechecks grants. Human pause/revoke prevents new
effects, but already-submitted work needs truthful cancellation acknowledgement
or a final outcome; it cannot be declared cancelled solely by hiding UI state.

Keep Foreman in Coordination with one-click entry from team views and return links
to Messages and exact terminals. Production must replace fixture conversation and
healthy-looking mock badges with canonical mission/status facts. Show next review,
pending decisions, budgets, supervision hold, and intervention provenance.

## Completion and operating limits

Completion requires accepted mandatory tasks, reconciled dependencies, checks on
a pinned integration candidate, required independent review, unchanged acceptance
revision, and no unresolved mandatory decision or ambiguous effect. Foreman
proposes completion; the daemon verifies structural evidence gates. A human may
require final acceptance or preauthorize the criteria. A reviewer adds evidence,
not a guarantee of correctness.

Use approved verification recipes with command, cwd, timeout, and execution/network
policy. Record exit status, candidate commit, artifact digests, reviewer identity,
residual risk, and recipe/acceptance revisions. Reject weakened tests, stale
candidate receipts, or changed recipes until reviewed.

First unattended release ends at a verified candidate ready for review. Integration
uses exact team commits in an owned integration worktree and bounded corrective
tasks. Publishing branches, creating PRs, protected-branch merges, releases, and
deployment require separate grants; no force push or destructive cleanup default.

Persist mission-wide limits on elapsed time, Foreman turns, tasks, agents, worktrees,
storage, nudges, interventions, and recovery. Counters survive restarts and new run
generations. Token/cost accounting depends on provider support: mark unknown usage
and enforce hard currency caps only with certified complete metering. Otherwise
use time/turn/resource limits without promising an exact spend ceiling.

Store incidents and pending decisions whether or not a browser is open. Existing
browser notifications require an open tab; offline notification is not solved by
that mechanism. An opt-in durable outbox adapter may deliver redacted webhooks or
other notifications with bounded retry. Mission safety never depends on successful
notification delivery.

## Decisions and review gates

Decided direction: one optional repository actor; shared runtime/provider services;
one MCP endpoint with explicit Foreman principal; daemon-owned missions, tasks,
timers and operations; template-based runtime teams; managed workspaces; guarded
transcript/input interventions; bounded recovery; evidence-based completion; and
retained human takeover.

Before enabling autonomous mutation, review the concrete owner migration,
first certified provider, native input guards, trusted-local versus isolated
execution claims, default limits, notification path, and publication policy.
These are gates, not omissions from the intended unattended workflow.

This research inspected source and published guidance. It did not empirically
certify provider autonomy, transcript interpretation, overnight reliability, or
fault recovery. Proposed configuration, tools, state names, and limits are not
released contracts. Implementation remains subject to approval of
[autonomous-foreman-plan.md](../plans/autonomous-foreman-plan.md).
