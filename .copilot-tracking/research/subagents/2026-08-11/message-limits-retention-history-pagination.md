---
title: Message limits retention history and pagination research
description: Alpha implementation research for UTF-8 request limits, retention, history deletion, and portal pagination
ms.date: 2026-08-11
ms.topic: concept
---

## Status

Complete.

## Research questions

* How do contracts, Fastify routes, MCP transport routes, and portal APIs currently represent and validate message bodies?
* What byte limits, content-type rules, endpoint schemas, error codes, and oversized guidance fit the current architecture?
* How should file-path guidance account for local versus remote MCP access and repository path security?
* Where should per-group message retention run transactionally, and what should deletion do to deliveries, reply links, domain events, and idempotency records?
* What clear-history endpoint and portal action fit the current REST and snapshot model?
* What cursor semantics support an initial latest-20 load, lazy loading, stable prepend scroll position, live events, and unread state?
* Which unit, integration, portal, and acceptance tests validate the design?

## Findings

### Current contracts and transports

* `packages/contracts/src/index.ts` defines message bodies independently in
  `MessageSchema` and `SubmitMessageCommandSchema`. Both require a nonempty
  JavaScript string but impose no byte limit, Unicode scalar validation, or
  shared guidance. The portal therefore validates a weaker contract than MCP.
* `apps/daemon/src/mcp-server.ts` alone limits `text` to 1,048,576 UTF-8 bytes
  with `Buffer.byteLength`. Its error is only `Message is too large`, and the
  portal REST path bypasses that schema.
* `apps/daemon/src/server.ts` constructs Fastify without a `bodyLimit`, so
  Fastify 5.11.0 applies its implicit 1,048,576-byte request limit. The same
  limit applies to the entire JSON envelope, making a nominal 1 MiB MCP text
  field impossible to submit at its boundary.
* The global error handler recognizes domain and Zod errors only. A Fastify
  parser error such as `FST_ERR_CTP_BODY_TOO_LARGE` reaches the generic branch
  and is currently at risk of becoming a `500 internal_error` instead of a
  helpful `413`.
* Fastify's built-in JSON parser calls `setEncoding("utf8")`. Node replaces
  malformed sequences during this decoding, so checking the resulting string
  cannot prove that the request contained valid UTF-8 bytes.
* The locked MCP packages are `@modelcontextprotocol/server` 2.0.0 and
  `@modelcontextprotocol/node` 2.0.0. The MCP transport requires the
  `application/json` media type but deliberately ignores parameters such as
  `charset`. `toNodeHandler` accepts an optional pre-parsed body, and Nanasa
  passes Fastify's `request.body`; raw parsing and byte limits therefore belong
  to Fastify in this composition.
* Standard MCP clients in the installed SDK send an `application/json`
  `Content-Type` without a charset. Requiring a literal charset parameter
  would reject conforming clients and Nanasa-managed agents. Omitted charset
  should mean UTF-8, an explicitly declared non-UTF-8 charset should fail, and
  the portal should send `application/json; charset=utf-8`.

### Current persistence behavior

* `apps/daemon/src/store.ts` stores messages, deliveries, domain events, and
  idempotency records in SQLite with foreign keys enabled. Message references
  (`reply_to`, `root_id`, and `causation_id`) are self-referential foreign keys.
* `submitMessage` executes message insertion, delivery insertion, the
  `message.submitted` event, and the optional idempotency response in one
  `BEGIN IMMEDIATE` transaction. Event listeners are notified only after the
  commit. Retention belongs inside this transaction.
* `group_seq` is currently `MAX(group_seq) + 1`. It stays monotonic while only
  old rows are pruned, but deleting all messages resets it to 1. A durable
  per-group high-water mark is required for pagination and unread state.
* `message.submitted` event payloads and message-submit idempotency responses
  duplicate the complete message body. Deleting only `messages` and
  `deliveries` would leave large or cleared content in SQLite.
