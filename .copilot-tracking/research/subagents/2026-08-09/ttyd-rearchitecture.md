---
title: Nanasa ttyd Rearchitecture Research
description: Evidence and concrete design for replacing Nanasa's custom browser terminal path with per-run ttyd endpoints
author: GitHub Copilot
ms.date: 2026-08-09
ms.topic: concept
---

## Research scope

* Design one ttyd endpoint for each active Nanasa run while tmux retains durable process ownership
* Verify ttyd 1.7.7 process, base-path, client-limit, writable, read-only, and tmux-targeting semantics
* Compare Node and Fastify approaches for dynamic per-run HTTP and WebSocket reverse proxying
* Define module boundaries, routes, spawn arguments, runtime state, reconciliation, failure handling, tests, security controls, and migration removals
* Preserve same-origin portal embedding and desktop/mobile tab and grid layouts

## Initial local evidence

* `apps/daemon/src/tmux-runtime.ts` creates one hashed tmux session per group and one window/pane per run. Persisted terminal bindings include the tmux server, session, window, and pane IDs.
* `apps/daemon/src/terminal-gateway.ts` owns the custom control-mode output subscriptions, snapshots, keyboard and paste input, resize commands, backpressure, and a 30-second single-writer lease.
* `apps/daemon/src/server.ts` exposes the custom terminal protocol at `/api/terminal` through `@fastify/websocket` and serves portal assets from the same Fastify process.
* `apps/portal/src/components/terminal-workspace.tsx` creates an xterm.js instance and one custom WebSocket client per visible terminal. It already provides tab and grid selection.

## Working architecture hypothesis

Keep run creation and termination in `TmuxRuntime`, remove control-mode browser transport, and add a daemon-owned ttyd supervisor that starts one loopback-only ttyd child for every reconciled active tmux pane. A same-origin Fastify proxy maps a short derived endpoint key to each child. ttyd executes a fixed `tmux attach-session` argv assembled from validated persisted binding data; no user-provided shell command enters the spawn path.

The existing one-session-per-group topology needs an additional per-run view session. A tmux session has one shared current window, so concurrent ttyd clients attached directly to different windows in the group session would switch one another. Each view session links only its run's existing window, has an independent current window, and introduces no second agent process. The group session remains the durable owner.

## Open evidence questions

* Exact ttyd 1.7.7 option names, defaults, process lifecycle, signal behavior, and child execution model
* Whether `--base-path` changes both HTML asset URLs and the WebSocket URL, and how trailing slashes are handled
* Whether `--max-clients 1` counts connected WebSockets and rejects additional clients without affecting the first
* Exact `--writable` and `--readonly` behavior in version 1.7.7
* The safest exact tmux attach target for a persisted pane or window and the effect of client resize on shared tmux windows
* Which Fastify-compatible proxy can dynamically resolve an upstream per request and preserve WebSocket upgrades without exposing upstream ports

## Findings

### ttyd 1.7.7 behavior

* ttyd 1.7.7 was released on March 30, 2024. The release itself only fixed version detection, but the 1.7.7 source and manual define all required runtime options.
* ttyd is a long-lived HTTP and WebSocket server. It does not start the configured command at ttyd process startup. Each accepted terminal WebSocket sends initial dimensions and causes ttyd to spawn one PTY child for that WebSocket.
* Closing a terminal WebSocket causes ttyd to signal that WebSocket's PTY child. The default signal is `SIGHUP`. When the child is `tmux attach-session`, this kills only the tmux client, not the tmux server, session, pane, or agent process.
* ttyd is read-only by default. `-W` or `--writable` permits terminal input. Resize frames are still handled independently of the writable check.
* `-m 1` or `--max-clients 1` rejects a second concurrent terminal WebSocket before it starts another PTY child. This is the suitable authoritative single-browser-writer mechanism.
* `-o` or `--once` both rejects later clients and exits ttyd after the first disconnect. `-q` or `--exit-no-conn` exits when the last connected client disconnects. Neither should be used for a continuously available per-run endpoint.
* `-a` or `--url-arg` appends client-supplied `arg=` query values to the command argv. It must remain disabled because it would permit request-controlled arguments to reach `tmux`.
* `-b` or `--base-path` trims trailing slashes, has a 128-byte limit, and prefixes the index, token, and WebSocket endpoints. A request to the prefix without a trailing slash receives a redirect to the prefix plus `/`.
* The 1.7.7 browser client derives `/ws` and `/token` from `window.location.pathname`. An iframe loaded at `/terminals/<runId>/` therefore connects to `/terminals/<runId>/ws` and fetches `/terminals/<runId>/token` without HTML rewriting.
* `-i 127.0.0.1 -p 0` binds a random loopback TCP port. ttyd logs the selected port as a notice. The supervisor must parse that bounded startup line and then perform an HTTP readiness probe before publishing the endpoint.
* `-O` or `--check-origin` compares the WebSocket `Origin` authority to the received `Host`. A reverse proxy must forward a validated external origin and the matching public host to ttyd. Sending the loopback host causes valid same-origin browser connections to fail this check.
* ttyd accepts Unix sockets through `-i`, but `@fastify/http-proxy` models WebSocket upstreams as URLs. Using Unix sockets would require a lower-level proxy such as `node-http-proxy` with `socketPath` or a custom upgrade implementation. Loopback TCP keeps the Fastify lifecycle and current security fixes available.

