<!-- markdownlint-disable-file -->
# MCP, CRUD, and Browser Acceptance Research

## Research scope

1. Determine how to add an authenticated local MCP server for direct messages, multicast, and sender-excluded group broadcast through the existing message command and terminal injection.
2. Determine backend and portal changes for renaming and deleting groups and agents or members, including cascade behavior and run shutdown semantics.
3. Determine Playwright acceptance coverage for Start All, terminal messaging, preferences, responsive layout, and daemon restart recovery.

## Constraints

* Research only; do not modify implementation code.
* Do not install packages.
* Treat `.devcontainer/.env` as authoritative for package registry configuration.
* Identify exact contracts, routes, store methods, UI surfaces, tests, package changes, and implementation sequencing.

## Current architecture evidence

The message and terminal paths already provide the behavior that the MCP tools
need:

* `packages/contracts/src/index.ts` defines `AudienceSchema` with `dm`,
	`multicast`, and `group`, `SubmitMessageCommandSchema`, and the `terminal`
	delivery mode.
* `NanasaStore.submitMessage` in `apps/daemon/src/store.ts` validates the sender,
	resolves recipients, writes one message plus delivery rows in one immediate
	transaction, and emits `message.submitted`.
* `NanasaStore.#resolveRecipients` checks the group membership revision for a
	broadcast. When the sender is an agent, it removes the sender member ID from
	the active-member result. DM and multicast recipients must be active.
* `DeliveryDispatcher` wakes on `message.submitted`, claims only deliveries with
	an active membership and running run, and routes `terminal` without falling
	back to an adapter mode.
* `TmuxTerminalDelivery.deliver` checks that the run is current, rejects a ttyd
	writer conflict, and delegates to `TmuxRuntime.pasteToRun`.
* `TmuxRuntime.pasteToRun` uses a named tmux buffer, bracketed paste, and Enter.
	The one MiB size guard and current-pane ownership check therefore also apply
	to MCP calls.
* The public HTTP equivalent is already `POST /api/groups/:groupId/messages` in
	`apps/daemon/src/server.ts`. MCP should call the store command through a small
	application service, not call this route over loopback and not reimplement
	recipient or terminal logic.

The existing mutation and recovery boundaries are also useful:

* Group, profile, membership, run, message, delivery, event, and idempotency
	state is held by `NanasaStore` in SQLite.
* Membership removal is already correctly split: `RunRuntimeCoordinator` owns
	runtime shutdown, then `NanasaStore.removeMembership` soft-removes the row,
	increments `membershipRevision`, revokes unsettled deliveries, and emits
	`membership.removed`.
* `RunRuntimeCoordinator.#stopRun` fences recovery by setting desired state to
	stopped, shuts down the adapter, stops ttyd, removes the view session, and
	kills the owner pane.
* On daemon startup, `createDaemon` calls `coordinator.reconcile(true)` before
	listening. Current tmux panes are reattached; missing desired-running panes
	are replaced according to the profile recovery policy.
* `useDomainEvents` reconnects its WebSocket with bounded exponential backoff
	and resumes after the highest observed sequence. `usePortalSnapshot.refresh`
	reloads snapshot and configuration together.
* Portal preferences already persist theme and terminal layout under
	`nanasa.portal.preferences.v1` and synchronize through both `storage` and a
	same-tab custom event.

Current testing is Vitest only. Daemon route tests use Fastify injection, portal
tests use Testing Library/jsdom, and `apps/daemon/test/ttyd-runtime.test.ts`
provides a real tmux/ttyd echo fixture. No Playwright configuration or CI
workflow exists.

## Authenticated local MCP server

### Protocol and library choice

Use MCP 2026-07-28 Streamable HTTP at `POST /mcp`, in stateless JSON-response
mode. Add these direct runtime dependencies at the same pinned version:

* `@modelcontextprotocol/server` for `McpServer`, tool registration, protocol
	schemas, and conformance behavior
* `@modelcontextprotocol/node` for
	`NodeStreamableHTTPServerTransport`, request/response adaptation, and the
	localhost Host and Origin guards

Do not add `@modelcontextprotocol/fastify`. Its integration is a thin wrapper
and Nanasa already owns a Fastify instance. The official Node adapter accepts
`request.raw`, `reply.raw`, and the parsed body. It adds one transitive runtime
package (`@hono/node-server`); the server package depends on the MCP core and
Zod, while Nanasa already uses Zod 4.