* Group deletion already deletes deliveries before messages, nulls cross-group
  message references, removes group-scoped idempotency rows, and preserves
  domain-event rows. Its tests establish event-row preservation as the current
  audit model.
* A delivery claim is committed before asynchronous terminal injection. A
  concurrent deletion can make completion report a lost claim after text has
  already been injected. Clear or retention should not delete a victim with an
  unexpired `received` or `delivering` lease.

### Current portal behavior

* `PortalSnapshotSchema` contains every message and every delivery outcome.
  `GET /api/snapshot` reads both tables without a group or limit.
* The portal reloads the full snapshot when the event socket opens and after
  every domain event. The message overlay merges those records with a
  browser-local cache of the most recent 100 portal submissions.
* Clear history is browser-only. It removes the local cache and records a
  per-group sequence marker while authoritative SQLite rows remain.
* Both `App.tsx` and `message-workspace.tsx` infer unread counts by subtracting
  a seen sequence from the largest loaded `groupSeq`. This assumes a complete,
  gap-free message array and cannot survive retention, clear, or pagination.
* The overlay already tracks whether the viewport is near the bottom and shows
  a `New messages` control when a live message arrives while the user reads
  older content. It does not lazy-load older pages or compensate `scrollTop`
  after prepending.
* Snapshot messages and deliveries also support group-delete message counts,
  active-delivery suspension, and failed-recipient highlighting in the group
  tree. A paged design needs compact server summaries for those uses.

### File-path guidance constraints

* Nanasa-managed agent MCP callers run on the daemon host and use a working
  directory validated beneath the repository root. A repository-relative path
  can therefore be useful across local agents.
* A remote MCP operator's local filesystem is not shared with the daemon or
  agents. Guidance must not imply that a client-side temporary path is usable.
* `/tmp`, absolute paths, and paths outside the repository are unsuitable as a
  general recommendation. They may be in another host or namespace and can
  expose unrelated files.
* Alpha guidance should remain advisory text. Nanasa should not automatically
  open a path supplied in a message. Any later file-reading feature must reject
  NULs, absolute paths, `..` traversal, and symlink escapes after `realpath`,
  using the repository root as the authorization boundary.

## Proposed alpha design

### Shared message and request limits

Export these constants from the contracts package so daemon, portal, and tests
cannot drift:

* `MAX_MESSAGE_TEXT_BYTES = 1_048_576` (1 MiB), preserving the current MCP
  product limit
* `MAX_MESSAGE_REQUEST_BYTES = 6_356_992` (6 MiB plus 64 KiB), allowing the
  worst-case six-byte JSON escape for every one-byte control character plus
  routing and JSON-RPC framing
* `DEFAULT_MESSAGE_PAGE_SIZE = 20`
* `MAX_MESSAGE_PAGE_SIZE = 100`

Create one strict `MessageBodySchema` and reuse it in stored messages and submit
commands. Its canonical shape is:

```json
{
  "contentType": "text/plain | text/markdown",
  "charset": "utf-8",
  "text": "nonempty well-formed Unicode"
}
```

The schema must reject unpaired UTF-16 surrogates and calculate bytes with
`TextEncoder`, which works in Node and the browser. Exactly 1,048,576 UTF-8
bytes succeeds; the next byte fails. MCP tool input can retain a plain nonempty
string and defer byte validation to `SubmitMessageCommandSchema` inside the
tool callback so Nanasa can return a purposeful tool error instead of an opaque
pre-callback invalid-parameters response.

Configure Fastify with an explicit 1 MiB default for ordinary command routes
and set `bodyLimit: MAX_MESSAGE_REQUEST_BYTES` only on the message REST route
and MCP POST route. Replace the default JSON parser with a buffer parser that:

1. Accepts the `application/json` media type.
2. Accepts an omitted charset for standard MCP compatibility.
3. Accepts a declared `utf-8` or `utf8` charset, case-insensitively.
4. Rejects every other declared charset with `415 unsupported_charset`.
5. Decodes with `new TextDecoder("utf-8", { fatal: true })`.
6. Passes valid text to Fastify's default secure JSON parser.

