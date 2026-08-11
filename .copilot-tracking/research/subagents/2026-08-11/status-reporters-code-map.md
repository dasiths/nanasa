<!-- markdownlint-disable-file -->
---
title: Status Reporters Code Map
description: Implementation mechanics for TUI-preserving status reporters across supported Nanasa agent harnesses
---

## Research Scope

* Map current runtime provisioning, package dependencies, generated configuration conventions, and tests.
* Specify generated reporter files and configuration for Claude Code, GitHub Copilot CLI, Pi, and OpenCode.
* Define a compact normalized event envelope and reliable harness event mappings.
* Identify code placement, packaging, authenticated HTTP delivery, retry and timeout behavior, and version-pinned golden traces.
* Identify integrations that require a detected executable and define graceful degradation.

## Working Hypothesis

`AgentRuntimeProvisioner` is the correct injection boundary because it already owns private per-membership configuration, credentials, command arguments, and environment variables. Harness reporters can preserve each native TUI if their documented configuration loaders accept generated hooks, plugins, or extensions from that boundary.

The discriminating check is whether existing tests and each supported CLI's documented configuration precedence allow Nanasa to add a reporter without replacing user configuration or requiring a structured worker.

## Current Implementation Findings

### Owning Runtime Path

`apps/daemon/src/agent-runtime-provisioner.ts` is the correct injection point.
It already:

* Uses the stable, traversal-safe `GroupMembership.id` as the runtime key
* Rejects unsafe membership IDs and symlinked membership roots
* Creates directories as `0700` and generated JSON files as `0600`
* Atomically replaces JSON through a same-directory temporary file and rename
* Generates one private root for each Claude Code, Copilot, Pi, and OpenCode
	membership
* Keeps the generation capability out of files by writing only environment
	interpolation placeholders

`TmuxRuntime.#launch()` calls the provisioner before creating the pane. Its
environment precedence is profile values, then generation-scoped runtime
values, then provisioner values. The final provisioner values win. The launch
command is assembled as an argument vector and shell-quoted before tmux runs
`exec`.

The current provisioner contract receives the membership and profile, not the
`AgentRun`. Reporter files do not need caller-selected identity because the
daemon derives run, generation, group, and member from the bearer capability.
Keep the body identity-free. If a future disk spool is generation-scoped, then
the provisioner contract must also receive the run or a generation-specific
spool path. The first release should use an in-memory queue and avoid that
contract expansion.

### Current Generated Configuration

| Harness | Current generated file | Current launch change |
|---|---|---|
| Copilot | `<root>/copilot/mcp-config.json` | Adds `--additional-mcp-config @<file>` and leaves `COPILOT_HOME` unchanged |
| Claude Code | `<root>/claude/.claude.json` | Sets `CLAUDE_CONFIG_DIR=<root>/claude` and links `.credentials.json` when safe |
| Pi | `<root>/pi/mcp.json` | Sets `PI_CODING_AGENT_DIR=<root>/pi` and adds the resolved `pi-mcp-adapter` extension |
| OpenCode | `<root>/opencode/opencode.json` | Sets `OPENCODE_CONFIG=<file>` and leaves provider state in its normal XDG roots |

Focused tests in `apps/daemon/test/agent-runtime-provisioner.test.ts` assert
these exact paths, arguments, environment maps, file modes, credential links,
and token placeholders. Reporter work must extend these assertions rather than
silently changing the existing persistence policy.

`apps/daemon/test/terminal-delivery.test.ts` proves that run-scoped environment
values reach the direct pane and do not enter the stored profile. The same test
surface should cover `NANASA_STATUS_URL`; the existing
`NANASA_MCP_TOKEN` should authenticate status ingestion as the same run
principal.

### Dependencies And Package Output

The repository pins `pi-mcp-adapter@2.18.0` in both `package.json` and
`apps/daemon/package.json`. No Claude Code, Copilot CLI, Pi, OpenCode, or
OpenCode SDK package is a Nanasa dependency. Those four CLIs are external
executables.

`scripts/build-package.mjs` currently emits only the bundled daemon entry point
and the portal. The root package publishes `dist`, so reporter entry points
under `dist/daemon/reporters/` will be included without expanding the package
file allowlist. Add explicit esbuild entry points for:

