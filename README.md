---
title: Nanasa
description: Local tmux-backed coding-agent pool with a Fastify daemon and React portal
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

Native structured adapters are implemented for GitHub Copilot CLI and Pi.
OpenCode and Claude Code profiles continue to use terminal queue delivery.
Every running agent with a verified tmux pane also supports explicit Terminal
input delivery, independent of its native adapter. Use a harmless shell or
Node.js fixture when evaluating the runtime without an agent account.

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

## Requirements

* Node.js 22 or later
* tmux
* ttyd 1.7.7, available on `PATH` or configured through `NANASA_TTYD_PATH`
* An installed and authenticated agent CLI for each enabled profile

The development container installs the pinned ttyd binary for amd64 and arm64
and verifies its published checksum. The npm package does not bundle ttyd because
it is a native executable. `nanasa start` checks `ttyd --version` before starting
and explains how to configure a nonstandard executable path.

GitHub Copilot profiles require an authenticated GitHub Copilot CLI with ACP
support. Pi profiles require an authenticated Pi installation and configured
provider. OpenCode and Claude Code require their own installed and authenticated
CLIs. Nanasa does not initiate interactive authentication or send a model prompt
during startup.

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
`.nanasa/runtime/`; they contain SQLite state, adapter sessions, sockets, and ttyd
manifests for one checkout.

Running `nanasa` without a command is equivalent to `nanasa start`. The daemon
walks upward from the current directory to find `.nanasa/config.yaml`, stores
durable state beneath that repository, and serves the portal at
<http://127.0.0.1:3210> by default.

The installed command accepts these options:

* `--host <host>` overrides `NANASA_HOST`
* `--port <port>` overrides `NANASA_PORT`
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
`apps/portal/dist`.

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

* `NANASA_HOST`, default `127.0.0.1`
* `NANASA_PORT`, default `3210`
* `NANASA_REPO_ROOT`, default discovered upward from the current directory
* `NANASA_DATA_PATH`, default `.nanasa/state/nanasa.sqlite`
* `NANASA_RUNTIME_PATH`, default `.nanasa/runtime`
* `NANASA_TMUX_SERVER`, default `nanasa`
* `NANASA_TTYD_PATH`, default `ttyd`
* `NANASA_SERVE_PORTAL`, default enabled only when `NODE_ENV=production`
* `NANASA_PORTAL_PATH`, set automatically by the installed command

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

GitHub Copilot runs use one durable worker in the owner tmux pane. The worker
owns the authoritative `copilot --acp --stdio` process and communicates through
bounded ACP NDJSON on standard input and output. Queue delivery is supported;
steer requests deterministically fall back to queue. Interrupt sends
`session/cancel` only while a prompt is active. ACP permission requests are
cancelled because peer messages cannot grant operator consent.

Pi runs use the corresponding durable JSONL worker and support queue and steer.
OpenCode and Claude Code remain terminal adapters with queue delivery only.
Regardless of profile adapter, explicit Terminal input delivery loads the
message into the verified owner pane, pastes it with bracketed paste enabled,
and sends Enter separately. This transport records successful injection but
does not claim semantic processing. Delivery retries when a live ttyd browser
writer owns the pane.

Terminal input is also a supported agent-to-agent channel. A future Nanasa MCP
server can expose `message.send` and `message.broadcast` tools that submit the
same message contract with `delivery.mode: terminal`. The daemon authenticates
the sending member and run, excludes the sender from group broadcasts, and then
uses the same guarded tmux paste-and-Enter path for each active recipient.

## Portal operations

The Add agent form loads agent types from `.nanasa/config.yaml`. New configured
keys appear without a portal code change, and existing profiles show both the
configured display name and stable key.

Use **Start all** in the selected group header to start every active member that
is not already running. The result panel reports each member as started, already
running, or failed. Repeated clicks while the operation is pending reuse one
idempotent request.

Member rows distinguish reconciling, resuming, restarting, recovered, and failed
recovery states. Active recovery can be stopped but not started again. Retry is
offered only when recovery cannot continue; a normally stopped member retains
the standard Start action.

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
| Message       | Structured content with audience, intent, and delivery policy                   |

## Roadmap

* [x] Tmux-backed groups, runs, terminal transport, and operational portal
* [x] Native structured adapters for GitHub Copilot CLI and Pi
* [ ] Native structured adapters beyond terminal queue delivery for OpenCode
  and Claude Code
* [ ] Per-agent worktrees and artifact handoff
* [ ] Authentication, authorization, and remote runner isolation
* [ ] Delivery retries, dead letters, and cost controls

## Known limitations

* GitHub Copilot CLI ACP remains a preview integration and may change between CLI
  releases
* ttyd 1.7.7 is the validated version; other system versions are not guaranteed
* Terminal input delivery confirms guarded paste and Enter injection, not semantic
  model processing
* OpenCode and Claude Code currently use terminal delivery; native structured
  adapters are pending

## Contributing

Issues and pull requests are welcome. Open an issue before starting a large
change while the architecture is still evolving.

## License

See [LICENSE](LICENSE).
