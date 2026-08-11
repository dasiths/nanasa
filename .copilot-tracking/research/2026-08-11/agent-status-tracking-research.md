<!-- markdownlint-disable-file -->
---
title: Agent Status Tracking Research
description: Architecture options for coordinator-visible status and progress across managed coding-agent TUIs
---

## Executive Recommendation

Add an event-driven semantic status plane beside the existing tmux runtime. Keep
tmux and process supervision as the authority for whether a run exists, while
harness hooks, plugins, or structured event streams report what the agent is
doing. Reduce those observations into one status record per run and expose that
record to principal agents through a read-only MCP tool.

The first implementation should preserve the current TUI architecture:

1. Add a generation-fenced status ingestion endpoint authenticated by the
   existing run capability.
2. Provision a small reporter for each agent kind using Claude Code hooks,
   Copilot CLI hooks, a Pi extension, and an OpenCode plugin or event client.
3. Extend tmux reconciliation to retain process exit status and detect missing
   panes independently of semantic reporting.
4. Add a reducer that combines process, hook, protocol, and timeout evidence.
5. Expose `nanasa.list_agent_statuses` and `nanasa.get_agent_status` to the
   principal agent.

Do not describe an agent as definitively `stuck`. None of the evaluated
harnesses emits that state. Use `suspected_stuck`, include confidence and
evidence, and require both an expired progress lease and active probes that show
no progress. An explicit outstanding permission, question, elicitation, or plan
approval always means `waiting`, even when the agent has been silent for a long
time.

Structured supervision should remain an optional later phase. Pi RPC, OpenCode
SSE, Claude's Agent SDK, and Copilot ACP offer better event framing, but adopting
them as the primary runtime would reverse Nanasa's recent terminal-only decision
and create a model-specific control stack. The immediate status requirement does
not require that migration.

## Current Nanasa Baseline

Nanasa already has two useful layers:

* The run model records `starting`, `running`, `stopping`, `stopped`, and
  `failed`.
* `RunRuntimeCoordinator` and `TmuxRuntime` reconcile owned panes every second
  and recover missing desired runs.

The current `running` value means that the owned tmux pane exists. It does not
mean the model is processing a task. `nanasa.list_members` therefore reports
process-level availability, not agent-loop status.

The runtime provisioner creates a private, persistent directory per membership
and already writes model-specific MCP configuration before launch. This is the
right place to inject observability configuration. It avoids changing the user's
repository-level Claude, Copilot, Pi, or OpenCode settings and preserves
generation-scoped credentials in the process environment.

The recent terminal-only architecture deliberately removed ACP and RPC workers.
Status reporting should not quietly recreate those workers as a prerequisite.
An event receiver plus small in-process reporters is a smaller and more
compatible extension of the current system.

## Two Different Questions

The principal agent needs both mechanical status and semantic progress. These
must remain separate because neither can reliably substitute for the other.

Mechanical status answers:

* Has the run been launched?
* Is its process alive?
* Is the agent loop active, settled, waiting, or failing?
* When was progress last observed?
* Does the coordinator need to intervene?

Semantic progress answers:

* Which assigned task is the agent working on?
* What stage or checkpoint has it reached?
* What changed since its previous report?
* What is blocking it?
* What does it plan to do next?

Hooks and event streams can answer the first set with reasonable confidence.
They cannot infer task completion from tool activity alone. Add cooperative task
reports for the second set, but never use the absence of a self-report as proof
that a process is stuck.

## Proposed Status Model

Use one public status dimension and separate phase, outcome, and attention
fields. Avoid combining process lifecycle, agent activity, and task success in a
single enum.

```text
state:
  not_started | starting | working | waiting | idle | suspected_stuck |
  stopped | crashed

phase:
  startup | model | tool | retry | compaction | permission | question |
  plan_approval | settled | exited

outcome:
  unknown | succeeded | failed | cancelled

confidence:
  high | medium | low

attention:
  none | input_required | decision_required | reporter_stale |
  progress_stale | process_failed
```

State rules:

| State | Required evidence |
|---|---|
| `not_started` | Membership or assignment exists, but no spawn attempt or run generation exists |
| `starting` | Spawn was requested, but no pane-ready or harness-ready event has arrived |
| `working` | Model, turn, stream, tool, retry, compaction, queue, or background-task activity is current |
| `waiting` | An unresolved interaction request has an ID, kind, open time, and reply path |
| `idle` | An explicit stop, settled, or idle event arrived and no wait, retry, queue item, or background task remains |
| `suspected_stuck` | Process is alive, no wait exists, progress lease expired, and at least two probes found no progress |
| `stopped` | Operator intent or a clean lifecycle event ended the run |
| `crashed` | Process exited unexpectedly, transport died with its owned process, or a fatal structured result prevents continuation |