* `hook-command.mjs`, shared by Claude Code and Copilot command hooks
* `pi-extension.mjs`, loaded as a second Pi extension
* `opencode-plugin.mjs`, re-exported by a generated local OpenCode plugin

These files should depend only on Node built-ins and `fetch`. OpenCode must not
receive a generated `package.json`, because OpenCode runs `bun install` for
config-directory dependencies at startup. Pi must not run `pi install`. Copilot
must not install a plugin. Every integration can load Nanasa-owned local files
directly.

The installed executable inventory on 2026-08-11 was:

| Harness | Reported version | Executable |
|---|---|---|
| Claude Code | `2.1.220` | `/usr/local/share/npm-global/bin/claude` |
| GitHub Copilot CLI | `1.0.79` | VS Code user storage `copilotCli/copilot` |
| Pi | `0.83.0` | `/usr/local/share/npm-global/bin/pi` |
| OpenCode | `1.18.15` | `/home/node/.opencode/bin/opencode` |

The installed Copilot `1.0.79` help output advertises
`--plugin-dir <directory>`. The Pi `0.83.0` declaration file exposes
`ReadonlySessionManager.getSessionId()` and confirms `session_shutdown`,
`after_provider_response`, `agent_settled`, and all three tool-execution events.
It exposes `auto_retry_start` on `AgentSessionEvent`, but not through the public
`ExtensionAPI.on()` overloads. A normal Pi extension therefore cannot claim an
exact automatic-retry event.

## Proposed Common Contract

### Endpoint And Authentication

Generate and inject:

```text
NANASA_STATUS_URL=http://127.0.0.1:<daemon-port>/internal/status/events
NANASA_MCP_TOKEN=<existing generation-scoped run capability>
NANASA_REPORTER_VERSION=1
```

The URL must be a validated loopback URL created by the daemon, not derived by
reporters from `NANASA_MCP_URL`. The route should accept only `POST`, require
`Content-Type: application/json`, and reuse `McpCredentialIssuer.authenticate()`.
It should reject operator principals. Identity comes from the authenticated
agent principal and never from request JSON.

Return `202` after schema validation and append/reduce the event in one daemon
operation. Return `401` for an invalid or revoked capability, `409` for a stale
generation if the route distinguishes that case, `413` above 8 KiB, and `429`
under the reporter-specific rate limit. Do not share the MCP limit of 30 calls
per minute. Start with 600 events per minute per run and a burst of 100, then
measure real traces before reducing it.

Host and Origin validation should match the existing MCP boundary. Do not put
the token in a URL, generated file, log, fixture, spool, or event body.

### Normalized Event Envelope

Use one readable, bounded envelope for all reporters:

```json
{
	"version": 1,
	"eventId": "0198c7dc-7f15-7a66-b481-6dd88e3a173c",
	"source": "claude-code",
	"reporterVersion": "1",
	"event": "tool.started",
	"occurredAt": "2026-08-11T12:34:56.789Z",
	"sessionId": "abc123",
	"turnId": null,
	"operationId": "toolu_01ABC",
	"requestId": null,
	"data": {
		"tool": "Bash",
		"waitKind": null,
		"errorClass": null,
		"retryAt": null,
		"activeCount": null
	}
}
```

Rules:

* `eventId` is generated once and retained across retries for deduplication
* `source` is `claude-code`, `copilot`, `pi`, or `opencode`
* `event` is one of `reporter.ready`, `session.ready`, `turn.started`,
	`turn.settled`, `tool.started`, `tool.finished`, `tool.failed`, `wait.opened`,
	`wait.closed`, `compaction.started`, `compaction.finished`,
	`retry.observed`, `failure.observed`, `session.ended`, or `heartbeat`
* Source timestamps are evidence, not authority; the daemon always stamps
	receipt time
* Correlation fields are nullable strings capped at 128 bytes
* `data` is a strict object with bounded scalar metadata only
* Prompt text, tool arguments, tool output, transcript paths, file paths,
	assistant text, stack traces, reasoning, and provider headers are discarded
* Wait summaries may use a tool or request label, capped at 256 UTF-8 bytes,
	but must not include the original question, plan, command, or schema
* The whole body is limited to 8 KiB and unknown keys are rejected

The daemon should preserve the raw normalized envelope for replay, not the
vendor payload. Reporter normalizers need deterministic functions from a
vendor fixture to this envelope so the reducer can be tested independently.

