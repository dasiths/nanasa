<!-- markdownlint-disable-file -->
---
title: Agent Status Observability Research
description: Documented lifecycle signals for Nanasa to classify independently running TUI agents
---

## Scope And Evidence Rules

This research answers which observable signals a Nanasa principal agent can use to classify independently running Claude Code, GitHub Copilot CLI, Pi, and OpenCode agents. Sources were read on 2026-08-11. Official product documentation is primary evidence; linked official source schemas are used where a documentation page lists an event but omits its payload.

The labels below have precise meanings:

* Documented fact: a named event, field, API, or behavior appears in an official source
* Inference: Nanasa can derive a state by combining documented signals, but the harness does not emit that state directly
* Unsupported: neither an explicit event nor a reliable derivation exists without injection or process supervision

## Key Findings

* No harness emits `not-started`. Nanasa must own that state from its launch record.
* No harness emits a definitive `stuck`. Silence is ambiguous. A stuck classification must be a timed, confidence-qualified inference made only after excluding an outstanding permission, question, or other explicit wait.
* A process exit is the only cross-harness crash boundary. In-process hooks cannot report a hard crash because they die with the process.
* Pi has the strongest direct idle signal: `agent_settled` means no retry, compaction retry, or queued continuation remains.
* OpenCode has the strongest queryable multi-session status surface: `GET /session/status` and `session.status` expose `idle`, `busy`, or `retry`.
* Claude Code has the richest hook and SDK lifecycle, including permission, elicitation, stop failure, deferred tools, background task status, and 30-second main-tool heartbeats.
* Copilot CLI hooks cover turns and tools well. Its public-preview ACP server is the better long-lived supervision interface because permission requests and tool states are protocol objects instead of TUI text.
* Waiting must be represented as an outstanding request with identity and provenance. An agent that is quiet while holding such a request is waiting, not stuck.

## Compact Capability Matrix

| Harness | Start | Working | Explicit wait | Settled or idle | Failure | Hard crash | Best structured surface |
|---|---|---|---|---|---|---|---|
| Claude Code | `SessionStart`; SDK `system/init` | `PreToolUse`, `PostToolUse`, message and task progress | `PermissionRequest`, `Elicitation`, `canUseTool`, deferred `AskUserQuestion` | `Stop`; `TeammateIdle`; SDK `result` | `PostToolUseFailure`, `StopFailure`, failed task/result | Process exit or signal only | Agent SDK or `stream-json` |
| Copilot CLI | `sessionStart` | `preToolUse`, `postToolUse`, ACP tool updates | `permissionRequest`; ACP `session/request_permission`; `ask_user` tool is only indirectly visible | `agentStop`; `notification: agent_idle`; ACP prompt result | `postToolUseFailure`, `errorOccurred`, `sessionEnd: error` | Process exit or signal only | ACP server; one-shot JSONL for `-p` |
| Pi | `session_start`; RPC session header | `agent_start`, turns, messages, tool execution | RPC `extension_ui_request` only when an extension opens a dialog | `agent_settled`; `ctx.isIdle()` | tool `isError`, `extension_error`, retry failures, assistant `stopReason` | Process exit or signal only | RPC mode; JSON mode for one-shot streams |
| OpenCode | `session.created`; `server.connected` | `session.status: busy`; tool-part states | `permission.asked`; source-schema `question.asked` | `session.status: idle`; `session.idle` | `session.error`; tool state `error`; assistant error | Server or TUI process exit only | Server, SDK, SSE, and `/session/status` |

Legend: a turn-level stop or idle event does not prove the operating-system process has exited. It means the harness has no automatic foreground work at that lifecycle point.

## Claude Code

### Documented Hook Signals

All hook payloads include `session_id`, `transcript_path`, `cwd`, and `hook_event_name`; many also include `prompt_id`, `permission_mode`, `effort`, `agent_id`, and `agent_type`.