The portal's `commandInit` should always send an `application/json; charset=utf-8`
`Content-Type`. MCP clients that send only `application/json` continue to work.
Fastify remains the single raw-body owner before the pre-parsed object is passed
to `toNodeHandler`.

Use these REST failures:

* `400 invalid_utf8`: `Request body must be valid UTF-8 JSON.`
* `400 invalid_json`: `Request body must contain valid JSON.`
* `413 message_body_too_large`: state the 1,048,576-byte UTF-8 limit and file
  recommendation
* `413 request_too_large`: state both the 6,356,992-byte request limit and the
  1,048,576-byte message limit
* `415 unsupported_charset`: state that JSON requests must use UTF-8 and callers
  must omit charset or use `charset=utf-8`
* `415 unsupported_media_type`: `Content-Type must be application/json.`

For MCP parser failures, return the same HTTP status with the MCP JSON-RPC error
envelope (`code: -32000`, `id: null`) instead of the REST error envelope. A
tool-level oversized message remains HTTP 200 with `isError: true`, following
MCP tool-result conventions.

### Oversized-content guidance

Use one base recommendation in REST and portal errors:

> Save large content in a temporary or durable file inside the repository
> checkout shared by the recipients, then send its repository-relative path.
> Do not send an absolute path or a path from outside the repository.

Add caller-aware MCP detail:

* For an authenticated Nanasa agent, explain that a temporary ignored file or
  durable repository file is visible to peer agents when it is beneath the
  shared repository. Do not recommend `/tmp`.
* For an operator on a non-loopback advertised MCP endpoint, state that a path
  on the operator's client machine is not visible to Nanasa agents. The content
  must first reach the daemon's shared checkout through a repository operation
  or another approved out-of-band transfer.
* Do not claim Nanasa uploads, reads, validates, or deletes the file. Alpha only
  sends path text. Recipient agents must treat it as untrusted input.

The portal should show the UTF-8 byte count near the composer limit, disable
submission above the limit, and show the same recommendation. Count bytes, not
characters, so multibyte text behaves consistently with the server.

### Configuration and migration

Extend version 1 configuration with a strict defaulted object:

```yaml
messages:
  retentionPerGroup: 1000
```

Accept integers from 1 through 100,000. Defaulting preserves existing config
files and small values enable focused tests. Add the field to both raw and
canonical config schemas and to `templates/config.yaml`.

Raise the SQLite schema version from 2 to 3. In one migration transaction:

* Add `groups.message_sequence INTEGER NOT NULL DEFAULT 0`.
* Initialize each group to its current `MAX(messages.group_seq)`.
* Add nullable `idempotency_keys.invalidated_at`.
* Rewrite historical `message.submitted` event payloads to minimal metadata so
  old message bodies do not bypass retention.
* Set `PRAGMA user_version = 3`.

New `message.submitted` events should persist only `groupId`, `groupSeq`, and a
compact group message state. The aggregate ID remains the message ID. Delivery
status events should add `groupId` and a canonical `deliveryOutcome`, allowing
the portal to patch visible delivery state without retaining message content in
the event log.

### Retention transaction

Replace `MAX(group_seq) + 1` with an atomic increment of
`groups.message_sequence` inside the existing submit transaction. A submitted
sequence is never reused, including after clear history.

After inserting the new message and deliveries but before building the result
and event, identify every row beyond the newest `retentionPerGroup` messages by
`group_seq`. If a victim has an unexpired lease in `received` or `delivering`,
roll back submission with `409 message_retention_busy` and ask the caller to
retry. This avoids deleting an active terminal injection while preserving an
exact physical cap after successful commits.

For the victim set, in the same transaction:

1. Set `reply_to`, `root_id`, and `causation_id` to `NULL` on every surviving
   message that references a victim, including cross-group messages.