### Correlation And Reducer Rules

Long-lived reporters maintain a monotonically increasing in-memory sequence,
but sequence is optional because command hooks are separate processes.
`eventId` is the cross-retry key. The reducer tracks open operations and waits
by source IDs where available and by reporter event ID otherwise.

An event with no source request ID can still prove that a wait opened. It cannot
prove exact pairing under parallel same-tool calls. Mark such evidence medium
confidence and close it only on the documented terminal event set. Never invent
a stable source ID by hashing prompt text or tool arguments.

`turn.settled` means idle only when no open wait, operation, retry, background
task, queue item, or cron remains. It never sets task outcome to `succeeded`.

## Harness Code Maps

### Claude Code

#### Generated Files And Launch

Keep the existing `<root>/claude/.claude.json` for MCP. Add user settings at:

```text
<root>/claude/settings.json
```

`CLAUDE_CONFIG_DIR=<root>/claude` makes this the user settings file while
project and managed settings continue to merge. Generate command hooks because
`SessionStart` does not support HTTP handlers, and command hooks avoid HTTP
allowlist variability. Use exec form with the daemon's absolute
`process.execPath` and packaged reporter path:

```json
{
	"$schema": "https://json.schemastore.org/claude-code-settings.json",
	"hooks": {
		"SessionStart": [
			{
				"hooks": [
					{
						"type": "command",
						"command": "/absolute/path/to/node",
						"args": [
							"/absolute/package/dist/daemon/reporters/hook-command.mjs",
							"claude-code"
						],
						"async": true,
						"timeout": 2
					}
				]
			}
		],
		"PreToolUse": [
			{
				"matcher": "*",
				"hooks": [
					{
						"type": "command",
						"command": "/absolute/path/to/node",
						"args": [
							"/absolute/package/dist/daemon/reporters/hook-command.mjs",
							"claude-code"
						],
						"async": true,
						"timeout": 2
					}
				]
			}
		],
		"SessionEnd": [
			{
				"hooks": [
					{
						"type": "command",
						"command": "/absolute/path/to/node",
						"args": [
							"/absolute/package/dist/daemon/reporters/hook-command.mjs",
							"claude-code"
						],
						"timeout": 1
					}
				]
			}
		]
	}
}
```

Generate the same asynchronous handler for `UserPromptSubmit`, `PreToolUse`,
`PermissionRequest`, `PostToolUse`, `PostToolUseFailure`, `PermissionDenied`,
`Stop`, `StopFailure`, `PreCompact`, `PostCompact`, `Elicitation`, and
`ElicitationResult`. Generate the one-second synchronous handler only for
`SessionEnd`, because Claude terminates outstanding async hooks during teardown.
Do not register `MessageDisplay`; it blocks each displayed batch and exposes
assistant content that status reduction does not need. `PostToolBatch` is also
redundant once individual tool IDs are tracked.

The command must always exit `0`, print nothing to stdout, and avoid stderr for
delivery failures. This makes reporter failure observational and non-blocking.
Managed policy may set `allowManagedHooksOnly`, `strictPluginOnlyCustomization`,
or `disableAllHooks`; absence of `session.ready` must degrade to process-only
status instead of failing the TUI launch.

#### Reliable Mapping

| Claude event | Normalized event | Correlation and confidence |
|---|---|---|
| `SessionStart` | `session.ready` | `session_id`, high |
| `UserPromptSubmit` | `turn.started` | `prompt_id` when present, otherwise session, high |
| `PreToolUse` | `tool.started` | `tool_use_id`, high |
| `PreToolUse` for `AskUserQuestion` | `wait.opened` with `question` | `tool_use_id`, provisional high while tool remains open |
| `PreToolUse` for `ExitPlanMode` | `wait.opened` with `plan_approval` | `tool_use_id`, provisional high while tool remains open |
| `PermissionRequest` | `wait.opened` with `permission` | No source request ID; associate with the sole matching open tool or keep unpaired, medium correlation but high wait evidence |
| `PostToolUse` | `tool.finished` and matching `wait.closed` | `tool_use_id`, high |
| `PostToolUseFailure` | `tool.failed` and matching `wait.closed` | `tool_use_id`, high |
| `PermissionDenied` | `wait.closed` plus `failure.observed` | `tool_use_id`, high |
| `Elicitation` | `wait.opened` with `elicitation` | `elicitation_id` when present, otherwise medium |
| `ElicitationResult` | `wait.closed` | `elicitation_id` when present, otherwise medium |
| `PreCompact` / `PostCompact` | `compaction.started` / `compaction.finished` | Session, high |
| `Stop` with empty background and cron arrays | `turn.settled` | Session and `prompt_id`, high |
| `Stop` with active background tasks or crons | `turn.started` with `activeCount` | Do not mark idle, high |
| `StopFailure` | `failure.observed` | Error class only; do not infer retry or crash |
| `SessionEnd` | `session.ended` | Best effort clean end, high if received |