Do not hand-roll JSON-RPC or MCP lifecycle/version handling. The apparent
dependency saving is small and would make protocol compatibility, tool result
shape, cancellation, and conformance Nanasa's maintenance burden.

Streamable HTTP is preferable to stdio here because one daemon owns the store,
dispatcher, and recovered runs. A stdio server would need a second private API
or direct concurrent SQLite access. The HTTP endpoint can translate directly
into the existing command in the authoritative process.

The MCP specification requires localhost binding, Origin validation, and
authentication for a protected local Streamable HTTP endpoint. Full
specification authorization is OAuth 2.1 resource-server behavior with
protected-resource metadata and an authorization server. That is inappropriate
for this single-user, repository-local capability. Use a documented local
pre-shared bearer capability model and do not describe it as MCP OAuth
conformance. If remote access is later required, replace this local policy with
an external OAuth authorization server and audience-bound access tokens.

### Concrete authentication model

Use signed, per-run bearer capability tokens with no token table and no new
cryptography dependency:

1. `apps/daemon/src/mcp-auth.ts` owns `McpCredentialIssuer`.
2. On first MCP-enabled startup, create a 32-byte random HMAC secret at
	 `.nanasa/state/mcp-secret` with directory mode `0700` and file mode `0600`.
	 Never log or return this secret.
3. Mint a compact token containing a version, `groupId`, `memberId`, `runId`,
	 `generation`, issued-at time, and a random nonce. Sign the encoded payload
	 with HMAC-SHA-256 from `node:crypto`.
4. Pass the raw token only to that run as `NANASA_MCP_TOKEN`; pass the endpoint as
	 `NANASA_MCP_URL`. `TmuxRuntime.#launch` is the common launch point and already
	 builds `tmux new-window -e` environment arguments. Add dynamic runtime
	 environment arguments there, separate from immutable profile environment.
	 Worker-backed adapters inherit the tmux window environment; terminal
	 adapters receive it directly.
5. On every MCP request, require exactly `Authorization: Bearer <token>`, verify
	 the signature with a constant-time comparison, then load the run and verify
	 exact generation, group/member identity, active membership, desired state
	 `running`, and status `starting` or `running`.
6. Derive the `SubmitMessageCommand.sender` entirely from the verified claims.
	 Tool arguments must not contain sender identity or group ID.
7. Runtime shutdown revokes the credential without a revocation database: once
	 the run enters `stopping`, validation fails. A replacement generation gets a
	 new token. The persisted signing secret allows a surviving current run to
	 retain its credential across daemon restart.

This model prevents caller-selected impersonation, makes sender exclusion
trustworthy, and limits a leaked token to one active run and one group. Add a
short per-principal rate limit in memory (for example, 30 calls per minute with
a small burst) because MCP tool guidance requires rate limiting. The existing
message body limit should also be made explicit in the MCP input schema, at or
below the one MiB terminal guard.

Bind the MCP endpoint only when explicitly enabled. Recommended configuration:

* `NANASA_MCP_ENABLED=false` by default
* `NANASA_MCP_PATH=/mcp` with path validation and `/mcp` as the default
* Require the daemon listener host to be `127.0.0.1`, `::1`, or `localhost` when
	MCP is enabled. Refuse startup otherwise. This avoids exposing the endpoint
	when the portal is launched on `0.0.0.0` in a container.
* Apply `localhostHostValidation()` and `localhostOriginValidation()` from
	`@modelcontextprotocol/node` before bearer validation. Reject invalid Host or
	Origin with 403, absent/invalid bearer credentials with 401, and never accept
	tokens in the query string.

If container-to-host MCP clients must reach a daemon bound to `0.0.0.0`, use a
second loopback listener or an authenticated reverse proxy as a separate change.
Do not weaken the default route guard.

### MCP tools and command mapping

Register three model-facing tools. Keep their Zod schemas local to
`apps/daemon/src/mcp-server.ts`; they are transport contracts, not shared portal
domain contracts.

After authentication, create one `McpServer` and one stateless
`NodeStreamableHTTPServerTransport` per HTTP request. Register handlers that
close over only that request's verified principal, connect, handle the parsed
body, and close both objects when the response closes. Do not share a mutable
"current principal" across transports or requests.