| Concern | Exact event and relevant payload |
|---|---|
| Session start | `SessionStart`: `source` is `startup`, `resume`, `clear`, `compact`, or `fork`; optional `model`, `agent_type`, `session_title` |
| User work accepted | `UserPromptSubmit`: `prompt`; this fires before processing |
| Tool starts | `PreToolUse`: `tool_name`, `tool_input`, `tool_use_id` |
| Tool succeeds | `PostToolUse`: the same tool identity plus `tool_response` and optional `duration_ms` |
| Tool fails | `PostToolUseFailure`: `tool_name`, `tool_input`, `tool_use_id`, `error`, optional `is_interrupt`, `duration_ms` |
| Batch activity | `PostToolBatch`: `tool_calls[]` with `tool_name`, `tool_input`, `tool_use_id`, and optional serialized `tool_response` |
| Permission wait | `PermissionRequest`: `tool_name`, `tool_input`, optional `permission_suggestions`; it fires immediately before a user permission decision would be requested |
| Auto-mode denial | `PermissionDenied`: `tool_name`, `tool_input`, `tool_use_id`, `reason`; this is a denial, not a wait |
| Delayed UI notices | `Notification`: `notification_type`, `message`, optional `title`; useful types are `permission_prompt`, `idle_prompt`, `elicitation_dialog`, `elicitation_url_dialog`, `agent_needs_input`, and `agent_completed` |
| MCP input wait | `Elicitation`: `mcp_server_name`, `message`, optional `mode`, `url`, `elicitation_id`, `requested_schema`; `ElicitationResult` adds `action` and optional `content` |
| Subagent lifecycle | `SubagentStart`: `agent_id`, `agent_type`; `SubagentStop`: those fields plus `agent_transcript_path`, `stop_hook_active`, optional `last_assistant_message`, `background_tasks`, `session_crons` |
| Turn settled | `Stop`: `stop_hook_active`, optional `last_assistant_message`, `background_tasks`, `session_crons`; it does not fire on user interrupt or API failure |
| Turn failed | `StopFailure`: `error`, optional `error_details`, `last_assistant_message`; error values include `rate_limit`, `overloaded`, authentication and billing errors, `server_error`, `max_output_tokens`, and `unknown` |
| Team idle or task complete | `TeammateIdle`: `teammate_name`; `TaskCompleted`: `task_id`, `task_subject`, optional description and teammate |
| Session end | `SessionEnd`: `reason` is `clear`, `resume`, `logout`, `prompt_input_exit`, `bypass_permissions_disabled`, or `other` |

`Notification.permission_prompt` is delayed until about six seconds without terminal input, and `idle_prompt` is delayed about 60 seconds after response completion. Use `PermissionRequest` and `Stop` for timely state, not those notifications.

`AskUserQuestion` and `ExitPlanMode` are tool names visible in `PreToolUse`. `AskUserQuestion.tool_input.questions[]` contains `question`, `header`, `options[]`, and `multiSelect`; `ExitPlanMode` supplies `plan` and `planFilePath`. In interactive mode, their `PreToolUse` observation indicates an imminent wait, but no hook announces that the dialog is currently mounted. The Agent SDK is stronger: `canUseTool(toolName, input, { requestId, toolUseID, agentID, ... })` is the replacement for the interactive prompt and remains pending until it returns a decision.

### Structured Supervision

Claude Code `-p --output-format stream-json` emits newline-delimited events and ends with a `result`. The Agent SDK exposes the same stream with stronger types:

* `SDKSystemMessage` uses `type: "system"`, `subtype: "init"`, and includes `session_id`, model, tools, MCP status, permission mode, plugins, and capabilities
* `SDKResultMessage` uses `type: "result"`; success includes `is_error`, `result`, `stop_reason`, `permission_denials`, and optional `deferred_tool_use`; error subtypes include `error_max_turns`, `error_during_execution`, `error_max_budget_usd`, and `error_max_structured_output_retries`
* `terminal_reason` distinguishes `completed`, `tool_deferred`, aborted work, hook stops, limit breakers, model/API errors, malformed tool use, exhausted budgets, unavailable deferred tools, and setup failures
* `SDKTaskNotificationMessage.status` is `completed`, `failed`, or `stopped`; `SDKTaskUpdatedMessage.patch.status` is `pending`, `running`, `completed`, `failed`, or `killed`
* `SDKToolProgressMessage` supplies `tool_use_id`, `tool_name`, `elapsed_time_seconds`, and, for main-thread tools, a heartbeat every 30 seconds with `heartbeat: true`
* A deferred tool produces `stop_reason: "tool_deferred"` and `deferred_tool_use: { id, name, input }`; this is an explicit durable wait, not a stuck run

