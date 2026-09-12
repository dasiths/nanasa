# Delegate repository goals with Foreman

Foreman is a repository-owned coding-agent process. It has a private provider
home, its own MCP principal, and a durable channel outside every team. Team
broadcasts do not include it. Channel and Terminal address the same native run.

This development change retains configuration version 2 and database version 16.
Databases created before goal delegation need a fresh state directory. Preserve
existing state before switching; Nanasa does not migrate or delete it automatically.

## Delegate an outcome

Give Foreman a high-level goal through Channel, or open **Goals > New goal**.
Research documents and implementation plans are optional. Foreman proposes an
outcome; approve its objective, constraints and policy limits in Goals. Approval
does not authorize arbitrary teams or change provider permissions.

Foreman discovers live teams, role descriptions, permissions, readiness and
reservations, then proposes a specific accountable member with a rationale.
Approve that team and its current checkout through the resulting decision.
Nanasa reserves the team and checkout and dispatches one exact-runtime handoff.
It can start never-launched members after approval, but does not undo a Human's
explicit stop. Existing unsettled work, changed membership, shared active
checkouts and Human terminal control prevent dispatch.

The accountable member owns research, planning, implementation, peer assignment,
independent review and validation. Foreman supervises health and progress rather
than constructing the team's task graph. The team reports acceptance, plans,
milestones and blockers through built-in MCP tools. Plans can evolve inside the
approved objective; additional authority requires Human input.

Goal-linked peer actions share the concurrency budget and are checked again
before native input. Pause, cancellation and blocking Human decisions fence new
automated work. Already-submitted provider work is not forcibly interrupted;
use the existing terminal or run controls when an immediate interruption is
needed. After cancellation, restart old team runtimes or authorize a new
delegation before reusing their peer-action authority.

Completion requires evidence from the accountable member and an independent
reviewer for the same clean committed checkout. Nanasa refreshes checkout state
before accepting review or ready reports and rechecks it at Human acceptance.
Evidence is still an agent report, not proof of specification conformance.
Inspect test results, review references and residual risks before accepting.

## Supervise multiple teams

One Foreman can supervise several teams in parallel. Assign different teams to
separate goals, or delegate distinct workstreams of one goal to multiple team
leads. Each team owns its internal plan and peer assignments. Foreman compares
progress and handles cross-team decisions without replacing the team leads.

Set **Concurrent goals**, **Teams per goal**, and **Concurrent actions per goal**
under Settings. `maxActiveGoals` counts every nonterminal goal, including proposed,
paused and blocked ones. Action capacity is shared across the teams of each goal,
not across the entire repository. New goals capture the current limits; increasing
settings does not rewrite existing goal grants.

A team and its checkout can be reserved by only one unfinished delegation.
Paused and ready delegations keep their reservation. Use separate available teams
and checkouts for concurrent goals; teams cannot silently switch between goals.
Each proposed delegation still needs Human approval.

Team-specific decisions and progress reports stay scoped to that team. A pending
question from one team does not prevent another from making progress or reporting
ready. Goal-wide questions block every team on that goal. Pausing one goal leaves
other goals running. A shared goal reaches acceptance only after all its teams are
ready; evidence from separate checkouts alone does not prove cross-team integration.

Foreman has one native model session, so its review turns are serialized even
while teams execute concurrently. Duplicate wakeups for the same pending review
are coalesced without consuming additional review budget. An ambiguous terminal
write still blocks further Foreman input until inspected; this does not forcibly
stop already-running team work. Large-scale throughput and overnight model
judgment are not certified by the deterministic multi-team tests.

## Supervise across sessions

Goals, owners, reports, decisions, notifications and peer-action links survive
daemon restarts. Team members discover their delegation on launch or recovery.
An individual model turn ending does not complete the outcome. Uncertain action
submission is retained, not replayed automatically.