### tmux behavior

* tmux sessions and their panes survive client disconnects. Session, window, and pane IDs remain stable for the lifetime of each object.
* Current tmux attach implementation accepts a fully qualified target and resolves a `%paneId` to its containing window and session. The persisted IDs are therefore valid reconciliation anchors.
* Directly attaching all ttyd clients to the group session is incorrect for a grid. `attach-session -t %paneId` makes that pane and window active in the session, and the session's current window is shared by its clients.
* A separate session with one linked window avoids this collision. Session options such as current window, status, and prefix are independent, while the linked window and pane still contain the original durable agent process.
* `ignore-size` prevents an attached client from affecting window sizing. Do not use it for the ttyd client. Configure the linked window with `window-size latest` so the most recently active, single allowed ttyd client controls the pane dimensions.
* Set `prefix None`, `prefix2 None`, and `status off` on each view session. Browser input then reaches the agent pane instead of exposing tmux commands that can create windows, switch targets, or open a command prompt.

### Dynamic proxy options

* `@fastify/reply-from` supports a synchronous `getUpstream(request, base)` for dynamic HTTP/1 destinations, but does not itself provide terminal WebSocket proxying.
* `@fastify/http-proxy` 11.6.0 supports Fastify 5, parametric prefixes, prefix rewriting, HTTP streaming, WebSocket forwarding, Fastify `preHandler` authorization, and dynamic `replyOptions.getUpstream` for both HTTP and WebSocket requests when no static upstream is configured.
* Version 11.6.0 is the minimum acceptable proxy version as of this research. It fixes critical and high-severity prefix escape vulnerabilities affecting encoded HTTP paths and WebSocket traversal in versions through 11.5.0.
* The 11.6.0 runtime supports `wsClientOptions.rewriteRequestHeaders(headers, request)`, but its published TypeScript interface does not declare that extension. Nanasa will need a narrow local type augmentation or wrapper plus an integration test until the upstream types include it.
* `node-http-proxy` accepts a dynamic target on each `web()` and `ws()` call and copies `socketPath` to HTTP and WebSocket outbound requests. It is a viable Unix-socket alternative, but requires raw `upgrade` listener ownership, duplicate raw-request authorization, explicit upgraded-socket cleanup, and careful path validation.
* Fastify documents `fastify.server` as suitable for attaching listeners, but upgraded sockets are not tracked by normal HTTP close handling. A custom raw upgrade proxy must explicitly close them in `preClose`.

## Architecture decision

Use ttyd 1.7.7 behind `@fastify/http-proxy` 11.6.0 on per-run random loopback ports. Keep the current group tmux session as process owner and create one deterministic, single-window tmux view session per active run. Start one ttyd process per active run and attach it only to that run's view session.

This division keeps three ownership rules explicit:

* SQLite owns desired run state and persisted owner-pane bindings
* tmux owns durable agent processes and terminal history
* The daemon reconciles derived view sessions and owns ephemeral ttyd processes and proxy mappings