### Classification Limits

`Stop` is a completed turn, not necessarily a completed assignment. A main process can remain alive at the prompt, and `background_tasks` can show work still in flight. A hook cannot prove a crash. `SessionEnd` is best-effort cleanup on normal termination and SIGTERM, but a hard kill or runtime crash may emit nothing.

## GitHub Copilot CLI

### Documented Hook Signals

Hooks accept native camelCase event names and fields, or PascalCase names with VS Code-compatible snake_case payloads. The native names below are canonical for this comparison.

| Concern | Exact event and relevant payload |
|---|---|
| Session start | `sessionStart`: `sessionId`, epoch-ms `timestamp`, `cwd`, `source` (`startup`, `resume`, `new`), optional `initialPrompt` |
| Prompt accepted | `userPromptSubmitted`: `sessionId`, `timestamp`, `cwd`, `prompt` |
| Tool starts | `preToolUse`: `toolName`, `toolArgs`; output can set `permissionDecision` (`allow`, `deny`, `ask`), `permissionDecisionReason`, and `modifiedArgs` |
| Permission decision | `permissionRequest`: same tool identity; output is `behavior` (`allow`, `deny`), optional `message`, and `interrupt` |
| Tool succeeds | `postToolUse`: `toolName`, `toolArgs`, `toolResult: { resultType: "success", textResultForLlm }` |
| Tool fails | `postToolUseFailure`: `toolName`, `toolArgs`, `error` |
| Turn settled | `agentStop`: `transcriptPath`, `stopReason: "end_turn"`, `stop_hook_active`; output `decision: "block"` can force another turn |
| Subagent lifecycle | `subagentStart`: `transcriptPath`, `agentName`, optional display name and description; `subagentStop` adds `agentId`, `agentType`, `response`, `stopReason: "end_turn"` |
| Runtime error | `errorOccurred`: `error { message, name, stack? }`, `errorContext` (`model_call`, `tool_execution`, `system`, `user_input`), `recoverable` |
| Session end | `sessionEnd`: `reason` is `complete`, `error`, `abort`, `timeout`, or `user_exit` |
| Async notices | `notification`: `notification_type`, `message`, optional `title`; types include `shell_completed`, `shell_detached_completed`, `agent_completed`, `agent_idle`, `permission_prompt`, `elicitation_dialog` |

The tool name `ask_user` (or PascalCase alias `AskUserQuestion`) can be observed in `preToolUse`. The hook reference does not document a dedicated question-open or question-answered event. Therefore an interactive clarifying-question wait is indirect unless Nanasa controls the permission handler or uses ACP.

`notification.agent_idle` specifically means a background agent finished a turn and is waiting for `write_agent`. `agent_completed` covers a background subagent that completed or failed, so the notification text or a subsequent agent-status query is needed to disambiguate outcome.

### Structured Supervision

One-shot prompt mode supports `--output-format=json`, documented as JSONL, and exits after `-p`. The public docs do not specify a complete stable record union for that JSONL stream, so hooks plus process exit remain necessary if Nanasa uses it.

The public-preview ACP server is a better long-lived contract:

* `copilot --acp --stdio` or `--port` carries NDJSON JSON-RPC
* `session/new` returns `sessionId`; `session/prompt` remains outstanding for the whole turn
* `session/update` reports `tool_call` and `tool_call_update` with `toolCallId`, `status` (`pending`, `in_progress`, `completed`, `failed`), optional content, locations, raw input, and raw output
* `session/request_permission` carries `sessionId`, a `toolCall`, and `options[]` with `optionId`, `name`, and `kind` (`allow_once`, `allow_always`, `reject_once`, `reject_always`); the response outcome is `selected` plus `optionId`, or `cancelled`
* the final prompt response has `stopReason`, normally `end_turn`; ACP also defines `max_tokens`, `max_turn_requests`, `refusal`, and `cancelled`