Daemon-owned review prompts wake Foreman periodically. Reports distinguish
progress checkpoints from process heartbeats. Healthy long-running work does
not itself authorize intervention. Foreman can inspect bounded team status and
transcripts; discretionary idle check-ins target only the accountable member.
They require bounded mode and `autonomy.intervention.idlePrompt: true` and obey
the intervention budget and cooldown. Automatic team recovery likewise requires
bounded mode and `autonomy.recovery.restartDelegatedAgents: true`; attempts
and cooldowns persist. The example's supervised defaults do not enable either.

Human questions have stable IDs, options or free-text answers, revisions and a
durable resolution. Blocking questions stop dependent automated work. A resolved
question queues a one-time context notification for the accountable member when
its exact runtime is idle and Foreman authority is available. It never answers
a native permission prompt. Silence is not approval. Pause makes outstanding
decisions stale; unresolved questions must be raised again after reconciliation.

## External channel boundary

The daemon exposes a transport-neutral notification feed at
`GET /api/v1/foreman/notifications?after=0&limit=50`. Consumers catch up using
`nextAfter`, then acknowledge processed records with
`POST /api/v1/foreman/notifications/ack`. Cursors are independent per connector.
Acknowledgement means the consumer processed a notification, not that the Human
read it or approved a decision. Delivery attempts, backoff and external message
IDs belong to the future adapter; use at-least-once delivery with deduplication.

A local operator can issue an expiring credential through
`POST /api/v1/foreman/connectors`, providing `principalId`, `name`, `scopes` and
optional `expiresInHours` (maximum 720). The credential is returned once; only its
hash is stored. List metadata or revoke a connector through the same resource.
Scopes are `notifications`, `conversation`, `goals`, `decisions` and `control`.
Connectors cannot access arbitrary terminals, configuration, snapshots, provider
credentials or connector administration. Use one credential per authenticated
human binding, not a bot-wide credential shared across unrelated chat users.

Notification summaries may contain repository information. Grant external
access only after deciding what may leave the machine, and have the adapter
filter or redact content before transmission. Goal and conversation scopes
deliberately expose more content than notifications. No Telegram integration,
external delivery worker or automatic secret-redaction guarantee is included.

Chat remains separate from authority. Decision replies use
`POST /api/v1/foreman/decisions/resolve` with the request ID and expected revision.
A stale answer is rejected even if its external button is still visible.
Explicit goal control uses `/api/v1/foreman/goals/control`; it does not wait for
the model to become idle. Portal and future channels operate on the same records.

## What team members know

Nanasa automatically injects Foreman awareness into team-member prompts and MCP
initialization. No user-authored instruction file is required. The built-in
guidance covers `nanasa.team_delegations`, `nanasa.report_delegation` and
`nanasa.request_human_decision`, as well as Foreman's separation from team managers,
peer discovery and broadcasts. Role metadata describes project responsibilities;
the coordination protocol itself comes from Nanasa.

Team members report runtime status through `nanasa.report_progress` and durable
goal progress through `nanasa.report_delegation`. They use
`nanasa.request_human_decision` for scoped questions. These are not unrestricted
DMs or immediate-response guarantees. Foreman-only tools remain separate from
team-member authority.

## Configure and authenticate

Use configuration version 2. Choose an existing integration and describe the
roles of your configured team members. Foreman inherits global and Foreman-specific
instruction files, not a selected team's instructions.

```yaml
version: 2
integrations:
  copilot:
    name: GitHub Copilot
    kind: copilot
roles:
  engineer:
    name: Engineer
  reviewer:
    name: Reviewer
    permissionPolicy: read-only
foreman:
  integrationId: copilot
  enabled: true
  instructions: []
  supervision:
    reconcileIntervalSeconds: 30
    reviewIntervalSeconds: 300
    maxRecoveryAttempts: 3
    recoveryCooldownSeconds: 120
  autonomy:
    mode: supervised
    maxActiveGoals: 1
    maxTeamsPerGoal: 3
    maxConcurrentActions: 4
    maxGoalHours: 24
    maxForemanTurns: 200
groups: {}
```

Run setup, then authenticate the selected integration in Foreman's private home:

```bash
nanasa setup
nanasa auth login copilot --foreman
nanasa doctor
nanasa start --mcp
```

Stop Foreman before logging in or changing its settings. Do not combine
`--foreman` with `--agent`. Integration-shared authentication does not populate
Foreman's private home. Nanasa does not copy provider credentials between homes.

Open an authenticated portal session and choose **Coordination > Foreman**.
Settings select the provider, model, instruction paths, goal limits, and optional
supervision actions. Save settings while stopped, then choose **Start**. Custom
Foreman launchers currently block with `foreman_launch_consent_required`; use
the integration's built-in command. No operator token is given to Foreman.

## Use Channel and Terminal

Channel stores operator instructions and Foreman replies with stable sequence
numbers. Retrying the same request ID and content does not duplicate a message.
Team context is provenance only: it grants no permissions and changes no cwd.

Input remains queued until Foreman has a current, verified, idle reporter and no
human terminal controller. Submitted means terminal input completed, not that
the provider accepted or completed the work. A Foreman MCP reply settles its
channel instruction. Only one unresolved input is dispatched at a time.

Terminal uses the normal native terminal controller and observer leases. There
is no separate CLI command composer. Switch to observe mode, or leave Terminal,
to allow automatic input after the provider becomes idle again.

If a write is interrupted, Nanasa records it as ambiguous and does not replay
it. Inspect Terminal and the transcript, then use **Mark inspected input handled**
or **Close without replay**. These controls resolve the inbox record; they do
not stop provider work that may already have started.

## Set goal limits

Goals is the only Foreman workflow. Team templates and the legacy Missions API,
CLI and portal view have been removed. Existing teams and role descriptions are
discovered dynamically; each delegation still requires Human approval.

| Configuration field | Limit |
|---------------------|-------|
| `maxActiveGoals` | Concurrent nonterminal goals |
| `maxTeamsPerGoal` | Teams reserved by one goal |
| `maxConcurrentActions` | Unsettled peer actions across the goal's teams |
| `maxGoalHours` | Maximum authorized duration |
| `maxForemanTurns` | Foreman review budget |

These are execution safeguards, not a task plan. The team decides how to research,
plan, implement and review within the approved outcome. Supervised mode disables
discretionary check-ins and automatic team recovery. Bounded mode allows those
only when their individual settings are enabled. Neither mode lets Foreman
answer worker permission prompts, choose arbitrary TUI keys, or bypass Human
approval of the goal and team. Foreman's own process recovery is separately
bounded by `supervision` settings.

Replace old mission-named budget keys with the goal keys above. Remove
`teamTemplates`, `permittedTeamTemplates`, `workspacePolicy`, and the old
`routineWaitReply` and `nativeInput` settings. Older goal records and action
principals are not upgraded automatically; use fresh development state when
switching from the retired layout. No state is automatically deleted.

## Use the CLI

The CLI uses the same authenticated daemon services and JSON contracts:

```bash
nanasa foreman status
nanasa foreman history
nanasa foreman send --body '{"requestId":"instruction-1","text":"Review current goals"}'
nanasa goal list
nanasa goal get GOAL_ID
nanasa goal control --body '{"id":"GOAL_ID","expectedRevision":1,"action":"pause"}'
```

Configuration, start, stop, and approval commands require the exact revision or
run identity shown by the current response. See the generated
[CLI reference](../reference/cli.json) and [protocol reference](../reference/protocols.md).

## Development and certification limits

This early-stage change keeps config version 2, database version 16, and existing
protocol/package identifiers. Database layouts changed directly. Old development
databases are not automatically converted; back up required state before using a
fresh development database. Never remove provider credentials or user worktrees
as a substitute for a database reset.

Deterministic tests cover persistence, grants, process fencing, no-replay input,
team delegation, pinned review evidence, and browser workflows with synthetic providers.
They do not certify real model judgment, arbitrary native approval screens, or
overnight reliability. Run real-provider trials in disposable repositories with
finite budgets before relying on unattended work. MCP scope and read-only roles
are application safeguards, not isolation from hostile code running as your OS user.