The tmux view sessions can survive a daemon restart without changing the ownership model. The reconciler verifies their linked window before reuse and recreates any invalid view.

## Recommended design

### Module boundaries

#### `tmux-runtime.ts`

Retain only durable tmux operations and reconciliation:

* Create the group owner session and run window/pane
* Validate persisted `TerminalBinding` values against `list-panes`
* Stop a run by killing its pane
* Ensure a deterministic view session named from a hash of `run.id`
* Verify that a view session contains exactly the persisted `windowId` and `paneId`
* Link the owner window into a newly created view session and remove its bootstrap window
* Apply `prefix None`, `prefix2 None`, `status off`, and `window-size latest`
* Remove stale view sessions for inactive runs

Remove output subscriptions, capture, input, paste, resize, pause, control clients, and all control-mode parsing from this module.

#### `ttyd-supervisor.ts`

Own one ephemeral ttyd child record per desired active run:

* Validate the run, owner binding, and view session before spawn
* Build a fixed argv array and call `spawn(ttydPath, args, { shell: false })`
* Parse the selected loopback port from bounded stderr startup output
* Probe the exact base-path index before publishing readiness
* Restart unexpected exits with bounded exponential backoff and jitter
* Terminate with `SIGTERM`, then `SIGKILL` after a grace period
* Keep bounded diagnostic stderr and expose state without exposing the port to API callers
* Write an atomic PID manifest for orphan detection after an ungraceful daemon exit

#### `terminal-endpoint-registry.ts`

Provide synchronous lookup for the proxy and status route:

* Key proxy records by a fixed-length endpoint key and retain the associated validated `runId`
* Return an upstream only when the store says the run is active, the pane binding still matches, and ttyd is ready
* Track `starting`, `ready`, `backoff`, `stopping`, and `unavailable`
* Never accept a host, port, URL, command, pane, or session from a request

#### `terminal-proxy.ts`

Register a single parametric Fastify proxy:

* Apply normal Nanasa authentication and authorization in `preHandler`
* Resolve the run through `TerminalEndpointRegistry`
* Preserve the complete public base path through `rewritePrefix`
* Restrict routes to the ttyd index, token, and WebSocket paths
* Restrict ordinary HTTP methods to `GET` and `HEAD`
* Validate same-origin WebSocket requests before proxying
* Strip inbound cookies and authorization before forwarding to loopback ttyd
* Set ttyd's outbound `Host` and `Origin` to the validated public authority so `-O` succeeds
* Preserve the `tty` WebSocket subprotocol and rely on ttyd's `-m 1` for the writer limit

#### `run-runtime-coordinator.ts`

Serialize run lifecycle changes and periodic reconciliation:

* Start: create run row, launch owner pane, persist binding, ensure view session, start ttyd, then expose endpoint readiness
* Stop: mark stopping, withdraw proxy target, stop ttyd, remove view session, kill owner pane, then mark stopped
* Reconcile: inspect tmux first, update durable run state, then reconcile view sessions and ttyd children to the resulting active set
* Close: withdraw all proxy targets and stop all ttyd children, but leave active owner panes and valid tmux view sessions intact

The coordinator avoids independent timers racing between tmux and ttyd reconciliation.

### Route shapes

Use the following public routes:

| Route | Purpose | Behavior |
|---|---|---|
| `GET /api/runs/:runId/terminal` | Portal status discovery | Returns state and same-origin URL, never the upstream port |
| `GET /terminals/:endpointKey` | Canonical redirect | Redirects to `/terminals/:endpointKey/` |
| `GET /terminals/:endpointKey/` | ttyd index | Proxied unchanged |
| `HEAD /terminals/:endpointKey/` | ttyd index metadata | Proxied unchanged |
| `GET /terminals/:endpointKey/token` | ttyd bootstrap token | Proxied unchanged |
| `GET /terminals/:endpointKey/ws` with upgrade | ttyd terminal stream | Proxied unchanged with `tty` subprotocol |

Derive `endpointKey` as 32 lowercase hexadecimal characters from SHA-256 of `run.id`, and reject collisions during registry insertion. This is a bounded routing key, not an authorization token. `/terminals/` plus the key stays well below ttyd's 128-byte base-path limit even though Nanasa's general identifier schema permits 128-character values.