2. Invalidate related message-submit idempotency rows by replacing
   `response_json` with `null` and setting `invalidated_at`.
3. Delete victim deliveries.
4. Delete victim messages.
5. Rehydrate the newly inserted message before returning it, because one of
   its links may have been nulled when its target was evicted.

When `#executeIdempotent` encounters an invalidated key, return
`410 idempotency_result_expired` rather than creating a duplicate message or
returning deleted content. Preserve minimal domain-event rows as audit facts.
Do not emit one extra event per automatically pruned message; include the new
compact group state in `message.submitted`.

### Message list and snapshot contracts

Remove full `messages` and `deliveryOutcomes` arrays from `PortalSnapshotSchema`.
Add `messageGroups`, one entry per group:

```json
{
  "groupId": "grp_...",
  "latestGroupSeq": 42,
  "oldestRetainedGroupSeq": 13,
  "retainedMessageCount": 30,
  "activeDeliveryCount": 1,
  "failedRecipientMemberIds": ["member-id"]
}
```

Omit `oldestRetainedGroupSeq` when no messages remain. The active count covers
`queued`, `received`, `delivering`, and `retrying` deliveries. Failed recipient
IDs cover retained `failed`, `dead-letter`, and `rejected` outcomes, preserving
the current group-tree signal without loading all deliveries.

Add this endpoint:

```text
GET /api/groups/:groupId/messages?limit=20&before=<groupSeq>
GET /api/groups/:groupId/messages?limit=20&after=<groupSeq>
```

`before` and `after` are mutually exclusive decimal positive integers and are
exclusive cursors. Omitting both returns the latest page. Invalid cursors or a
limit outside 1 through 100 return `400 invalid_message_cursor` or
`400 invalid_message_limit`. A missing group returns `404 group_not_found`.

The response contains `groupId`, ascending `messages`, delivery outcomes only
for those messages, the current group message state, and:

```json
{
  "pageInfo": {
    "hasOlder": true,
    "hasNewer": false,
    "nextBefore": 23,
    "nextAfter": null
  }
}
```

Query the latest or older direction in descending order with `limit + 1`, then
reverse the selected rows for display. Query the newer direction ascending.
`nextBefore` is the first returned sequence when older rows exist;
`nextAfter` is the last returned sequence when newer rows exist. Gaps are valid
because retention and clear never reuse the high-water mark. Concurrent inserts
do not perturb an exclusive `before` page, and `after` lets live clients catch
up without storing message content in events.

Keep `GET /api/messages/:messageId/deliveries` for focused diagnostics, but
return `404 message_not_found` after retention or clear instead of an ambiguous
empty array.

### Clear-history command

Add an idempotent endpoint and contract:

```text
DELETE /api/groups/:groupId/messages
```

Return HTTP 200 with `groupId`, `deletedMessages`, `deletedDeliveries`, and the
empty group message state. Do not reset `latestGroupSeq`.

Run clear inside `#executeIdempotent` with scope
`group.<groupId>.messages.clear`. Reject with `409 message_history_busy` if any
target delivery has an unexpired `received` or `delivering` lease. Otherwise:

1. Null all surviving cross-group reply, root, and causation references.
2. Invalidate all message-submit idempotency rows for the group, removing their
   duplicated content while retaining replay tombstones.
3. Delete group deliveries, then group messages.
4. Append and publish `message.history-cleared` with counts and the high-water
   mark.

The clear operation's own idempotency row is written after these steps and
remains replayable. Group deletion later removes it with the existing group
scope cleanup. Domain-event rows remain, but migration and future minimal
payloads ensure they no longer retain message bodies.

Update the portal confirmation to state that the action deletes stored messages
and delivery history for the selected group for every portal user. On `409`,
keep the dialog open and explain that an active delivery must finish before
retrying.

### Portal loading, scrolling, live events, and unread state