Close provisional question and plan waits on matching post-tool events,
interruption/failure, `Stop`, or `SessionEnd`. A `Stop` after an unresolved
permission wait may close an unpaired synthetic wait only if no tool remains
open. `Notification.permission_prompt` and `Notification.idle_prompt` are
delayed fallbacks and should not be primary mappings.

### GitHub Copilot CLI

#### Generated Files And Launch

Do not set `COPILOT_HOME`. It owns authentication and session state, and the
current provisioner intentionally leaves it unchanged. Instead generate a local
session plugin:

```text
<root>/copilot/nanasa-status-plugin/
	plugin.json
	hooks/
		hooks.json
```

Append:

```text
--plugin-dir <root>/copilot/nanasa-status-plugin
```

The manifest is:

```json
{
	"name": "nanasa-status-reporter",
	"description": "Nanasa lifecycle status reporter",
	"version": "1.0.0",
	"hooks": "hooks/hooks.json"
}
```

The generated hook file uses the native camelCase schema consistently:

```json
{
	"version": 1,
	"hooks": {
		"sessionStart": [
			{
				"type": "command",
				"bash": "'/absolute/path/to/node' '/absolute/package/dist/daemon/reporters/hook-command.mjs' 'copilot'",
				"timeoutSec": 2
			}
		],
		"preToolUse": [
			{
				"type": "command",
				"matcher": ".*",
				"bash": "'/absolute/path/to/node' '/absolute/package/dist/daemon/reporters/hook-command.mjs' 'copilot'",
				"timeoutSec": 2
			}
		],
		"sessionEnd": [
			{
				"type": "command",
				"bash": "'/absolute/path/to/node' '/absolute/package/dist/daemon/reporters/hook-command.mjs' 'copilot'",
				"timeoutSec": 2
			}
		]
	}
}
```

Generate the same command entry for `userPromptSubmitted`, `preToolUse`,
`permissionRequest`, `postToolUse`, `postToolUseFailure`, `agentStop`,
`subagentStart`, `subagentStop`, `errorOccurred`, `preCompact`, `notification`,
and `sessionEnd`. Use the native tool names and anchored-regex semantics. The
reporter command must return `{}` or no output, exit `0`, and never make a
permission decision.

Do not use direct HTTP hooks. Loopback HTTP requires
`COPILOT_HOOK_ALLOW_LOCALHOST=1`, and `preToolUse` plus `permissionRequest` HTTP
hooks require HTTPS because their responses can grant permission. A local
command that performs its own bounded loopback POST has no such hook-policy
conflict. It also avoids the fail-open/fail-closed differences of permission
capable HTTP handlers because the command itself always exits successfully.

#### Reliable Mapping

| Copilot event | Normalized event | Correlation and confidence |
|---|---|---|
| `sessionStart` | `session.ready` | `sessionId`, high |
| `userPromptSubmitted` | `turn.started` | Session, high; discard prompt |
| `preToolUse` | `tool.started` | No documented tool-call ID in config hooks, medium correlation |
| `preToolUse` for `ask_user` | `wait.opened` with `question` | Provisional only, no request ID, medium |
| `permissionRequest` | `wait.opened` with `permission` | No documented request ID, high wait evidence and medium correlation |
| `postToolUse` | `tool.finished` and matching provisional wait close | Match by session and sole open tool name, medium |
| `postToolUseFailure` | `tool.failed` and matching provisional wait close | Match by session and sole open tool name, medium |
| `agentStop` | `turn.settled` | Session, high |
| `subagentStart` / `subagentStop` | `turn.started` / activity completion | Agent fields, high for lifecycle but not task outcome |
| `errorOccurred` with `recoverable: true` | `failure.observed` | Keep process nonterminal, high |
| `errorOccurred` with `recoverable: false` | `failure.observed` | Fatal harness evidence, but process supervision still decides crash |
| `preCompact` | `compaction.started` | No documented completion hook, high start only |
| `notification.agent_idle` | `turn.settled` for the named background agent | Delayed asynchronous fallback, medium |
| `notification.permission_prompt` / `elicitation_dialog` | `wait.opened` | Delayed fallback, medium |
| `sessionEnd` | `session.ended` or `failure.observed` from reason | High if received |