`idle` is not the same as `succeeded`. Claude `Stop`, Copilot `agentStop`, Pi
`agent_settled`, and OpenCode `session.idle` show that the loop settled. They do
not prove that the assigned objective was fulfilled. Success requires an
explicit task report, a terminal structured result that carries success, or a
principal-agent decision.

Each record should also include:

```text
run_id, generation, member_id, agent_type
observed_at, state_changed_at
last_activity_at, last_activity_kind
semantic_lease_expires_at, transport_lease_expires_at
session_id, turn_id, tool_id, request_id
wait_kind, wait_summary, wait_opened_at, reply_channel
last_progress_summary, next_step, blocker
process_exit_code, process_signal, clean_end_seen
evidence[]: source, event, timestamp, confidence
```

The daemon should stamp receipt time and derive identity from the bearer
capability. Reporters must not select `run_id`, `member_id`, or `group_id` in
their request body.

## Evidence Precedence

Apply evidence in this order:

1. Confirmed process death or owned transport EOF
2. Explicit fatal result or clean terminal result
3. Outstanding interaction request
4. Explicit work, retry, compaction, queue, or background activity
5. Explicit settled or idle event
6. Lease expiry plus active probes
7. Tmux output growth or terminal-pattern hints

Lower-ranked evidence can add detail but cannot reverse stronger evidence. For
example, an unchanged terminal screen cannot turn an outstanding permission
request into `suspected_stuck`. A live PID cannot turn a fatal harness result
back into `working`.

Use correlation IDs to handle overlapping tools and out-of-order completion.
Parallel hook handlers can arrive in a different order from source execution.
The reducer should track open tool and wait IDs rather than assigning state from
the latest raw event alone.

## Harness Capabilities

| Harness | Strong activity signals | Explicit wait signals | Settled or failure signals | Preferred TUI-preserving integration |
|---|---|---|---|---|
| Claude Code | `PreToolUse`, `PostToolUse`, `PostToolBatch`, message display, task and subagent events | `PermissionRequest`, `Elicitation`, `AskUserQuestion`, `ExitPlanMode`, deferred tools | `Stop`, `StopFailure`, `TeammateIdle`, `SessionEnd` | Generated hooks posting to local Nanasa ingestion |
| Copilot CLI | `preToolUse`, `postToolUse`, prompt and subagent events | `permissionRequest`; `ask_user` is visible as a tool but lacks a dedicated question lifecycle | `agentStop`, `errorOccurred`, `sessionEnd`, idle/completion notifications | Generated command or HTTP hooks; capability-test `ask_user` |
| Pi | `agent_start`, turns, messages, tool execution, retries and queues | Exact only when a Nanasa extension owns `ctx.ui` or RPC emits `extension_ui_request` | `agent_settled`, `agent_end`, retry failure, `extension_error` | Add a Nanasa extension alongside `pi-mcp-adapter` |
| OpenCode | `session.status`, `message.part.updated`, tool hooks | `permission.asked`, `question.asked` | `session.idle`, `session.error`, tool error state | Generated plugin or attachment to the TUI's server SSE endpoint |

### Claude Code

Claude Code has the richest hook surface. The useful direct state transitions
are:

* `SessionStart` to mark the harness ready
* `UserPromptSubmit` or a model/tool event to mark work active
* `PreToolUse` to open a tool operation
* `PostToolUse` or `PostToolUseFailure` to close it
* `PermissionRequest` to open a permission wait immediately
* `Elicitation` and `ElicitationResult` to open and close MCP input waits
* `Stop` to mark a turn settled
* `StopFailure` to record API and model failures
* `SessionEnd` for best-effort clean shutdown

`Notification.permission_prompt` is delayed by about six seconds, and
`Notification.idle_prompt` is delayed by about 60 seconds. They are useful as
fallback notices, not primary state transitions.

For interactive `AskUserQuestion` and `ExitPlanMode`, `PreToolUse` proves that an
interaction is imminent but does not prove the dialog is still mounted. A
reporter can open a provisional wait on `PreToolUse` and close it on
`PostToolUse`, failure, interruption, or turn end. The Agent SDK gives a stronger
contract through pending `canUseTool` calls and deferred tools, but requires a
different launch architecture.

### GitHub Copilot CLI

Copilot CLI hooks provide good turn and tool coverage:

* `sessionStart` and `userPromptSubmitted`
* `preToolUse`, `postToolUse`, and `postToolUseFailure`
* `permissionRequest`
* `agentStop`, `subagentStart`, and `subagentStop`
* `errorOccurred` with a `recoverable` flag
* `sessionEnd` with `complete`, `error`, `abort`, `timeout`, or `user_exit`

The asynchronous notification hook adds `agent_idle`, `agent_completed`,
`permission_prompt`, and `elicitation_dialog`. It should not be the sole source
because notification timing and availability differ from direct lifecycle
hooks.

Copilot's `ask_user` tool can be observed in `preToolUse`, but the current hook
reference has no dedicated question-open and question-answered pair. Treat this
as provisional waiting and validate the installed CLI version. Copilot ACP has
an exact `session/request_permission` exchange and correlated tool updates, but
ACP remains public preview and would require structured supervision.

### Pi

Pi exposes a precise agent-loop lifecycle through extensions and RPC. In
particular, `agent_settled` means there is no automatic retry, compaction retry,
or queued continuation left. That is stronger than a low-level `agent_end`.

A Nanasa Pi extension can report:

* `session_start` and `session_shutdown`
* `agent_start`, `agent_end`, and `agent_settled`
* turn and message lifecycle
* `tool_execution_start`, update, and end
* provider status and extension failures

Pi does not have a universal permission event. An extension that opens
`ctx.ui.select`, `confirm`, `input`, or `editor` can report the wait before it
awaits the response and close it afterward. Arbitrary UI opened by another
extension is not observable. Pi RPC makes these waits exact through correlated
`extension_ui_request` and `extension_ui_response` records.

### OpenCode

OpenCode provides the strongest queryable multi-session state. Its SSE event
stream and `GET /session/status` expose `idle`, `busy`, and `retry`. Tool parts
carry `pending`, `running`, `completed`, or `error`, and permission and question
events carry request IDs suitable for exact wait tracking.

The main integration risk is deployment topology. A separately started
`opencode serve` process is not necessarily the server used by the running TUI.
Nanasa must either inject a plugin into the TUI process or know the TUI's actual
server endpoint. Permission event names have also changed across generated SDK
versions, so pin the supported OpenCode version and accept the documented and
legacy names during transition.

## Integration Options

### Option 1: Injected semantic reporters

Keep every current TUI and provision harness-native hooks, plugins, or
extensions that send compact events to a local Nanasa endpoint.

Benefits:

* Preserves the current portal and terminal workflow
* Uses the richest semantics each harness already emits
* Fits the existing per-membership provisioning boundary
* Requires no terminal screen parsing for normal operation

Costs and risks:

* Coverage differs by harness
* Hooks can be disabled, denied by trust policy, time out, or fail
* In-process reporters cannot report their own hard crash
* Copilot question waits and arbitrary Pi extension UI remain incomplete

This is the recommended first option.

Use a dedicated ingestion route rather than the existing messaging MCP tools.
Status events can exceed the MCP rate limit of 30 calls per minute during tool
activity, and reporting state through the model-facing messaging plane creates
unnecessary coupling. Reuse the same run capability and host restrictions, but
give status ingestion independent rate limits, payload limits, and storage.

Report only metadata by default: event name, tool name, correlation IDs,
duration, coarse error class, and wait summary. Tool arguments, prompt text,
results, transcripts, and model reasoning may contain secrets and are not
needed for state classification.

### Option 2: Structured protocol supervision

Launch or attach through each harness's programmatic interface:

* Claude Agent SDK or `stream-json`
* Copilot ACP
* Pi RPC
* OpenCode server, SDK, and SSE

Benefits:

* Typed framing and request correlation
* Better cancellation and reply paths
* Exact outstanding waits for several harnesses
* Easier event replay and deterministic tests

Costs and risks:

* Reintroduces model-specific runtime workers that Nanasa recently removed
* May not preserve the exact native TUI experience
* ACP is public preview
* Four protocols create four recovery and compatibility surfaces

Adopt this selectively where it adds control that hooks cannot provide. Pi RPC
and OpenCode SSE are the strongest candidates. Avoid making all four structured
adapters mandatory for the initial status feature.

### Option 3: Session-file and log tailing

Tail harness transcripts, JSONL session files, or debug logs from an
out-of-process sidecar.

Benefits:

* Reporter survives an agent-process crash
* No hook callback on the critical path
* Historical records can be replayed after daemon restart

Costs and risks:

* File formats and paths are harness-specific
* Writes can lag in-memory state
* Permission dialogs and questions are often absent or ambiguous
* Debug logs may contain sensitive content and unstable implementation detail