* `nanasa.send_dm`: `{ recipientMemberId, text, intent?, contentType?,
	conversationId?, replyTo? }`
* `nanasa.send_multicast`: the same fields plus unique `recipientMemberIds` with
	a minimum of two
* `nanasa.broadcast_group`: `{ text, intent?, contentType?, conversationId?,
	replyTo? }`, with no sender or recipient fields

Defaults should be `intent: "request"`, `contentType: "text/markdown"`, and
`hop: 0`. Every tool sets `delivery: { mode: "terminal" }`. The broadcast tool
loads the current group membership revision immediately before submission. It
then submits an agent sender derived from auth, so `#resolveRecipients` excludes
the caller. A broadcast with no other active member returns the existing
`empty_audience` business error.

Extract an internal `MessageCommandService` used by both the REST route and MCP
tools if asynchronous dispatch wake-up or auditing is added. For the current
code, direct `store.submitMessage` reuse is sufficient because the store event
wakes `DeliveryDispatcher`.

Return `MessageSubmissionResult` as `structuredContent` and also serialize a
compact summary into a text content block for older clients. Convert
`DomainError` and Zod failures into tool results with `isError: true`; reserve
JSON-RPC protocol errors for malformed MCP messages and unknown tools.

### Exact daemon and package surfaces

Add or change:

* `apps/daemon/src/mcp-auth.ts`: secret persistence, token issue/verify, active
	principal resolution, and constant-time comparison
* `apps/daemon/src/mcp-server.ts`: MCP server factory, three tools, auth/rate
	limit hook, Host/Origin guards, and stateless Node transport handling. Register
	`POST /mcp`; register `GET /mcp` and `DELETE /mcp` to return 405 JSON-RPC error
	responses because this server does not need server-initiated SSE or sessions.
* `apps/daemon/src/server.ts`: MCP options/context, route registration, and MCP
	server close lifecycle
* `apps/daemon/src/index.ts`: parse enable/path settings and reject non-loopback
	binding when enabled
* `apps/daemon/src/tmux-runtime.ts`: dynamic per-run environment provider used
	by `#launch`
* `apps/daemon/test/mcp-auth.test.ts`: tamper, wrong generation, stopped run,
	inactive member, restart-secret persistence, and no-token cases
* `apps/daemon/test/mcp-server.test.ts`: initialize/list/call protocol flow,
	Host/Origin rejection, bearer failures, all three audience mappings, terminal
	delivery, sender exclusion, structured results, and rate limiting
* `apps/daemon/test/tmux-runtime.test.ts`: verify dynamic MCP variables are
	passed to a launched fixture but never persisted in profiles or events
* `package.json` and `apps/daemon/package.json`: add
	`@modelcontextprotocol/server` and `@modelcontextprotocol/node`
* `scripts/build-package.mjs`: externalize both MCP packages alongside Fastify,
	Zod, ws, and YAML
* `pnpm-lock.yaml`: lock the two direct packages and their transitive graph
* `bin/nanasa.js`: optional `--mcp` flag mapped to `NANASA_MCP_ENABLED=true` and
	help text; no token output

No change to `SubmitMessageCommandSchema`, audience schemas, delivery schemas,
or SQLite message tables is required for the MCP tools.

## Rename and delete lifecycle

### Product model boundary

The portal calls a group membership an "agent", but the stored model separates
the membership from a reusable `AgentProfile`. Rename/delete on a group row
should therefore operate on `Group`; rename/delete on an agent row should
operate on `GroupMembership.alias` and membership state. Removing an agent must
not delete its shared profile.

Profile management is a separate feature. If profile deletion is later exposed,
it should return `409 agent_profile_in_use` while any membership or historical
run references it; it must never cascade through multiple groups.

### Shared contracts

Add to `packages/contracts/src/index.ts`:

* `UpdateGroupCommandSchema`: strict object with `name` matching the existing
	one-to-100-character group name rule
* `DeleteGroupResultSchema`: strict object with `groupId`, `deletedMemberships`,
	`deletedRuns`, `deletedMessages`, and `deletedDeliveries` nonnegative counts
* `UpdateGroupMembershipCommandSchema`: strict object with `alias` matching the
	existing one-to-100-character alias rule

