---
title: API, events, terminal, and MCP
description: Versioned control, event, terminal, and least-privilege agent protocols
ms.date: 2026-08-30
ms.topic: reference
---

## Control API

The HTTP control plane uses `/api/v1` only. Operator sessions require Host and Origin policy, an HttpOnly cookie, and CSRF protection for mutations. Route declarations define schemas, body limits, idempotency, errors, and OpenAPI metadata.

See the generated [OpenAPI registry](reference/openapi.json) and [errors and limits](reference/errors-limits.json).

### Idempotency semantics

The `x-idempotency` value in the OpenAPI registry is an exact capability boundary. Routes marked `optional` or `required` reserve the key, execute the SQLite mutation, and store the response in one transaction. They replay successful responses and deterministic client errors. A transient server failure rolls back the mutation and reservation, so a retry executes normally. Keys are scoped by authenticated principal, route, and canonical request digest.

An `in-progress` row that survives from an older implementation is treated as an uncertain outcome. It does not expire into another execution and requires domain-specific reconciliation.

Routes marked `forbidden` reject `Idempotency-Key`. This includes tmux lifecycle, terminal input, Git worktrees, extension and overlay files, checkpoint files, configuration files, and other effects that cannot share the SQLite response transaction. Clients must observe the affected domain before deciding whether to retry. Nanasa does not claim exactly-once or crash-atomic behavior for those routes.

## Events and terminals

Events use a durable cursor with subscribe-before-replay, overlap deduplication, bounded queues, reset frames, heartbeats, slow-consumer closure, and planned restart frames. See the [event protocol](reference/events.json).

Terminals use `nanasa-terminal.v1`, one controller, bounded observers, lease heartbeats, input arbitration, flow control, and reconnect baselines. See the [terminal protocol](reference/terminal.json).

## MCP

MCP exposes least-privilege semantic coordination to exact run-generation principals. It cannot mutate topology, install extensions, approve permissions, or send unrestricted raw keys by default. See the generated [MCP tool registry](reference/mcp-tools.json).