The status response should be shaped as follows:

```json
{
  "runId": "run_...",
  "state": "ready",
  "url": "/terminals/0123456789abcdef0123456789abcdef/"
}
```

Return `404` for an unknown run or endpoint key, `409` for a known but inactive run, and `503` with `Retry-After` for a starting or backoff ttyd endpoint. A second WebSocket is rejected authoritatively by ttyd's `-m 1`. Nanasa should present this as first-writer-wins with no spectator connection rather than recreating a second lease system around ttyd.

### Proxy configuration shape

Register `@fastify/http-proxy` with these effective settings:

```text
prefix: /terminals/:endpointKey
rewritePrefix: /terminals/:endpointKey
upstream: empty string
websocket: true
routes: /, /token, /ws
httpMethods: GET, HEAD
replyOptions.getUpstream: synchronous registry lookup
preHandler: authenticate, authorize, validate run and origin, require ready endpoint
```

The parametric `rewritePrefix` is expanded with the validated route parameter. The upstream receives `/terminals/<endpointKey>/...`, which exactly matches ttyd's `--base-path`. Do not strip the prefix and do not rewrite ttyd HTML.

### tmux view-session construction

For each active legacy or new owner pane:

1. Derive `nanasa-view-<16 hex chars>` from a SHA-256 hash of `run.id`.
2. If it exists, verify its sole linked window and pane match the persisted binding.
3. If missing or invalid, kill only that view session and recreate it with a temporary bootstrap window.
4. Link the persisted owner `windowId` into the view session.
5. Select the linked window and kill the bootstrap window.
6. Set `prefix None`, `prefix2 None`, `status off`, and `destroy-unattached off` on the view session.
7. Set the linked window's `window-size` to `latest`.

All tmux calls use direct argv arrays. The view session name and base path are derived from validated IDs, not aliases, profile text, or request values.

### ttyd spawn command

The effective child argv for a ready run is:

```bash
/usr/local/bin/ttyd \
  --interface 127.0.0.1 \
  --port 0 \
  --base-path /terminals/<derived-endpoint-key> \
  --writable \
  --max-clients 1 \
  --check-origin \
  --signal SIGHUP \
  --terminal-type xterm-256color \
  --client-option rendererType=canvas \
  --client-option disableLeaveAlert=true \
  --client-option disableResizeOverlay=true \
  /usr/bin/tmux \
  -L <validated-server-name> \
  -f /dev/null \
  attach-session \
  -E \
  -t =<derived-view-session-name>
```

Use `spawn()` with `shell: false`. Do not include `--url-arg`, `--once`, `--exit-no-conn`, `ignore-size`, or any request-controlled command argument. `disableLeaveAlert=true` avoids ttyd's generic warning that leaving terminates the command; here it only terminates the disposable tmux client.

The canvas renderer is recommended for grid mode because multiple simultaneous WebGL contexts are less reliable on mobile devices and constrained browsers. This remains ttyd's renderer, not a portal xterm instance.

### Runtime state

Keep the following in memory for each run:

```text
runId
endpoint key
binding fingerprint: serverName, sessionId, windowId, paneId
view session name
public base path
phase: starting | ready | backoff | stopping | unavailable
child PID and process generation
loopback port after readiness
startedAt and lastReadyAt
consecutiveFailures and nextRestartAt
startup, restart, and stop timers
bounded stderr diagnostics
```

Do not persist loopback ports in SQLite or expose them through contracts. Persist only a small atomic runtime manifest containing PID, process start identity, run ID, binding fingerprint, and port. On startup, validate the executable, UID, process start identity, exact argv, and binding before adopting or terminating an orphan. Never signal a PID based only on its numeric value because PID reuse could target an unrelated process.

### Failure handling