The current hook API has no dedicated `ask_user` answered event and no tool-call
ID in the native config payload. Do not advertise exact question waits for
Copilot `1.0.79` until a golden executable trace proves the open and close
sequence. ACP would improve permission correlation but would change the launch
architecture and remains out of scope for the TUI-preserving reporter.

### Pi

#### Packaged Extension And Launch

Build `apps/daemon/src/status-reporters/pi-extension.ts` as the dependency-free
`dist/daemon/reporters/pi-extension.mjs`. It exports one default factory and
uses only a structural subset of `ExtensionAPI` at runtime. Type-checking may
use the exact `@earendil-works/pi-coding-agent@0.83.0` declarations as a pinned
development dependency, but the built module must contain no import of that
package. Pi supplies the extension host.

The launch becomes:

```text
pi --extension <resolved-pi-mcp-adapter-index> \
	 --extension <package>/dist/daemon/reporters/pi-extension.mjs
```

Keep `PI_CODING_AGENT_DIR=<root>/pi` and the existing `mcp.json`. Do not copy the
reporter into Pi's auto-discovery directory, do not add it to `settings.json`,
and do not run `pi install`. The repeatable CLI flag is explicit, per run, and
does not depend on project trust.

The extension should register handlers synchronously, start its queue and
15-second heartbeat only in `session_start`, and clear timers in an idempotent
`session_shutdown` handler. Event handlers enqueue and return immediately.
They never await delivery and never call `ctx.ui`, so the TUI is unchanged.

#### Reliable Mapping

| Pi event | Normalized event | Correlation and confidence |
|---|---|---|
| `session_start` | `session.ready` | `ctx.sessionManager.getSessionId()`, high |
| `before_agent_start` or `agent_start` | `turn.started` | Session, high; discard prompt |
| `turn_start` | `turn.started` | `turnIndex`, high |
| `tool_execution_start` | `tool.started` | `toolCallId`, high |
| `tool_execution_end` with `isError: false` | `tool.finished` | `toolCallId`, high |
| `tool_execution_end` with `isError: true` | `tool.failed` | `toolCallId`, high |
| `session_before_compact` | `compaction.started` | Include reason and `willRetry`, high |
| `session_compact` | `compaction.finished` | Include reason and `willRetry`, high |
| `after_provider_response` with `429` or `5xx` | `failure.observed` | Response class only; it does not prove Pi scheduled a retry |
| `agent_end` | Activity boundary only | Do not emit `turn.settled`; retry or queued work may remain |
| `agent_settled` | `turn.settled` | Exact no-retry/no-queue signal, high |
| `session_shutdown` | `session.ended` | Best effort clean end, high |
| Timer while a session exists | `heartbeat` | Reporter transport liveness only |

Pi `0.83.0` has no public extension event for its internal automatic retry
records. It also has no universal permission or question event. The Nanasa
extension can report an exact wait only around a `ctx.ui.select`, `confirm`,
`input`, or `editor` call that Nanasa itself owns. It cannot observe dialogs
opened by Pi or another extension. The first reporter should not open any UI,
so Pi waiting remains unsupported except through future controlled UI or RPC.

An extension exception is logged and Pi continues, except `tool_call` handler
errors can block the tool. The reporter should avoid `tool_call` entirely and
use the read-only execution lifecycle events, ensuring observability cannot
change tool behavior.

### OpenCode

#### Generated Plugin Overlay And Launch

Keep the current MCP file and add a custom config directory:

```text
<root>/opencode/
	opencode.json
	nanasa-config/
		plugins/
			nanasa-status.js
```

Generate the plugin shim as:

```javascript
export { NanasaStatusPlugin } from "file:///absolute/package/dist/daemon/reporters/opencode-plugin.mjs";
```

Set both:

```text
OPENCODE_CONFIG=<root>/opencode/opencode.json
OPENCODE_CONFIG_DIR=<root>/opencode/nanasa-config
```

`OPENCODE_CONFIG` merges between global and project config. The custom directory
is discovered like `.opencode` and loads its `plugins/` after normal plugin
directories. It does not replace provider state or require a generated
`package.json`.

`opencode-plugin.mjs` exports a named async plugin function. It returns an
`event` hook plus optional `tool.execute.before` and `tool.execute.after` hooks.
The event hook receives `{ event }`, sanitizes only the documented IDs and
state tags, enqueues a normalized event, and returns immediately. Start one
15-second heartbeat for known sessions and stop it when no session remains.

Do not start `opencode serve` and do not attach the plugin to a separately
started server. Every `opencode` TUI already starts its own server on a random
port. A second server observes a different session universe. In-process plugin
events preserve the exact TUI and avoid server discovery, SSE reconnect, and
basic-auth configuration.

#### Reliable Mapping

| OpenCode event | Normalized event | Correlation and confidence |
|---|---|---|
| `server.connected` or `session.created` | `session.ready` | `sessionID` when available, high |
| `session.status` with `busy` | `turn.started` | `sessionID`, high |
| `session.status` with `retry` | `retry.observed` | Attempt and `next`, high |
| `session.status` with `idle` | `turn.settled` | `sessionID`, high |
| `session.idle` | `turn.settled` | `sessionID`, high |
| `message.part.updated` tool state `pending` or `running` | `tool.started` | `callID`, high |
| Tool state `completed` | `tool.finished` | `callID`, high |
| Tool state `error` | `tool.failed` | `callID`, high |
| `permission.asked` | `wait.opened` with `permission` | Request `id`, high |
| `permission.replied` | `wait.closed` | `requestID`, high |
| `question.asked` | `wait.opened` with `question` | Request `id`, high only after pinned trace verification |
| `question.replied` or `question.rejected` | `wait.closed` | `requestID`, high only after pinned trace verification |
| `session.error` | `failure.observed` | Typed error class only; process supervision decides crash |
| `session.deleted` | `session.ended` | Session, high |
| Timer while a session exists | `heartbeat` | Reporter transport liveness only |

Accept the legacy permission request name only when its payload validates as
the documented request shape. Do not map an unknown `permission.updated` event
by name alone. The plugin documentation does not list question events, while
the official source schema does. Pin OpenCode `1.18.15` and capture executable
question traces before enabling those mappings in a release.

`tool.execute.before` and `tool.execute.after` can provide low-volume lifecycle
events. `message.part.updated` remains necessary for terminal error state and
for tools not covered by plugin hooks. Deduplicate by `sessionID + callID +
state`; never send output, arguments, metadata, or message content.

## Delivery And Failure Policy

### Command Reporter

The Claude and Copilot command reporter reads at most 1 MiB from stdin, rejects
larger input locally, parses one JSON object, normalizes it, and sends one
event. It never writes vendor input to disk.

Use a 500 ms request timeout. Retry once for connection failures, `408`, `425`,
`429`, and `5xx` after 50 to 150 ms of jitter. Reuse `eventId`. Honor
`Retry-After` only when it is at most 250 ms. Cap the whole command at 1.25
seconds so Claude's one-second `SessionEnd` hook should instead use one 500 ms
attempt with no retry. Treat `400`, `401`, `403`, `404`, `409`, and `413` as
permanent.

Always exit `0`, even on malformed input or failed delivery. Keep stdout empty.
Debug diagnostics, when explicitly enabled, may write one redacted error class
to a private reporter log, never stderr, so a status outage does not add hook
warnings to the TUI.

### Long-Lived Reporter Queue

Pi and OpenCode use one in-memory FIFO per process:

* Maximum 256 envelopes or 2 MiB, whichever comes first
* Drop the oldest non-wait, non-terminal activity event first
* Never drop the newest wait-open, wait-close, session-error, or session-end
	event in favor of a heartbeat
* One delivery pump, one request in flight, and a one-second request timeout
* Retry transient failures after 250 ms, 1 second, 4 seconds, then 15 seconds
* Drop an event after five attempts or 60 seconds, whichever comes first
* Disable delivery immediately after `401`, `403`, or generation-conflict
	`409`; the run capability is stale