Export inferred types. Existing `GroupSchema` and `GroupMembershipSchema` are
the update responses. Existing membership DELETE can continue to return the
soft-removed `GroupMembership`. Add contract tests for trimming, empty/oversize
values, strict unknown-key rejection, and delete-result counts.

### Routes

Add to `apps/daemon/src/server.ts`:

* `PATCH /api/groups/:groupId` -> `store.updateGroup`, 200 `Group`
* `DELETE /api/groups/:groupId` -> `coordinator.deleteGroup`, 200
	`DeleteGroupResult`
* `PATCH /api/groups/:groupId/memberships/:memberId` ->
	`store.updateMembership`, 200 `GroupMembership`

Keep the existing
`DELETE /api/groups/:groupId/memberships/:memberId`, but expose it in the portal
client and UI. All four mutating routes should accept `Idempotency-Key`.

### Store behavior

Add these methods to `NanasaStore`:

* `updateGroup(groupId, command, key)`: require the group, update `name` and
	`updated_at`, emit `group.updated` with previous and updated names, and use
	scope `group.<id>.update`.
* `updateMembership(groupId, memberId, command, key)`: require an active
	membership, update only `alias`, emit `membership.updated`, and use scope
	`group.<id>.membership.<member>.update`.
* `deleteGroup(groupId, key)`: require the group, count dependents, explicitly
	delete the graph in one `BEGIN IMMEDIATE` transaction, emit `group.deleted`
	with counts, and return `DeleteGroupResult`.

Alias changes must not increment `membershipRevision`; the revision protects
the eligible recipient set, and an alias does not change that set. Group rename
also does not change it. Member removal keeps the current revision increment.

Use explicit ordered deletion rather than rewriting SQLite foreign keys in a
migration:

1. Null `reply_to`, `root_id`, and `causation_id` in messages outside the group
	 when they point to a message being deleted. The current submission contract
	 does not prohibit cross-group references.
2. Delete group delivery rows.
3. Delete group messages.
4. Delete group runs.
5. Delete group memberships, including already removed rows.
6. Delete group-scoped idempotency rows. Escape wildcard characters and match
	 exact scope prefixes rather than interpolating SQL.
7. Delete the group.
8. Append `group.deleted` in the same transaction. The event remains as audit
	 history and supplies the event sequence for the delete idempotency result.

Agent profiles and domain events remain. This is the intended cascade boundary:
the group aggregate disappears from snapshots, but reusable launch templates
and append-only audit events do not.

### Runtime shutdown semantics

`RunRuntimeCoordinator.deleteGroup` must own deletion and run inside the same
`#serialize` lane as Start All, individual start/stop, recovery reconciliation,
and membership removal:

1. Require the group and snapshot its active memberships.
2. For each member with an active run or a latest desired-running run, call the
	 private stop path. This sets desired state stopped before stopping adapters,
	 ttyd, view sessions, and owner panes.
3. If any stop fails, abort the database delete and return the error. Runs that
	 already stopped remain stopped; retry is safe and converges.
4. After every run is fenced/stopped, call `store.deleteGroup`.

Stopping before deleting prevents restart reconciliation from recreating a run
whose membership has vanished. The store transaction then removes historical
run rows. The MCP principal validation described above becomes invalid as soon
as a run starts stopping, so group/member deletion also revokes MCP access.

Membership deletion should retain its current semantics: stop the active or
desired-running run first, soft-remove the row, revoke pending deliveries, and
increment membership revision. A second delete returns the existing 404
`membership_not_active`; idempotency replays the first response when the same
key is used.

### Portal client and UI

Extend `PortalClient` and `api` in `apps/portal/src/api.ts` with
`updateGroup`, `deleteGroup`, `updateMembership`, and `removeMembership`.
Expand `commandInit` to accept `PATCH`. Parse every request and response with the
new or existing contract schema.

In `App.tsx`, add handlers through the existing `runAction` wrapper. After group
deletion, select the next group at the deleted index, otherwise the previous
last group, and clear stale Start All results. Snapshot refresh remains the
source of truth. After membership deletion, refresh and let the terminal
workspace unmount the removed run.

In `components/group-tree.tsx`:

* Add group actions using Lucide `Pencil`, `Trash2`, and `MoreVertical` icons.
* Add member actions for rename and remove without displacing the start/stop
	action.