* If ttyd is missing, has the wrong version, cannot bind, fails its readiness probe, or exits before ready, keep the tmux run in `running`, withdraw the proxy target, return `503`, and retry with capped exponential backoff. Terminal-provider failure must not be reported as agent-process failure.
* If a ready ttyd exits unexpectedly, atomically withdraw its registry generation before scheduling a replacement. Existing browser sockets close; the portal retries only after the replacement reaches ready.
* If the owner pane is missing or dead, stop and forget ttyd first, remove the view session, and transition the run according to the existing tmux exit policy. Do not restart ttyd for a dead pane.
* If the view session is missing or links the wrong window, withdraw the endpoint, stop ttyd, recreate the view from the persisted owner binding, and then start a new ttyd generation.
* If an operator stops a run, reject new index, token, and upgrade requests before signaling ttyd. Remove the view session before killing the owner pane so no attached client can race with teardown.
* On graceful daemon shutdown, remove proxy targets and terminate all ttyd children before Fastify closes upgraded sockets. Leave active owner panes and verified view sessions in tmux for startup reconciliation.
* After an ungraceful daemon exit, tmux remains authoritative. Reconcile validated PID manifests and service-cgroup state, then adopt an exact healthy ttyd child or terminate it and spawn a replacement. Unknown processes are never adopted or signaled.
* Fence every asynchronous callback with a per-run process generation. Late readiness, exit, or retry callbacks from an old ttyd child cannot overwrite a newer registry entry.
* Expose ttyd degradation in readiness and diagnostics. `/health` can remain process liveness, while a separate readiness result should report whether the ttyd binary is usable and whether active runs have ready or retrying providers.

### Portal behavior

Replace each xterm host with a same-origin iframe whose source is the bounded URL returned by the terminal status API.

* Tab mode mounts only the selected iframe. Changing tabs disconnects that ttyd WebSocket and releases the per-run writer slot.
* Grid mode mounts one iframe for each visible active run. Each run has a distinct ttyd process and tmux view session, so resizing and input remain isolated.
* Preserve the selected run when switching layouts. Do not mount a duplicate iframe for the selected run.
* On mobile, keep tabs as the default and render grid as a one-column vertical stack with a stable minimum height. On desktop, use the existing responsive auto-fit grid.
* Show daemon-derived loading and unavailable overlays outside the iframe. A second browser receives ttyd's connection-closed/reconnect surface because no read-only spectator is available on the same endpoint.
* Give every iframe a descriptive `title`. If a sandbox is used, ttyd requires scripts, same-origin access, and WebSocket access. `sandbox="allow-scripts allow-same-origin"` is the minimum practical combination, with popup and top-navigation permissions omitted.

## Tests

### Unit tests

* Exact ttyd argv snapshot with no shell and no request-derived command arguments
* Rejection of malformed run, endpoint-key, pane, session, server, and base-path values
* Startup port parsing across split stderr chunks, bounded output, timeout, early exit, and failed readiness probe
* Supervisor idempotency, generation fencing, exponential backoff, successful reset, graceful stop, forced stop, and stale callback suppression
* View-session creation, exact linked-window verification, bootstrap cleanup, option application, stale-view removal, and idempotent reconciliation
* Registry denial for unknown, inactive, mismatched, starting, backoff, and stopping runs
* Proxy preservation of index, token, WebSocket path, and query strings
* Proxy rejection of encoded separators, traversal, extra suffixes, unsupported methods, invalid origins, and unauthorized requests
* HTTP and WebSocket header rewriting that strips credentials while preserving the validated public `Host` and `Origin`

### Integration tests with tmux and ttyd 1.7.7

* Start two runs in one group, verify one owner group session, two owner windows, two isolated view sessions, and two ready ttyd endpoints
* Load both terminals concurrently, type distinct input, and verify no window switching or cross-run output
* Resize both iframe terminals to different dimensions and verify the corresponding panes change independently
* Open a second browser connection to one run and verify first-writer-wins rejection while the original remains writable
* Disconnect and reconnect the browser, verifying pane history and the agent process persist
* Restart the daemon, verifying tmux panes persist, ttyd endpoints are reconciled, and iframe reconnection reaches the same panes
* Kill ttyd while the pane lives, verifying `503` during backoff and recovery without changing run status
* Exit the agent pane, verifying proxy withdrawal, ttyd termination, view-session cleanup, and run transition to stopped
* Stop a run while a browser is connected, verifying no new upgrade is accepted and all resources are cleaned up
* Crash the daemon after manifest creation, then verify orphan ttyd adoption or safe termination on restart