* On the next successful event, include only a bounded `droppedCount`, not the
	discarded payloads

Do not persist the first-release queue. Replaying a previous generation under a
new capability would misattribute events unless the spool path and key are
generation-specific. Process and tmux evidence already covers the crash case
that an in-process spool cannot report.

### Heartbeats And Degradation

Only Pi and OpenCode have long-lived in-process reporters. Emit a heartbeat
every 15 seconds while a session exists. The daemon may use a 45-second
transport lease for those reporters. Claude and Copilot command hooks must not
start timers; use event age and process evidence instead.

Missing, blocked, disabled, or stale reporters must set `attention` to
`reporter_stale` and lower semantic confidence. They must not stop launch,
restart a healthy pane, or classify the agent as crashed. A live process with no
semantic reporter remains process-visible and can still become
`suspected_stuck` only through the separate lease and probe policy.

## Version-Pinned Golden Fixtures

### Fixture Layout

Add immutable raw and expected traces under:

```text
apps/daemon/test/fixtures/status-reporters/
	claude-code-2.1.220/
	copilot-1.0.79/
	pi-0.83.0_adapter-2.18.0/
	opencode-1.18.15/
```

Each version directory should contain:

```text
manifest.json
raw/<scenario>.jsonl
normalized/<scenario>.jsonl
reduced/<scenario>.json
```

`manifest.json` records the exact reported CLI version, executable basename,
platform, architecture, reporter version, capture date, scenario names, and a
SHA-256 of each fixture. It must not record absolute user paths, credentials,
tokens, prompts, commands, file contents, or tool results. Replace source IDs
with stable fixture IDs after preserving their equality relationships.

### Required Scenarios

Capture these scenarios where the harness exposes them:

| Scenario | Required assertion |
|---|---|
| Startup and clean idle | Ready appears before settled; idle does not imply task success |
| One successful tool | Start and finish pair through the documented correlation ID |
| Parallel tools | Out-of-order completion does not close the wrong operation |
| Tool failure | Failure closes only the matching operation and is not a process crash |
| Permission wait | Open wait dominates silence and closes on documented resolution |
| Question wait | Exact only for Claude tool IDs and OpenCode after verification; Copilot stays provisional; Pi generic UI stays unsupported |
| Compaction | Working phase remains compaction and returns to work or settled |
| Recoverable API failure or retry | Recoverable evidence does not become crashed |
| Fatal harness failure | Fatal semantic evidence is preserved while process state remains separate |
| SIGTERM | Best-effort clean hook may appear, followed by supervisor exit evidence |
| SIGKILL | No in-process terminal event is expected; supervisor evidence is authoritative |
| Reporter outage | Native TUI proceeds and semantic status degrades without tool denial |

Use synthetic prompts and harmless fixture tools. Golden capture must run the
actual executable in a pseudo-terminal and a local fake model/provider where
the harness permits it. Do not generate fixture payloads from TypeScript types
or documentation examples and call them executable traces.

### Test Placement

Add focused replay tests beside the implementation:

* `apps/daemon/test/status-reporter-normalizers.test.ts`
* `apps/daemon/test/status-reporter-delivery.test.ts`
* `apps/daemon/test/status-reporter-goldens.test.ts`
* Extended `apps/daemon/test/agent-runtime-provisioner.test.ts`
* Extended `test/package-cli.test.mjs` to assert packaged reporter assets

Executable capture tests must be opt-in and version-exact. Skip with an explicit
diagnostic when the expected executable is absent or reports a different
version. Never silently refresh a golden from whichever CLI happens to be on
`PATH`.

## Packaging And Shipping Gates

### Required Assets

The packaged CLI must resolve all three reporter entry points before enabling
semantic status. Missing Nanasa-owned assets are a package defect and should
fail daemon startup when status reporting is enabled. No harness should fetch
code or dependencies at runtime.

### External Executable Gates

None of the four harness integrations can responsibly be declared supported
without its executable. The package does not own those binaries or their
auto-update behavior.