ACP does not by itself define a generic human-question method. Copilot-specific support for `ask_user` should be capability-tested rather than assumed from the generic protocol.

### Classification Limits

`agentStop` means a turn ended, not that the CLI process ended. `errorOccurred.recoverable: true` should keep the state nonterminal. Hook failure and timeout behavior also matters: `preToolUse` command-hook crashes fail closed, but hook timeouts fail open. Only the supervising process can classify a hard crash.

## Pi

### Documented Extension Signals

Pi extensions expose the most explicit agent-loop lifecycle of the four harnesses:

| Concern | Exact event and relevant payload |
|---|---|
| Session start and end | `session_start`: `reason` (`startup`, `reload`, `new`, `resume`, `fork`) and optional `previousSessionFile`; `session_shutdown`: `reason` (`quit`, `reload`, `new`, `resume`, `fork`) |
| Agent work | `before_agent_start`, `agent_start`, `turn_start`, `message_start`, `message_update`, `message_end`, `turn_end` |
| Tool work | `tool_execution_start`: `toolCallId`, `toolName`, `args`; `tool_execution_update` adds `partialResult`; `tool_execution_end` adds `result`, `isError` |
| Policy gate | `tool_call`: `toolName`, `toolCallId`, mutable `input`; an extension can block or open `ctx.ui` interaction |
| Tool result | `tool_result`: tool identity, input, content, details, `isError`, usage |
| Low-level run end | `agent_end`: `messages`; automatic retry, compaction retry, or queued follow-up may still continue |
| Fully settled | `agent_settled`: no automatic retry, compaction retry, or queued continuation remains; `ctx.isIdle()` is normally true |
| Provider response | `after_provider_response`: HTTP `status` and normalized headers |

Pi has no built-in permission-request event and no universal question event. An extension that calls `ctx.ui.select`, `confirm`, `input`, or `editor` owns the wait and can report it directly. A `tool_call` handler can also report before awaiting its custom approval UI.

### RPC And JSON Supervision

RPC mode is strict JSONL over stdin/stdout. It provides:

* a `get_state` response with `isStreaming`, `isCompacting`, `sessionId`, `messageCount`, and `pendingMessageCount`
* `agent_start`, `agent_end { messages, willRetry }`, and `agent_settled`
* turn, message, tool execution, queue, compaction, automatic retry, summarization retry, and `extension_error` events
* `tool_execution_end { toolCallId, toolName, result, isError }`
* `auto_retry_start { attempt, maxAttempts, delayMs, errorMessage }` and `auto_retry_end { success, attempt, finalError? }`
* `extension_ui_request { id, method, ... }` for `select`, `confirm`, `input`, or `editor`; the matching `extension_ui_response` returns `value`, `confirmed`, or `cancelled`

An outstanding dialog request ID is an exact waiting signal. `agent_settled` is an exact idle signal. JSON mode emits a session header and the agent/message/tool event stream, but has no input channel or UI; it is better for one-shot observation than coordination.

### Classification Limits

Without an injected extension, a normal Pi TUI question or arbitrary custom UI cannot be discovered from outside the terminal. Pi exposes tool and assistant failures but no crash event. A dead RPC child, broken JSONL stream, or unexpected process exit remains a supervisor concern.

## OpenCode

### Documented Plugin And Server Signals

The plugin docs list event-bus names but omit most payloads. The official SDK type and source schemas provide the payload details.

