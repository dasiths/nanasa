---
title: Nanasa
description: Local terminal-only coding-agent pool with a Fastify daemon, React portal, and authenticated MCP messaging
author: Nanasa
ms.date: 2026-08-10
ms.topic: overview
---

Nanasa (නැනස) is a local-first orchestrator for running and observing multiple
coding-agent terminals. The name means "wisdom" or "intellect" in Sinhala.

## Status

Nanasa is in early development. The current vertical slice manages groups,
agent profiles, memberships, tmux-backed runs, terminal access, and structured
message records. Interfaces and configuration may change.

Every configured agent launches as its command directly in a tmux pane. Nanasa
does not start model-specific subprocess protocols. Portal and MCP messages use
the same durable terminal transport: bracketed paste followed by a separate
Enter key. Use a harmless shell or Node.js fixture when evaluating the runtime
without an agent account.

## Architecture

The Fastify daemon owns application state and terminal-provider processes. It
stores groups, profiles, memberships, runs, messages, delivery outcomes, and
domain events in SQLite. A private tmux server owns the durable agent panes. The
daemon creates one deterministic linked tmux view session and supervises one
loopback-only ttyd process for each active run.

The daemon publishes terminal status under `/api/runs/:runId/terminal` and
proxies each ready ttyd endpoint through a bounded same-origin `/terminals`
path. Upstream ports remain private. The React portal renders only ttyd iframes;
it does not implement a separate terminal renderer or terminal protocol.

During development, Vite proxies both `/api` and `/terminals` to the daemon. In
production, the daemon serves the built portal from `apps/portal/dist` with an
extensionless SPA fallback. API, event WebSocket, and terminal proxy routes keep
precedence over static content.

New memberships receive a readable stable ID in the form
`<agent-type>.<adjective>-<surname>`, for example `pi.focused-hopper`. Nanasa
generates the suffix with `docker-names`, normalizes it for use as an identifier,
and retries collisions within the group. Aliases remain independently editable.

## Requirements

* Node.js 22 or later
* tmux
* ttyd 1.7.7, available on `PATH` or configured through `NANASA_TTYD_PATH`
* An installed and authenticated agent CLI for each enabled profile

The development container installs the pinned ttyd binary for amd64 and arm64
and verifies its published checksum. The npm package does not bundle ttyd because
it is a native executable. `nanasa start` checks `ttyd --version` before starting
and explains how to configure a nonstandard executable path.

Each profile requires its command to be installed and authenticated as required
by that CLI. Nanasa does not initiate interactive authentication or send a model
prompt during startup.

## Setup

Install Nanasa in the repository where you want to manage agents:

```bash
npm install --save-dev nanasa
npx nanasa init
npx nanasa start
```

`nanasa init` discovers the Git repository from the current directory and creates
`.nanasa/config.yaml` only when it is absent. It never overwrites configuration
or runtime state. Edit the generated agent commands for the CLIs available in
your environment, then commit `.nanasa/config.yaml`. Ignore `.nanasa/state/` and
`.nanasa/runtime/`, and `.nanasa/agents/`; they contain SQLite state, the MCP
signing secret, ttyd manifests, and persistent per-membership agent
configuration for one checkout.

Running `nanasa` without a command is equivalent to `nanasa start`. The daemon
walks upward from the current directory to find `.nanasa/config.yaml`, stores
durable state beneath that repository, and serves the portal at
<http://127.0.0.1:3210> by default.

The installed command accepts these options:

* `--host <host>` overrides `NANASA_HOST`; MCP requires a loopback host
* `--port <port>` overrides `NANASA_PORT`
* `--mcp` enables authenticated MCP at `NANASA_MCP_PATH` (default `/mcp`)
* `--ttyd-path <path>` overrides `NANASA_TTYD_PATH`

### Workspace development

Package development uses pnpm 10. Install dependencies and build every workspace
package:

```bash
pnpm install
pnpm build
```

Start the production daemon and built portal from the repository root:

```bash
pnpm start
```

The portal is available at <http://127.0.0.1:3210> by default. Production mode
enables portal serving and resolves the built assets from
`apps/portal/dist`. The repository start script also enables authenticated MCP
for managed agents. Installed-package users retain explicit opt-in through
`nanasa start --mcp`.

## Development

Start the daemon watcher and Vite development server together:

```bash
pnpm dev
```

Open <http://127.0.0.1:5173>. Vite proxies `/api` requests, domain-event
WebSockets, and `/terminals` ttyd HTTP and WebSocket traffic to
<http://127.0.0.1:3210>. Set `VITE_DAEMON_URL` to proxy to another daemon
origin.

The daemon accepts these environment variables:

* `NANASA_HOST`, default `127.0.0.1`; it must remain loopback when MCP is enabled
* `NANASA_PORT`, default `3210`
* `NANASA_REPO_ROOT`, default discovered upward from the current directory
* `NANASA_DATA_PATH`, default `.nanasa/state/nanasa.sqlite`
* `NANASA_RUNTIME_PATH`, default `.nanasa/runtime`
* `NANASA_TMUX_SERVER`, default `nanasa`
* `NANASA_TTYD_PATH`, default `ttyd`
* `NANASA_SERVE_PORTAL`, default enabled only when `NODE_ENV=production`
* `NANASA_PORTAL_PATH`, set automatically by the installed command
* `NANASA_MCP_ENABLED`, default `false`
* `NANASA_MCP_PATH`, default `/mcp`
* `NANASA_MCP_URL`, default derived from the daemon host, port, and MCP path;
  external advertised URLs must use HTTPS