Use log tailing as a recovery or audit source, not the primary live-state
contract. Pi's documented session JSONL is the best candidate. Claude explicitly
warns that its transcript can lag the current hook event.

### Option 4: Process and tmux heuristics

Extend the existing tmux reconciliation with pane PID, dead status, exit code,
and output-change timestamps. Hashing `capture-pane` output every 60 seconds can
show that the display changed, but it cannot identify why it did not change.

Benefits:

* Works with every terminal program
* Detects hard exits that hooks cannot report
* Requires no cooperation from the agent

Costs and risks:

* Silence can mean model thinking, network backoff, a long tool, waiting, idle,
  or deadlock
* ANSI screen patterns change with CLI version, theme, width, and locale
* Repeated spinners can look active without making progress

Always implement this as the liveness fallback. Never use it as the sole source
for `waiting`, `idle`, or `suspected_stuck`.

### Option 5: Cooperative MCP progress reports

Add a model-callable tool such as `nanasa.report_progress` with fields for task
ID, stage, summary, blocker, and next step. Prompt managed agents to call it at
meaningful checkpoints.

Benefits:

* Gives the principal agent human-readable progress instead of tool noise
* Works through the messaging capability agents already receive
* Allows a blocked agent to identify the decision it needs

Costs and risks:

* Model compliance is probabilistic
* Reports can be stale, optimistic, or missing
* A numeric percentage implies precision the agent usually does not have

Use checkpoint names and summaries rather than requiring percentages. Treat
self-reports as semantic progress evidence, never as process liveness evidence.

## Heartbeats And Leases

A 60-second heartbeat is useful only when its meaning is explicit. There are
three different clocks:

* A process heartbeat proves the supervisor can still see the owned process.
* A reporter heartbeat proves the hook, plugin, extension, or event transport is
  alive.
* A progress event proves that observable work changed.

Do not collapse them into one `last_seen` timestamp.

Recommended initial policy:

* Refresh process liveness through the existing one-second tmux reconciliation.
* Let long-lived Pi and OpenCode reporters emit a transport heartbeat every 15
  seconds while a session exists.
* Let short-lived Claude and Copilot hooks emit lifecycle events without
  spawning a timer from every hook invocation.
* Use a 45-second semantic lease for reporters that promise 15-second active
  heartbeats.
* Use at least a 90-second semantic lease for Claude SDK tool heartbeats, which
  are documented at 30-second intervals.
* Poll Pi `get_state` or OpenCode `/session/status` every 15 to 30 seconds when a
  structured stream is quiet.
* Start with a 120-second startup lease and extend it on authentication, MCP,
  plugin-loading, or retry evidence.
* Never expire `waiting` based on silence alone. Use the request's documented
  timeout or an operator attention SLA.
* Enter `suspected_stuck` only after lease expiry and two failed progress probes
  separated by at least one poll interval.

Lease thresholds must be configurable by harness and phase. A declared
ten-minute shell command should not become stuck after 45 seconds. Retry events
with a known `next` time should remain `working` in phase `retry` until that
deadline passes.

## Principal-Agent Experience

The principal agent should not need to inspect raw hook events. Expose a compact
MCP result such as:

```json
{
  "memberId": "pi.focused-hopper",
  "alias": "Implementer",
  "state": "waiting",
  "phase": "permission",
  "confidence": "high",
  "attention": "decision_required",
  "since": "2026-08-11T09:41:12Z",
  "summary": "Requests approval to run the integration test suite",
  "replyChannel": "terminal",
  "lastProgress": "Implemented the status reducer and added focused tests",
  "nextStep": "Run tests and report failures",
  "evidence": ["copilot.permissionRequest", "tmux.process_alive"]
}
```

Useful MCP operations:

* `nanasa.list_agent_statuses` returns every active group member, compact state,
  attention need, last progress, and evidence age.
* `nanasa.get_agent_status` returns one member's detailed evidence, open wait,
  recent transitions, and task report.
* `nanasa.report_progress` lets an agent publish a checkpoint or blocker.
* A later `nanasa.respond_to_wait` should exist only for harness integrations
  with a safe correlated reply channel. Otherwise the principal sends a normal
  terminal message and the status record says `replyChannel: terminal`.

The principal can poll on demand, but a better coordinator loop also emits a
group event when an agent enters `waiting`, `suspected_stuck`, or `crashed`.
Avoid waking the principal for every tool call.

## Storage And API Shape

Store append-only observations and a materialized current record:

* `agent_status_events` for replay, audit, and reducer debugging
* `agent_status_current` for fast portal and MCP reads
* `agent_task_reports` for cooperative checkpoints

Fence every event by run generation. Ignore late events from a replaced run.
Require a unique event ID when the source can retry delivery. Keep a bounded
recent history and aggregate old tool activity so observability does not become
an unbounded transcript store.

The reporter endpoint should be loopback-only with the daemon, authenticate the
same signed run capability as MCP, accept small strict JSON payloads, and apply a
separate rate limit. A local Unix socket is an alternative, but HTTP is directly
supported by Claude and Copilot hooks and is easier for Pi and OpenCode plugins.

Reporter delivery must not block agent work for long. Use short timeouts and
fail open. Long-lived reporters can spool briefly to the per-membership runtime
directory and retry. Command hooks should send one bounded request and exit.

## Suggested Delivery Phases

### Phase 1: Generic liveness and contracts

* Add the public status, phase, confidence, outcome, and evidence contracts.
* Capture pane dead status and process exit code during tmux reconciliation.
* Add status storage, reducer, authenticated ingestion, and MCP reads.
* Ship `not_started`, `starting`, `stopped`, and `crashed` from scheduler and
  process evidence before harness reporters exist.

### Phase 2: TUI-preserving semantic reporters

* Add Claude Code generated hooks.
* Add the Nanasa Pi extension alongside the existing MCP adapter.
* Add an OpenCode plugin with event reporting and status polling.
* Add Copilot CLI hooks, with a version-pinned question-wait test.
* Cover start, tool activity, explicit wait, settled, recoverable failure, fatal
  failure, SIGTERM, and SIGKILL traces.

### Phase 3: Progress and coordinator attention

* Add cooperative task checkpoint reporting.
* Add portal status and evidence-age display.
* Publish attention events for waits, stale progress, and crashes.
* Add principal-agent guidance for when to poll, message, interrupt, or restart.

### Phase 4: Optional structured control

* Prototype Pi RPC and OpenCode SSE first.
* Evaluate Claude SDK only when deferred questions or programmatic permissions
  are required.
* Evaluate Copilot ACP after pinning a version and validating `ask_user`.
* Keep terminal launch as a supported fallback.

## Decision Summary

Choose injected reporters plus tmux supervision as the default architecture.
This gives the principal agent useful, evidence-backed status without replacing
the native TUIs or rebuilding the removed adapter layer.

Use structured protocols selectively where exact interaction control matters.
Use session files and logs for replay and recovery. Use terminal screen changes
only as low-confidence hints. Add cooperative MCP checkpoints for progress, but
keep them separate from mechanical state.

The key invariant is:

```text
outstanding_interaction_request => waiting, never suspected_stuck_by_silence
```

## Sources

Primary product references:

* [Claude Code hooks reference](https://code.claude.com/docs/en/hooks)
* [GitHub Copilot hooks reference](https://docs.github.com/en/copilot/reference/hooks-reference)
* [Pi extensions](https://pi.dev/docs/latest/extensions)
* [Pi RPC mode](https://pi.dev/docs/latest/rpc)
* [Pi JSON event stream](https://pi.dev/docs/latest/json)
* [Pi session format](https://pi.dev/docs/latest/session-format)
* [OpenCode plugins](https://opencode.ai/docs/plugins/)
* [OpenCode SDK](https://opencode.ai/docs/sdk/)
* [OpenCode server](https://opencode.ai/docs/server/)
* [OpenCode documentation](https://opencode.ai/docs/)

Supporting analysis:

* `.copilot-tracking/research/subagents/2026-08-11/agent-status-observability-research.md`
* `.copilot-tracking/research/2026-08-10/terminal-only-mcp-crud-research.md`
* `apps/daemon/src/agent-runtime-provisioner.ts`
* `apps/daemon/src/mcp-server.ts`
* `apps/daemon/src/run-runtime-coordinator.ts`
* `apps/daemon/src/tmux-runtime.ts`
* `packages/contracts/src/index.ts`

## Open Validation Questions

* Capture version-pinned golden traces for all four harnesses covering normal
  completion, permission wait, question wait, API retry, tool failure, SIGTERM,
  and SIGKILL.
* Verify Copilot CLI's installed ACP and hook behavior for `ask_user`.
* Inspect the pinned OpenCode `/doc` OpenAPI schema for question reply endpoints.
* Confirm the safest per-member Copilot hook location without sharing hook state
  across concurrent runs.
* Measure startup and inter-event latency before fixing production lease
  defaults.
