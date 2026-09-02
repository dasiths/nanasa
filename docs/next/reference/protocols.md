# Protocol reference

Integration authors can use the versioned HTTP, event, terminal, and Model
Context Protocol (MCP) contracts after reading the task guides.

## HTTP control API

The control API uses `/api/v1`. Portal operators authenticate with an HttpOnly
cookie and a cross-site request forgery token for mutations. Host and Origin
policy applies before control access. Route declarations define request and
response schemas, body limits, errors, and OpenAPI metadata.

See the generated [OpenAPI registry](openapi.json) and
[errors and limits](errors-limits.json).

### Idempotency

The OpenAPI `x-idempotency` value is a capability boundary. An `optional` or
`required` route reserves the key, applies the database mutation, and stores the
response in one transaction. It replays successful results and deterministic
client errors. A transient server failure rolls back both mutation and
reservation. Keys are scoped by authenticated principal, route, and canonical
request digest.

A surviving `in-progress` row represents an uncertain old outcome. It never
expires into a second execution; reconcile the affected domain first.

Routes marked `forbidden` reject `Idempotency-Key`. These include tmux lifecycle,
terminal input, Git worktrees, extension and overlay files, checkpoints, and
configuration files. Observe the domain before retrying. Nanasa does not claim
exactly-once behavior for these external effects.

## Durable events

Events use a durable cursor, subscribe-before-replay, overlap deduplication,
bounded queues, reset frames, heartbeats, slow-consumer closure, and planned
restart frames. Clients must handle reset by taking a new snapshot. See the
[generated event protocol](events.json).

## Terminal gateway

The `nanasa-terminal.v1` WebSocket protocol provides one controller, bounded
observers, lease heartbeats, input arbitration, flow control, and reconnect
baselines. Every live operation pins a run generation. Closing an attachment
does not close its tmux owner pane. See the
[generated terminal protocol](terminal.json).

## MCP coordination

MCP uses Streamable HTTP at `/mcp` by default. It supports the current
per-request protocol and the legacy initialization handshake through the
official MCP server packages. Agent capabilities are least privilege and bound
to one run generation. Operator calls use a separate bearer token.

The send tools accept `text`, optional `intent`, `contentType`, `conversationId`,
and `replyTo`. Agent direct and multicast calls cannot target the authenticated
caller. Agent group broadcasts exclude the caller. See the
[generated MCP tool registry](mcp-tools.json).

MCP message delivery uses the same guarded terminal path as portal messages.
Tool completion records transport, not provider task completion.