### Portal tests

* Tabs mount exactly one iframe and preserve selection
* Grid mounts exactly one iframe per visible run and never duplicates a run
* Switching back to tabs releases hidden iframe connections
* Ready, starting, unavailable, second-writer rejection, and stopped states render correctly
* Desktop grid, narrow mobile tabs, and one-column mobile grid do not overflow or overlap
* Keyboard focus enters the selected iframe without portal shortcuts intercepting terminal input

Use Playwright for the browser and ttyd protocol tests. Fastify injection remains suitable for status and ordinary HTTP proxy errors, but it is insufficient by itself for iframe layout, ttyd's binary protocol, WebSocket upgrade behavior, and browser-origin checks.

## Security caveats

* ttyd 1.7.7 is more than two years old as of August 2026. Pin the binary and checksum, but schedule a compatibility and security review against the latest ttyd before production exposure.
* Pin `@fastify/http-proxy` to at least 11.6.0. Versions through 11.5.0 have known encoded-path and WebSocket traversal vulnerabilities directly relevant to this route.
* The current Nanasa server has no visible authentication layer. Same origin is not authentication. Terminal routes require the same authenticated operator session as the portal before deployment beyond trusted loopback use.
* Validate WebSocket `Origin` against a configured public origin or a tightly validated host allowlist. Do not authorize from an untrusted `Host` or `X-Forwarded-*` header. Configure Fastify `trustProxy` only for known proxy hops.
* Bind every ttyd process to `127.0.0.1`. Do not use `0.0.0.0`, container-wide exposed ports, or publish the selected port.
* Omit `--url-arg`. Use direct argv arrays and `shell: false` for ttyd and tmux. Request values may select only a run ID, which is resolved to stored validated state.
* A writable terminal intentionally grants input to the already running agent process. This is distinct from allowing the HTTP request to choose an executable or tmux target.
* `--max-clients 1` provides one browser WebSocket writer, not a distributed lock against local same-UID tmux clients. A local process with access to the tmux socket can still attach or send keys. The tmux socket and daemon account remain part of the trust boundary.
* Disable the tmux prefix in the view session. Otherwise browser input can invoke tmux commands, create shells, switch windows, or kill the session even when the endpoint was intended for one agent pane.
* Strip portal cookies, authorization headers, and unrelated forwarding headers before sending traffic to ttyd. Forward only the minimum headers needed for WebSocket negotiation and the validated `Host` and `Origin` pair.
* Use a strict route allowlist. ttyd needs only the index, token, and WebSocket endpoints. Do not register an unconstrained wildcard proxy to a request-selected upstream.
* Treat the endpoint key as routing data only. Authentication and authorization must still protect both its status API and proxy routes.
* Apply `frame-ancestors 'self'`, a compatible terminal-route content security policy, `X-Content-Type-Options: nosniff`, and an appropriate referrer policy. Test the policy against ttyd's bundled script before enforcing it.
* ttyd client options and query parameters can alter rendering behavior. Do not permit unvalidated query-driven options if they create unacceptable memory or rendering costs.
* Run the daemon and children under a service or container cgroup that kills descendants on service stop. PID manifests cover restart reconciliation but should not be the only production child-reaping control.

## Migration and removals

### Migration sequence

1. Pin and install ttyd 1.7.7 for the supported architectures, verifying each release artifact against the official `SHA256SUMS` file.
2. Add view-session reconciliation without changing the browser path. Verify that linking a window does not restart or duplicate its agent process.
3. Add `TtydSupervisor`, endpoint registry, status route, and the restricted proxy using `@fastify/http-proxy` 11.6.0 or newer.
4. Render ttyd iframes behind a feature flag while keeping existing run start and stop semantics.
5. Convert existing active group-window runs by creating view sessions linked to their persisted windows. No live pane move or agent restart is required.
6. Switch terminal tabs and grid to iframe rendering and validate desktop and mobile behavior.
7. Remove the custom gateway, xterm renderer, terminal protocol contracts, and control-mode runtime only after the ttyd integration suite passes.
8. Remove the feature flag after one release with startup reconciliation and rollback coverage.