| Concern | Exact event and relevant payload |
|---|---|
| Server ready | `server.connected`; payload is currently open-ended |
| Session exists | `session.created`, `session.updated`, `session.deleted`: `properties.info` is the `Session` with ID, directory, title, and timestamps |
| Session status | `session.status`: `{ sessionID, status }`; status is `{ type: "idle" }`, `{ type: "busy" }`, or `{ type: "retry", attempt, message, next }` |
| Idle | `session.idle`: `{ sessionID }` |
| Session failure | `session.error`: optional `sessionID` and optional typed error (`ProviderAuthError`, `UnknownError`, `MessageOutputLengthError`, `MessageAbortedError`, `ApiError`) |
| Tool lifecycle | `message.part.updated`: `part` can be a `ToolPart` with `callID`, `tool`, and state `pending`, `running`, `completed`, or `error`; running and terminal states contain timestamps; error contains `error` |
| Plugin tool hooks | `tool.execute.before`: input `{ tool, sessionID, callID }`, mutable `output.args`; `tool.execute.after`: input adds `args`, output has `title`, `output`, `metadata` |
| Permission wait | `permission.asked`: request `{ id, sessionID, permission, patterns[], metadata, always[], tool?: { messageID, callID } }`; `permission.replied`: `{ sessionID, requestID, reply }`, where reply is `once`, `always`, or `reject` |
| Question wait | `question.asked`: `{ id, sessionID, questions[], tool? }`; each question has `question`, `header`, `options[] { label, description }`, optional `multiple` and `custom`; `question.replied` returns `answers: string[][]`; `question.rejected` identifies `sessionID` and `requestID` |

OpenCode's plugin page dated 2026-08-09 lists `permission.asked` and `permission.replied`, while its linked legacy generated SDK file currently names `EventPermissionUpdated` for the request shape. The canonical current permission source publishes `permission.asked`. Consumers should feature-detect or pin a version and accept both names during migration. The page does not list question events, but the canonical official question schema defines the three names above.

The server supplies `GET /session/status`, returning a map from session ID to the same `SessionStatus` union, and `GET /event`, an SSE stream whose first event is `server.connected`. Permission decisions use `POST /session/:id/permissions/:permissionID` with response `once`, `always`, or `reject`. Current source also maintains pending permission and question maps, but the server reference does not document a question-response endpoint; use the generated OpenAPI specification for the pinned OpenCode version before implementing remote question replies.

### Classification Limits

`session.status: retry` is working-with-backoff, not stuck. `session.idle` does not prove the user's assignment is semantically complete. Plugin hooks and SSE disappear with a server crash, so process/server health must remain a separate signal. A TUI and a separately launched `opencode serve` are separate server instances; Nanasa must connect to the TUI's configured host/port if it intends to observe that TUI session.

## Integration Style Comparison

### Injected Hooks Reporting To Nanasa HTTP Or MCP

This style preserves the native TUI. Claude Code supports command, HTTP, and MCP-tool hook handlers on most events; GitHub Copilot CLI supports command and HTTP hooks; Pi extensions and OpenCode plugins can call Nanasa directly.

Advantages:

* Rich harness-native semantics without terminal parsing
* Lowest migration cost for existing TUI workflows
* Direct correlation IDs such as session, tool-use, call, request, and agent IDs

Limits:

* Hooks can be disabled, blocked by trust policy, time out, or fail open
* An in-process reporter cannot report its own abrupt death
* Event coverage differs, especially for interactive questions
* Reporting synchronously can stall the agent; use bounded local delivery and an out-of-process relay or durable local spool

Recommendation: use hooks as the semantic plane, not as the sole liveness plane. Prefer HTTP for event ingestion where officially supported. Use a command hook that sends to a local Nanasa endpoint where direct HTTP hooks are unavailable. MCP reporting is appropriate when the harness already maintains the server connection, but it may be unavailable during startup and can itself require permission.

### Structured JSON, RPC, SDK, Or Server Supervision

This is the most reliable primary integration where available:

* Claude Code Agent SDK or `stream-json`
* Copilot ACP for long-lived sessions; `-p --output-format=json` for one-shot work
* Pi RPC for control and observation; JSON mode for one-shot observation
* OpenCode SDK/server with SSE plus `/session/status`

Advantages include typed framing, request correlation, explicit outstanding waits, and clean cancellation. The cost is owning a client UI or changing launch mode. Copilot ACP is public preview. OpenCode's TUI already speaks to a server, so attaching to that server can preserve the TUI if its endpoint is known.

### Tmux, Process, And Terminal-Output Polling

This is a necessary fallback and crash detector, not a semantic source.

Reliable observations:

* Scheduler launch intent and child PID establish not-started versus starting
* PID, process group, tmux pane PID, exit code, and terminating signal establish liveness and crash boundaries
* Pane output growth is evidence of activity

Unreliable observations:

* A visible prompt glyph does not reliably distinguish idle from a question, permission dialog, shell handoff, or redraw
* No output does not distinguish model thinking, network backoff, a long tool, waiting, or deadlock
* ANSI screen scraping is version, theme, width, and locale dependent

Use terminal parsing only for low-confidence hints and known, version-pinned prompt patterns. Never let it override a structured outstanding request or an explicit settled/failure event.

## Recommended Hybrid State Model

### State Record

Maintain one reducer-owned record per agent:

```text
state: not_started | starting | working | waiting | idle_completed | suspected_stuck | crashed
phase: startup | model | tool | retry | permission | question | plan_approval | settled | exited
confidence: high | medium | low
provenance: scheduler | process | hook | sdk | rpc | acp | sse | status_api | tmux | terminal_pattern
observed_at: monotonic timestamp
lease_expires_at: monotonic timestamp or null
correlation: session_id, turn_id, tool_id, request_id, agent_id
wait: kind, request_id, opened_at, deadline, reply_channel
terminal: exit_code, signal, clean_semantic_end_seen
last_activity: event name and timestamp
```

### Reducer Precedence

Apply observations in this order:

1. Process death or transport EOF confirmed against process liveness
2. Explicit failure or clean terminal result
3. Outstanding permission, question, elicitation, or plan-approval request
4. Explicit work activity, retry, compaction, or live background task
5. Explicit settled or idle event
6. Lease expiry and active probes
7. Tmux or terminal-pattern hints

Higher-ranked evidence can override lower-ranked evidence. Lower-ranked evidence may enrich phase or confidence but must not reverse stronger evidence.

### Classification Rules

| Target state | Rule |
|---|---|
| `not_started` | Scheduler has an assignment but no spawn attempt, PID, session-start event, or protocol initialization. This is Nanasa-owned fact. |
| `starting` | Spawn succeeded but no harness-ready signal has arrived. Keep a startup deadline. |
| `working` | A model/turn/tool start, stream delta, tool progress, retry, compaction, queue, or background-task event is active. |
| `waiting` | There is an unresolved request ID for permission, question, elicitation, ACP permission, Pi extension UI, or deferred tool. Record the reply channel. |
| `idle_completed` | An explicit settled/idle/turn result arrived and no request, retry, queue item, or background task remains. Store completion reason separately because idle is not proof of task success. |
| `suspected_stuck` | Process is alive, no explicit wait exists, the working lease expired, and at least two independent probes failed to show progress. This remains an inference. |
| `crashed` | Process exited by signal or nonzero status before a clean semantic end, server health/transport is lost and the owned process is dead, or a fatal structured result says execution cannot continue. |

Treat an exit code of zero without an expected final semantic event as `crashed` with medium confidence or as a separate internal `abnormal_exit` reason. Do not report it as successful completion.

### Heartbeats And Leases

Recommended defaults are operational policy, not harness facts:

* Emit injected reporter heartbeats every 15 seconds while a harness says it is working; set the normal working lease to 45 seconds
* Honor declared tool, hook, model, and retry deadlines. A known 10-minute tool should not be called stuck after 45 seconds if progress or process liveness remains available
* Claude SDK main-thread tool heartbeats arrive every 30 seconds, so use a lease of at least 90 seconds for that source
* Poll Pi `get_state` or OpenCode `/session/status` every 15 to 30 seconds when their event stream is quiet; successful polls refresh transport liveness, not semantic progress
* Give startup a configurable 120-second lease, extended by explicit plugin installation, MCP startup, authentication, or retry events
* Do not expire a waiting state merely because it is quiet. Apply the request's own timeout if documented; otherwise wait until reply, cancellation, process death, or an operator-defined attention SLA
* Enter `suspected_stuck` only after lease expiry plus two failed progress probes separated by at least one poll interval. Escalate confidence only if the process remains alive but the semantic transport is unresponsive and terminal output is unchanged