* `NANASA_MCP_OPERATOR_TOKEN`, optional for local agent-only MCP and required
  for an external advertised URL; it must contain at least 32 characters

## Validation

Run the complete non-browser validation suite:

```bash
pnpm typecheck
pnpm test
pnpm lint
pnpm format:check
pnpm build
pnpm smoke
```

`pnpm smoke` uses a safe Node.js line-echo fixture. It creates isolated data and
a unique tmux server, starts two runs in one group, and exercises ttyd index,
token, WebSocket input isolation, client disconnect, daemon restart, ttyd crash
recovery, owner-pane exit, and operator-stop cleanup.

## Terminal behavior

The group tmux session and its panes own the running agent processes. Closing a
browser terminal disconnects only ttyd's disposable tmux client. Gracefully
stopping or restarting the daemon terminates supervised ttyd children but leaves
active owner panes and their linked view sessions available for reconciliation.

Each active run has its own ttyd process and deterministic single-window view
session. This prevents two runs in the same group from changing one another's
current tmux window. ttyd permits one live browser client per run. Tabs therefore
mount only the selected terminal, while grid mode mounts one client for each
visible run. Close another tab, grid, or browser using the same run before
reconnecting.

ttyd provides the browser terminal implementation and terminal WebSocket. The
daemon allows only the endpoint index, token, and WebSocket paths, validates
same-origin upgrades, strips credentials before forwarding, and never exposes
the loopback upstream address.

Every profile command runs directly in its verified owner pane. Interrupt sends
Ctrl+C to that pane. Message delivery loads text into the pane, enables bracketed
paste, pastes the content, and sends Enter separately. A successful outcome
means terminal injection completed; it does not claim that the CLI processed or
completed the request. Delivery retries when a live ttyd browser writer owns the
pane or when tmux is temporarily unavailable.

Terminal input is also the agent-to-agent message channel. The authenticated MCP
tools submit through the same in-process message service as the portal REST API.
The durable dispatcher then uses the guarded tmux paste-and-Enter path for every
active recipient.

Before terminal injection, Nanasa prepends a trusted sender envelope derived
from persisted message identity. Agents receive input such as
`[From: Reviewer | Member: pi.focused-hopper | Intent: request]`; portal messages
use `From: Human`. MCP callers cannot forge this envelope, and the stored message
body remains unchanged.

## MCP messaging

Enable Streamable HTTP MCP at `/mcp` with `nanasa start --mcp` or
`NANASA_MCP_ENABLED=true`. The endpoint supports the MCP 2026-07-28 per-request
protocol and the legacy initialization handshake through the official MCP
TypeScript server and Node packages.

Nanasa exposes these tools:

* `nanasa.list_members` returns active member IDs, aliases, agent types, current
  run status, and which member is the authenticated caller
* `nanasa.send_dm` requires `recipientMemberId` and sends to one active member
* `nanasa.send_multicast` requires `recipientMemberIds` with at least two unique
  active members
* `nanasa.broadcast_group` sends to every active member and excludes the
  authenticated agent caller

The three send tools require `text`, limited to 1 MiB of UTF-8 content. Optional
fields are `intent` (`inform`, `request`, or `response`), `contentType`
(`text/plain` or `text/markdown`), `conversationId`, and `replyTo`. The defaults
are `request` and `text/markdown`. Operator calls must also provide `groupId`.
Agent calls derive the group from their credential and cannot select a different
group. Agent broadcasts always exclude the authenticated caller. Agent direct
and multicast calls reject any recipient list containing that caller.

Every tool uses terminal delivery. Agent tool arguments never choose the sender.
Nanasa signs a capability for the run's group, member, run ID, and generation,
then injects `NANASA_MCP_URL` and `NANASA_MCP_TOKEN` into the direct tmux CLI
environment. The signing key is stored at `.nanasa/state/mcp-secret`. Nanasa
requires the key to be a current-user-owned regular file with mode `0600` and
protects its directory with mode `0700`. Stopping or replacing a run, changing
its desired state, or removing its membership revokes the capability during the
next request.

Agent commands receive two non-persisted environment variables when MCP is
enabled:

* `NANASA_MCP_URL` is the configured Streamable HTTP endpoint
* `NANASA_MCP_TOKEN` is a signed capability bound to the run, generation,
  member, and group

Nanasa also registers its MCP endpoint with each supported CLI before launch.
Generated files live under `.nanasa/agents/<membership-id>/`, contain only an
environment-variable placeholder for the bearer token, and use private file
permissions. The generation capability remains only in the process environment.
The same membership directory is reused after run and daemon restarts.

Client integration follows each CLI's supported configuration contract:

* GitHub Copilot CLI receives a generated HTTP MCP config through
  `--additional-mcp-config`
* Claude Code uses an isolated `CLAUDE_CONFIG_DIR` with a generated user MCP
  entry; direct Claude and `make claude-copilot` launches use the same path
* Pi uses `PI_CODING_AGENT_DIR` and the pinned `pi-mcp-adapter` extension, with
  Nanasa tools registered directly
* OpenCode receives a generated remote MCP entry through `OPENCODE_CONFIG`

Nanasa does not copy provider credentials into generated configuration. It uses
the CLI's existing credential store or inherited authentication environment.
When Claude or Pi uses a regular current-user credential file, the persistent
agent directory contains a narrow symlink to that file rather than a copied
secret or linked configuration tree.

Operator clients authenticate with `Authorization: Bearer <token>`. Configure
that token with `NANASA_MCP_OPERATOR_TOKEN`; it must contain at least 32
characters. The setting is optional for a loopback daemon that serves only
agent capabilities, but it is required for operator calls and whenever
`NANASA_MCP_URL` advertises an external host. Tokens are not accepted in query
strings. The endpoint validates `Host` and `Origin` before bearer authentication
and limits each principal to 30 requests per minute.

Nanasa must remain bound to a loopback host whenever MCP is enabled. For remote
MCP access, terminate TLS at a trusted reverse proxy and configure the proxy to
publish only the exact MCP path, `/mcp` by default. Do not proxy portal, REST,
event, or terminal routes. Set `NANASA_MCP_URL` to the external HTTPS URL,
including the configured path, and configure a strong
`NANASA_MCP_OPERATOR_TOKEN`. The proxy must preserve a `Host` value matching the
advertised URL and should restrict accepted origins. Never expose the Nanasa
listener directly to the network.

## Portal operations

The Add agent form loads agent types from `.nanasa/config.yaml`. New configured
keys appear without a portal code change, and existing profiles show both the
configured display name and stable key.

Use **Start all** in the selected group header to start every active member that
is not already running. The result panel reports each member as started, already
running, or failed. Repeated clicks while the operation is pending reuse one
idempotent request.

Member rows distinguish reconciling, restarting, recovered, and failed recovery
states. Active recovery can be stopped but not started again. Retry is
offered only when recovery cannot continue; a normally stopped member retains
the standard Start action.

The message drawer is a shared group-chat timeline backed by daemon messages.
Portal submissions appear as **Human**; MCP messages use the authenticated
agent's membership alias. Agent-to-agent direct messages, multicasts, and
broadcasts appear in the same oldest-to-newest timeline. Each message has an
actor-initial badge and a collapsed delivery summary that expands to resolved
recipients, attempts, statuses, and failure reasons. The newest message remains
at the bottom, while a new-message control preserves position when older history
is being read.

Browser storage caches immediate portal submissions and records local Clear All
markers. Clearing history hides current messages only in that browser; the
authoritative daemon records remain available for operational history.

On desktop, the horizontal composer and vertical history pane sit side by side
inside the same collapsible Messages section. Narrow layouts stack the composer
above history. Terminal tabs, status bars, iframe titles, and accessible names
show both the editable alias and stable member ID.

Browser terminals configure 10,000 lines of xterm scrollback and enable tmux
mouse routing. PageUp and PageDown pass through ttyd and tmux to raw-mode coding
agent TUIs. Wheel events reach TUIs that enable terminal mouse reporting; for
ordinary shells, tmux can use the wheel for copy-mode scrollback. Full-screen
alternate-screen TUIs own their visible history, so xterm cannot display normal
shell scrollback while that mode is active.

The header theme selector supports light, dark, and system modes. Theme and
terminal tab or grid layout are stored under the versioned
`nanasa.portal.preferences.v1` browser key and synchronize through storage
events. Invalid or unavailable browser storage falls back to system theme and
tab layout without blocking portal controls.

## Concepts

| Concept       | Description                                                                     |
|---------------|---------------------------------------------------------------------------------|
| Group         | An operator-created pool with revisioned membership                             |
| Agent profile | Reusable command, arguments, working directory, and environment configuration  |
| Membership    | A stable agent identity and alias within a group                                |
| Run           | One process generation with a tmux terminal binding                             |
| Message       | Structured content and audience delivered through terminal injection            |

## Roadmap

* [x] Tmux-backed groups, runs, terminal transport, and operational portal
* [x] Direct terminal execution for configured coding-agent CLIs
* [x] Authenticated MCP direct, multicast, and group messaging
* [x] Group and member rename and removal operations
* [ ] Per-agent worktrees and artifact handoff
* [ ] Authentication, authorization, and remote runner isolation
* [ ] Delivery retries, dead letters, and cost controls

## Known limitations

* ttyd 1.7.7 is the validated version; other system versions are not guaranteed
* Terminal delivery confirms guarded paste and Enter injection, not semantic
  model processing
* Remote MCP access requires operator-managed TLS termination and network access
  controls

## Contributing

Issues and pull requests are welcome. Open an issue before starting a large
change while the architecture is still evolving.

## License

See [LICENSE](LICENSE).