Create a per-group message hook instead of merging snapshot data with browser
history. On initial selected-group resolution, load the latest 20 even when the
overlay is closed. Cache pages by group, ignore or abort stale requests after a
group switch, merge by message ID, and sort by `groupSeq`.

Remove `nanasa.message-history.v1` and
`nanasa.message-history-cleared.v1` after a one-time cleanup. Keep the overlay
open preference. Optimistically merge a successful REST submission into the
authoritative page cache, then deduplicate the event-driven refresh.

For scrolling:

* After the first page or a group change, use a layout effect to set
  `scrollTop = scrollHeight`, making the newest message the default view.
* Trigger one older-page request when a top sentinel becomes visible or the
  user scrolls within a small threshold of the top.
* Before prepending, record `scrollHeight` and `scrollTop`. In a layout effect
  after render, set `scrollTop` to
  `newScrollHeight - oldScrollHeight + oldScrollTop`.
* Keep stable message keys and a per-group loading guard. Stop observing when
  `hasOlder` is false.

Change `useDomainEvents` to deliver parsed events, not only a void callback.
The lightweight global snapshot may still refresh after events. For a
`message.submitted` event, fetch `after=<largest loaded groupSeq>` for the
selected group (or the latest page when none is loaded) and loop while
`hasNewer`. Patch canonical `deliveryOutcome` data on delivery events. Clear the
group cache immediately on `message.history-cleared`.

Persist a browser-local map of seen high-water marks under a new versioned key.
Unread count is:

```text
retainedMessageCount == 0
  ? 0
  : latestGroupSeq - max(seenGroupSeq, oldestRetainedGroupSeq - 1)
```

Retention produces a contiguous retained suffix, so this formula does not
count deleted gaps. Mark through `latestGroupSeq` only when the selected
group's overlay is open and its viewport is at the bottom. A selected group
with a closed overlay remains unread. When live messages arrive while the user
is above the bottom, preserve the viewport, increment unread, and show the
existing `New messages` control. Activating it scrolls to the bottom and marks
the group seen. A clear event sets seen to the preserved high-water mark and
removes phantom unread counts.

## Validation plan

### Contracts and configuration

* Verify exact acceptance at 1,048,576 ASCII bytes and rejection at the next
  byte.
* Verify multibyte UTF-8 accounting, nonempty text, unpaired-surrogate
  rejection, and canonical `charset: utf-8`.
* Verify message page, page-info, group-state, and clear-result schemas.
* Verify default retention 1,000, configured small values, bounds, strict
  unknown-key rejection, and template parsing.

### Fastify REST and MCP

* Inject valid JSON as raw buffers with no charset and with explicit UTF-8;
  verify both succeed.
* Inject malformed UTF-8 and a declared non-UTF-8 charset; verify stable 400 and
  415 errors before state changes.
* Test field-sized versus request-sized failures separately, including the
  exact HTTP status, code, byte values, and repository-path guidance.
* Verify ordinary REST routes retain the explicit 1 MiB transport cap.
* Verify MCP parser failures use JSON-RPC envelopes and standard MCP requests
  without a charset remain compatible.
* Verify agent and external-operator tool errors receive appropriate local or
  remote file-path guidance.

### SQLite store

* Migrate a version 2 database and verify group high-water marks, event payload
  redaction, idempotency invalidation support, and schema version 3.
* Submit past a retention value of 2 and verify exactly two newest messages and
  their deliveries remain per group while another group's rows are untouched.
* Verify sequence monotonicity across retention, clear, restart, and the first
  post-clear submission.
* Verify retained messages that reference victims are nulled across all three
  link columns and across groups.
* Verify a pruned or cleared idempotency key returns 410 and never creates a
  duplicate.
* Verify minimal domain events remain queryable without body text.
* Verify active unexpired claims roll back retention or clear, and expired or
  completed claims permit deletion.
* Verify clear counts, delivery-first deletion, preserved event rows, empty
  retained state, and replay of the clear command itself.
* Verify latest, before, and after queries at boundaries, with concurrent new
  inserts, retained gaps, empty history, and a missing group.