Store both `semantic_lease` and `transport_lease`. A healthy SSE socket or live PID proves transport/liveness, not work progress. A recent hook proves semantic activity, not future process health.

### Stuck Versus Waiting

The central invariant is:

```text
outstanding_wait_request => waiting, never stuck_by_silence
```

Waiting has an identified external dependency and a valid reply path. Stuck has no identified dependency and no observed progress beyond its expected lease. A permission request whose UI cannot be delivered is both waiting and operationally blocked; retain `state: waiting`, set `wait.delivery: failed`, and raise an alert instead of relabeling it as stuck.

## Unsupported States And Residual Risks

* Semantic task completion is not universally observable. `Stop`, `agentStop`, `agent_settled`, and `session.idle` mean the loop settled, not that the user's objective was satisfied.
* Hard crash is never reliably reported in-band. Nanasa must own the process, tmux pane, container, or remote-worker lease.
* Pi has no universal permission or question event unless an extension owns the UI interaction.
* Copilot CLI hooks have no dedicated question-open/replied lifecycle for `ask_user`; ACP support should be tested against the installed version.
* Claude Code interactive `AskUserQuestion` can be anticipated from `PreToolUse`, but the strongest exact wait contract is Agent SDK `canUseTool` or deferred-tool mode.
* OpenCode documentation and generated type names currently drift around permission events. Pin and feature-detect the target version.
* Terminal output polling cannot reliably classify waiting, idle, or stuck without harness-specific patterns and should remain low confidence.

## Sources

### Required Official References

* [Claude Code hooks reference](https://code.claude.com/docs/en/hooks)
* [GitHub Copilot hooks reference](https://docs.github.com/en/copilot/reference/hooks-reference)
* [Pi extensions](https://pi.dev/docs/latest/extensions)
* [Pi RPC mode](https://pi.dev/docs/latest/rpc)
* [OpenCode plugins](https://opencode.ai/docs/plugins/)
* [OpenCode SDK](https://opencode.ai/docs/sdk/)
* [OpenCode server](https://opencode.ai/docs/server/)

### Supporting Official References

* [Claude Code programmatic mode](https://code.claude.com/docs/en/headless)
* [Claude Agent SDK TypeScript reference](https://code.claude.com/docs/en/agent-sdk/typescript)
* [GitHub Copilot CLI command reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference)
* [GitHub Copilot CLI programmatic reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-programmatic-reference)
* [GitHub Copilot CLI ACP server](https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server)
* [ACP prompt-turn lifecycle](https://agentclientprotocol.com/protocol/prompt-turn)
* [ACP tool calls and permission requests](https://agentclientprotocol.com/protocol/tool-calls)
* [Pi JSON event stream](https://pi.dev/docs/latest/json)
* [OpenCode permissions](https://opencode.ai/docs/permissions/)
* [OpenCode tools and question tool](https://opencode.ai/docs/tools/)
* [OpenCode generated SDK event types](https://github.com/anomalyco/opencode/blob/dev/packages/sdk/js/src/gen/types.gen.ts)
* [OpenCode plugin hook interface](https://github.com/anomalyco/opencode/blob/dev/packages/plugin/src/index.ts)
* [OpenCode permission event source](https://github.com/anomalyco/opencode/blob/dev/packages/schema/src/v1/permission.ts)
* [OpenCode question event source](https://github.com/anomalyco/opencode/blob/dev/packages/schema/src/v1/question.ts)

## Recommended Next Research

* [ ] Run version-pinned fixture sessions for all four harnesses and capture golden event traces for normal completion, permission wait, question wait, tool failure, API retry, SIGTERM, and SIGKILL
* [ ] Verify Copilot CLI's installed ACP behavior for `ask_user` and document any Copilot-specific `session/update` extension
* [ ] Inspect the pinned OpenCode `/doc` OpenAPI schema for question list/reply endpoints and reconcile it with the current source events
* [ ] Measure startup and inter-event latency distributions before fixing production lease thresholds

## Clarifying Questions

None. The remaining items are implementation validation against pinned harness versions, not missing product requirements.