* Use an inline edit field for rename with Save/Cancel icon buttons.
* Use a real confirmation dialog for destructive actions. Group confirmation
	names the group and states member/run/message counts. Member confirmation
	states that an active run will be stopped and queued delivery revoked.
* Disable all competing actions while the matching `busyAction` is active.
* Preserve keyboard focus on cancel; after delete move focus to the selected
	neighboring group or group heading.

Add compact dialog and action-menu styles to `apps/portal/src/styles.css`, with
the existing four-pixel control radius and responsive constraints. On mobile,
menus/dialogs must remain within the viewport and must not increase the rail's
fixed share of the screen.

Update:

* `packages/contracts/test/contracts.test.ts` for new schemas
* `apps/daemon/test/store.test.ts` for rename events, no revision bump, delete
	counts/cascade, cross-group message references, idempotent replay, and reopen
* `apps/daemon/test/run-runtime-coordinator.test.ts` for stop-before-delete,
	desired-running recovery fencing, partial stop failure, and retry
* `apps/daemon/test/server.test.ts` for exact routes/statuses and validation
* `apps/portal/src/api.test.ts` for encoding, HTTP verbs, keys, and parsing
* `apps/portal/src/App.test.tsx` for inline rename, confirmations, selection
	fallback, refresh, error banners, and active-member removal

## Playwright acceptance coverage

### Harness

Add `@playwright/test` as a root dev dependency and add a root
`test:acceptance` script. Keep it separate from the default unit test command at
first because it requires Chromium, tmux, and ttyd. Do not add browser libraries
to `apps/portal/package.json`.

Add:

* `playwright.config.ts`: `testDir: "./test/acceptance"`, Chromium-only project,
	one worker, deterministic desktop viewport, trace on first retry, screenshot
	on failure, no reused external server
* `test/acceptance/fixtures.ts`: a worker fixture that creates a temporary Git
	repository/config/state directory, chooses a free loopback port and unique
	tmux server name, spawns the packaged daemon, waits on `/health`, exposes
	`restart()` and API seeding helpers, captures logs on failure, and always kills
	daemon/ttyd/tmux state on teardown
* `test/acceptance/fixtures/echo-agent.mjs`: readline fixture that prints READY
	and echoes each line with a stable marker
* `test/acceptance/portal.spec.ts`: Start All, terminal messaging, preferences,
	and responsive layout
* `test/acceptance/restart.spec.ts`: graceful daemon restart and browser recovery

Build the production package before the suite so static serving and the real
CLI layout are covered. The temporary `.nanasa/config.yaml` defines an
`opencode`-kind terminal adapter whose command is Node plus the absolute echo
fixture path. Seed groups, profiles, and memberships through public HTTP APIs;
do not reach into `NanasaStore` from browser tests.

Use a custom fixture rather than Playwright `webServer` because restart recovery
must stop and relaunch the same daemon with the same SQLite database, runtime
directory, port, and tmux server. Send SIGTERM and wait for graceful exit so
`app.close()` stops ttyd while leaving owner panes alive, matching production
restart semantics.

### Acceptance cases

Start All:

1. Seed one group, one echo profile, and two memberships.
2. Open the portal and click the accessible Start All button.
3. Assert one request despite a rapid double click, a completed outcome for
	 both members, two running statuses, and terminal tabs for both members.
4. Click Start All again and assert `already-running` outcomes without new run
	 generations.

Terminal messaging:

1. Switch from Terminal Mode to Message Mode so the ttyd writer disconnects.
2. Select DM and `Terminal input`, send a unique marker, and assert the delivery
	 result reaches `consumed`.
3. Switch back to Terminal Mode, enter the recipient iframe, and assert the echo
	 fixture displays the marker.
4. Assert the nonrecipient terminal does not contain it. Add a multicast case
	 when MCP/portal multicast delivery is part of the same implementation slice.

Preferences:

1. Select dark theme and grid terminal layout.
2. Reload and assert `data-theme="dark"`, the grid button pressed, and both
	 terminal iframes mounted.
3. Open a second page in the same browser context, change back to tabs/light,
	 and assert the first page synchronizes through the real storage event.
4. Verify malformed preloaded local storage falls back to system/tabs in a
	 separate context.

Responsive layout:

1. At 1280 by 800, assert the rail and workspace are side by side, header
	 controls are visible, terminal/message surfaces have nonzero bounds, and
	 `scrollWidth <= innerWidth`.