| Harness | Ship gate | Graceful degradation |
|---|---|---|
| Claude Code | Golden traces from `2.1.220`; direct profiles may probe `claude --version` | Wrapped `make claude-copilot` cannot be safely version-probed. Provision settings, wait for `session.ready`, then fall back to process-only status if absent |
| Copilot | Golden traces from `1.0.79` proving `--plugin-dir`, hooks, permission flow, and `ask_user` limitations | If plugin loading produces no ready event, keep the TUI and mark reporter unavailable. Do not switch `COPILOT_HOME` |
| Pi | Golden traces from `pi 0.83.0` together with `pi-mcp-adapter 2.18.0` and the second extension | If Pi is absent, the profile already cannot launch. If only the reporter extension fails, keep process/MCP behavior and mark semantic reporting stale |
| OpenCode | Golden traces from `1.18.15` proving custom-directory plugin events, permission names, and question names | If the plugin does not load, keep the current `OPENCODE_CONFIG` MCP path and process-only status. Do not start a second server |

Version probes are safe only for direct known executable profiles. A profile
may be a wrapper such as `make claude-copilot`; Nanasa must not append
`--version` to arbitrary user commands. Runtime readiness events are the common
capability test.

Support should be described by exact tested tuples, not an unbounded minimum
version. When a detected direct version differs from the fixture tuple, load
the reporter in compatibility mode, preserve known event names, ignore unknown
payloads, and lower confidence until CI captures and reviews the new trace.

### Minimal Product Edit Surface

The later implementation should remain concentrated in:

* `apps/daemon/src/agent-runtime-provisioner.ts` for generated files, reporter
	paths, arguments, and environment
* `apps/daemon/src/status-reporters/` for shared normalization/delivery and the
	three packaged entry points
* `apps/daemon/src/server.ts` for the validated ingestion URL and route wiring
* `scripts/build-package.mjs` for reporter entry points
* Focused daemon and package tests listed above

No YAML profile schema change is required. Reporter configuration is runtime
owned and should not enter `.nanasa/config.yaml` or `templates/config.yaml`.

## References And Evidence

Local evidence:

* `.copilot-tracking/research/2026-08-11/agent-status-tracking-research.md`
* `.copilot-tracking/research/subagents/2026-08-11/agent-status-observability-research.md`
* `.copilot-tracking/research/subagents/2026-08-10/agent-mcp-persistence-research.md`
* `apps/daemon/src/agent-runtime-provisioner.ts`
* `apps/daemon/src/tmux-runtime.ts`
* `apps/daemon/src/server.ts`
* `apps/daemon/src/mcp-auth.ts`
* `apps/daemon/test/agent-runtime-provisioner.test.ts`
* `apps/daemon/test/terminal-delivery.test.ts`
* `package.json`
* `apps/daemon/package.json`
* `pnpm-lock.yaml`
* `scripts/build-package.mjs`
* Installed Pi `0.83.0` declarations under
	`/usr/local/share/npm-global/lib/node_modules/@earendil-works/pi-coding-agent/dist/`

Official references read on 2026-08-11:

* [Claude Code hooks reference](https://code.claude.com/docs/en/hooks)
* [Claude Code settings](https://code.claude.com/docs/en/settings)
* [GitHub Copilot hooks reference](https://docs.github.com/en/copilot/reference/hooks-reference)
* [GitHub Copilot CLI command reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference)
* [GitHub Copilot CLI plugin reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-plugin-reference)
* [Pi extensions](https://pi.dev/docs/latest/extensions)
* [Pi packages](https://pi.dev/docs/latest/packages)
* [OpenCode plugins](https://opencode.ai/docs/plugins/)
* [OpenCode configuration](https://opencode.ai/docs/config/)
* [OpenCode server](https://opencode.ai/docs/server/)
* [OpenCode SDK](https://opencode.ai/docs/sdk/)

## Follow-On Questions

* [ ] Capture and review the four exact executable fixture sets before product
	support is enabled.
* [ ] Verify Copilot `1.0.79` local plugin hook root, event order, and
	`ask_user` close behavior in a pseudo-terminal.
* [ ] Verify OpenCode `1.18.15` emits the current question event names and the
	documented permission request/reply pair to local plugins.
* [ ] Measure command-hook process startup and event delivery latency before
	fixing production lease values.
* [ ] Decide whether future Pi waiting support should wrap Nanasa-owned UI or
	adopt optional RPC supervision.

## Clarifying Questions

None.