### Portal unit and component tests

* Verify API URL encoding, exclusive cursor query strings, clear DELETE, UTF-8
  request header, response validation, and structured error propagation.
* Verify the initial request asks for 20 and renders only the latest page in
  ascending order.
* Mock scroll dimensions to verify initial bottom placement and exact viewport
  compensation after prepend.
* Verify only one lazy request is active and loading stops at `hasOlder: false`.
* Verify live append at bottom auto-scrolls and marks seen; live append while
  closed, unselected, or scrolled up preserves unread state and the jump
  control.
* Verify delivery events patch visible outcomes and reconnect catch-up uses the
  `after` cursor without duplicates.
* Verify clear cancel, success, active-delivery error, cross-tab clear event,
  cache reset, and seen high-water behavior.
* Verify UTF-8 byte counting and oversized portal guidance with ASCII and
  multibyte text.

### Acceptance tests

* Seed more than 20 messages, load the portal, assert the latest 20 and bottom
  position, then scroll to load older content while preserving the top visible
  message.
* Send MCP messages while the overlay is at bottom and while it is reading
  older history; verify auto-scroll versus unread/jump behavior.
* Switch groups and close the overlay to verify group-tree and launcher unread
  badges, then reopen and reach bottom to clear them.
* Clear history, reload, and query the paged endpoint to prove SQLite-backed
  history and delivery outcomes are gone for all browser sessions.
* Submit after clear and verify the new sequence exceeds the old high-water
  mark.

No package-manager commands or tests were run during this research-only task.

## References and evidence

* `AGENTS.md`
* `packages/contracts/src/index.ts`
* `packages/contracts/test/contracts.test.ts`
* `apps/daemon/src/config.ts`
* `apps/daemon/src/server.ts`
* `apps/daemon/src/mcp-server.ts`
* `apps/daemon/src/message-command-service.ts`
* `apps/daemon/src/store.ts`
* `apps/daemon/src/agent-runtime-provisioner.ts`
* `apps/daemon/src/tmux-runtime.ts`
* `apps/daemon/src/terminal-delivery.ts`
* `apps/daemon/test/config.test.ts`
* `apps/daemon/test/mcp-server.test.ts`
* `apps/daemon/test/server.test.ts`
* `apps/daemon/test/store.test.ts`
* `apps/daemon/test/delivery-dispatcher.test.ts`
* `apps/portal/src/api.ts`
* `apps/portal/src/App.tsx`
* `apps/portal/src/components/group-tree.tsx`
* `apps/portal/src/components/message-workspace.tsx`
* `apps/portal/src/hooks/use-portal-snapshot.ts`
* `apps/portal/src/api.test.ts`
* `apps/portal/src/App.test.tsx`
* `test/acceptance/start-and-messaging.spec.ts`
* `apps/daemon/node_modules/@modelcontextprotocol/node/README.md`
* `apps/daemon/node_modules/@modelcontextprotocol/node/dist/index.d.mts`
* `apps/daemon/node_modules/@modelcontextprotocol/node/dist/index.mjs`
* `apps/daemon/node_modules/@modelcontextprotocol/server/dist/index.mjs`
* `node_modules/.pnpm/fastify@5.11.0/node_modules/fastify/docs/Reference/ContentTypeParser.md`
* `node_modules/.pnpm/fastify@5.11.0/node_modules/fastify/docs/Reference/Server.md`
* `node_modules/.pnpm/fastify@5.11.0/node_modules/fastify/lib/content-type-parser.js`

## Follow-on questions

* A later secure file-sharing feature could create managed, expiring repository
  files and return opaque references. It should be designed separately from
  alpha message transport because it requires upload authorization, quotas,
  cleanup, and recipient access policy.
* Event-log retention may eventually need its own count or time policy. The
  alpha design minimizes message event payloads but intentionally preserves
  event rows.

## Clarifying questions

None. The requested alpha behavior can be implemented with the decisions above.