2. At 390 by 844, assert the rail is above the workspace, icon-only controls
	 retain accessible names, the member action menu and destructive dialog fit
	 inside the viewport, the terminal grid becomes one column, and there is no
	 horizontal overflow.
3. Capture desktop and mobile screenshots as failure artifacts, not brittle
	 pixel-perfect golden assertions initially.

Daemon restart recovery:

1. Start two runs and wait for ready terminal iframes.
2. Record run IDs, generations, endpoint URLs, and an echo marker from each.
3. SIGTERM the daemon while leaving tmux panes alive; assert the portal event
	 indicator enters reconnecting.
4. Restart against the same state/runtime/tmux identity.
5. Assert the indicator returns connected, the same run IDs/generations and
	 endpoint URLs return, no replacement run is created, both iframes become
	 ready, and both original echo processes still answer input.
6. In a separate lower-level daemon test, keep the existing missing-pane case
	 that expects replacement generation. Browser acceptance should test the
	 normal daemon restart path, not conflate it with process crash recovery.

The fixture should fail early with a clear prerequisite message when tmux, ttyd,
or the Playwright Chromium executable is absent. Browser installation is an
environment provisioning step, not a runtime package script side effect.

## Recommended sequencing

1. Add and test the group/member update and delete contracts.
2. Implement store rename methods and explicit group cascade with store tests.
3. Add coordinator-owned group deletion and shutdown/fencing tests.
4. Add REST routes and portal client methods with route/API tests.
5. Add the GroupTree rename/delete interactions and responsive styles with
	 jsdom tests.
6. Add MCP auth first: persisted signing secret, per-run claims, active-run
	 validation, and dynamic launch environment. Test tamper, stop, generation,
	 and restart behavior before exposing tools.
7. Add the SDK-backed `/mcp` endpoint and three thin tools that call
	 `submitMessage`; add protocol/auth/tool tests.
8. Update package metadata, package bundling externals, CLI enablement, and the
	 lockfile. Run package tests because the shipped daemon now has two new
	 external runtime dependencies.
9. Add the Playwright fixture and Start All/terminal/preferences/responsive
	 cases.
10. Add restart recovery acceptance last, after the fixture can reliably own
		daemon, ttyd, and tmux cleanup.

This order keeps domain deletion semantics independent from UI, validates MCP
identity before granting terminal injection, and builds browser coverage on
stable public routes.

## Clarifying questions

No question blocks the proposed local design. Product confirmation is needed
only if "delete agent" is intended to delete reusable `AgentProfile` records
rather than remove a group membership. The current portal language and data
model support membership removal as the safer interpretation.

## References

Workspace evidence:

* `AGENTS.md`
* `package.json`
* `apps/daemon/package.json`
* `apps/daemon/src/server.ts`
* `apps/daemon/src/store.ts`
* `apps/daemon/src/run-runtime-coordinator.ts`
* `apps/daemon/src/delivery-dispatcher.ts`
* `apps/daemon/src/terminal-adapter.ts`
* `apps/daemon/src/tmux-runtime.ts`
* `apps/daemon/test/server.test.ts`
* `apps/daemon/test/store.test.ts`
* `apps/daemon/test/ttyd-runtime.test.ts`
* `apps/portal/package.json`
* `apps/portal/src/api.ts`
* `apps/portal/src/App.tsx`
* `apps/portal/src/components/group-tree.tsx`
* `apps/portal/src/components/message-workspace.tsx`
* `apps/portal/src/components/terminal-workspace.tsx`
* `apps/portal/src/hooks/use-portal-preferences.ts`
* `apps/portal/src/hooks/use-portal-snapshot.ts`
* `apps/portal/src/styles.css`
* `packages/contracts/src/index.ts`
* `scripts/build-package.mjs`

External evidence:

* [MCP 2026-07-28 transports](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports)
* [MCP 2026-07-28 authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)
* [MCP tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)
* [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
* [`@modelcontextprotocol/node` integration](https://github.com/modelcontextprotocol/typescript-sdk/tree/main/packages/middleware/node)
* [Playwright fixtures](https://playwright.dev/docs/test-fixtures)
* [Playwright web server lifecycle](https://playwright.dev/docs/test-webserver)