Rollback can restore the custom browser path while owner panes remain untouched. View sessions are extra links and can be killed without killing owner windows.

### Removal list

* Delete `apps/daemon/src/terminal-gateway.ts`
* Delete `apps/daemon/src/tmux-control.ts`
* Remove `TmuxControlClient`, tracked output sequences, subscriptions, capture, input, key, paste, resize, pause, and continue methods from `apps/daemon/src/tmux-runtime.ts`
* Remove the `/api/terminal` WebSocket route and `TerminalGateway` setup from `apps/daemon/src/server.ts`
* Remove `writerLeaseDurationMs`, `scriptPath`, and related daemon options unless `scriptPath` remains needed elsewhere
* Keep `@fastify/websocket` because `/api/events` still uses it
* Delete `apps/portal/src/terminal-client.ts`
* Replace xterm construction in `apps/portal/src/components/terminal-workspace.tsx` with iframe and endpoint-state components
* Remove `@xterm/xterm` and `@xterm/addon-fit` from `apps/portal/package.json`
* Remove xterm CSS imports and obsolete terminal gateway status styles
* Remove terminal client/server frame schemas, writer lease frames, `TerminalKey`, and their tests from `packages/contracts/src/index.ts`
* Replace gateway integration tests with ttyd supervisor, proxy, browser, and reconciliation tests
* Add `@fastify/http-proxy` 11.6.0 or newer to the daemon dependencies
* Add pinned ttyd installation and checksum verification to container and release packaging

## References

* [ttyd 1.7.7 README and options](https://github.com/tsl0922/ttyd/blob/1.7.7/README.md)
* [ttyd 1.7.7 server option and base-path implementation](https://github.com/tsl0922/ttyd/blob/1.7.7/src/server.c)
* [ttyd 1.7.7 HTTP route implementation](https://github.com/tsl0922/ttyd/blob/1.7.7/src/http.c)
* [ttyd 1.7.7 WebSocket and PTY lifecycle](https://github.com/tsl0922/ttyd/blob/1.7.7/src/protocol.c)
* [ttyd 1.7.7 browser URL construction](https://github.com/tsl0922/ttyd/blob/1.7.7/html/src/components/app.tsx)
* [ttyd 1.7.7 browser terminal behavior](https://github.com/tsl0922/ttyd/blob/1.7.7/html/src/components/terminal/xterm/index.ts)
* [ttyd 1.7.7 manual](https://github.com/tsl0922/ttyd/blob/1.7.7/man/ttyd.man.md)
* [ttyd 1.7.7 release](https://github.com/tsl0922/ttyd/releases/tag/1.7.7)
* [tmux manual](https://github.com/tmux/tmux/blob/master/tmux.1)
* [tmux attach target implementation](https://github.com/tmux/tmux/blob/master/cmd-attach-session.c)
* [tmux target resolution](https://github.com/tmux/tmux/blob/master/cmd-find.c)
* [`@fastify/http-proxy` documentation](https://github.com/fastify/fastify-http-proxy)
* [`@fastify/http-proxy` 11.6.0 implementation](https://github.com/fastify/fastify-http-proxy/blob/v11.6.0/index.js)
* [`@fastify/http-proxy` WebSocket traversal advisory](https://github.com/fastify/fastify-http-proxy/security/advisories/GHSA-7hrw-592w-9wh2)
* [`@fastify/http-proxy` encoded-prefix advisory](https://github.com/fastify/fastify-http-proxy/security/advisories/GHSA-mx7v-qhg9-2mvv)
* [`@fastify/reply-from` dynamic upstream documentation](https://github.com/fastify/fastify-reply-from)
* [Fastify server and shutdown lifecycle](https://fastify.dev/docs/latest/Reference/Server/)
* [`node-http-proxy` HTTP and WebSocket APIs](https://github.com/http-party/node-http-proxy)
* [Node.js HTTP upgrade event](https://nodejs.org/api/http.html#event-upgrade-1)

## Clarifying questions

* What authentication and operator authorization model should protect the portal and terminal endpoints? The current code shown in this research does not establish one.
* Must production support architectures beyond official ttyd 1.7.7 `x86_64` and `aarch64` artifacts used by the intended container images?