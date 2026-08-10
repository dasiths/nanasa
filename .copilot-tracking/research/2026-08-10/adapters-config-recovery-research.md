<!-- markdownlint-disable-file -->
---
title: Adapter, configuration, and recovery research
description: Consolidated design for native Pi and Copilot adapters, repository configuration, recovery, and portal state
author: Nanasa
ms.date: 2026-08-10
ms.topic: concept
---

## Decision Summary

Nanasa will use a repository-local `.nanasa` directory:

```text
.nanasa/
  config.yaml
  state/nanasa.sqlite
  runtime/ttyd/<run-id>.json
```

`config.yaml` defines available agent types and launch commands. SQLite remains
the durable store for profiles, groups, memberships, runs, messages, deliveries,
and events. Runtime manifests are local-only recovery records.

The operator-facing structured delivery modes are reduced to `queue` and
`steer`. Interrupt becomes an explicit privileged run action rather than a
message mode. The portal computes the available modes from the selected
recipients' adapter capabilities and never offers an unsupported choice.

## Agent Types

Each configured type has a stable key, display name, compatibility kind,
adapter, argv launch definition, recovery policy, and declared capabilities.

```yaml
version: 1
agentTypes:
  pi:
    name: Pi
    kind: pi
    adapter: pi-rpc
    command: [pi]
    recovery: resume-or-restart
    capabilities: [queue, steer]
  copilot:
    name: GitHub Copilot
    kind: copilot
    adapter: copilot-cli
    command: [copilot]
    recovery: resume-or-restart
    capabilities: [queue]
  opencode:
    name: OpenCode
    kind: opencode
    adapter: terminal
    command: [opencode]
    recovery: restart
    capabilities: [queue]
  claude-copilot:
    name: Claude Code via Copilot
    kind: claude-code
    adapter: terminal
    command: [make, claude-copilot]
    recovery: restart
    capabilities: [queue]
```

Commands are direct argv arrays. No shell interpolation, YAML tags, aliases, or
merge keys are allowed. Working directories must remain under the repository
root. Environment inheritance is allowlisted.

## Pi RPC

Pi `0.83.0` starts with `pi --mode rpc`. Its protocol is strict LF-delimited
JSONL. Nanasa must not use Node `readline`; framing must preserve Unicode line
separators and partial UTF-8 input.

Mappings:

| Nanasa mode | Pi idle | Pi busy |
| --- | --- | --- |
| queue | `prompt` | `follow_up` |
| steer | `prompt` | `steer` |
| interrupt action | `abort`, settle, `prompt` | `abort`, settle, `prompt` |

Correlated command success marks a delivery consumed. `agent_settled`, not
`agent_end`, is the completion boundary. Persist the Pi session file and session
ID after creation or switch. Recovery resumes the validated session and falls
back to a new generation only when the session is definitively invalid.

## Copilot CLI ACP

Use the installed `copilot --acp --stdio` CLI directly. ACP traffic is bounded
NDJSON carrying JSON-RPC 2.0 messages. Nanasa uses a strict in-repository client
and does not add a separate integration or generic ACP library.

Mappings:

| Nanasa operation | Copilot ACP |
| --- | --- |
| queue | Serialized `session/prompt` request with a text content block |
| steer | Deterministic fallback to queue |
| interrupt action | `session/cancel` notification only while a prompt is active |

Persist the exact ACP session ID and the correlated prompt request ID. The
`session/prompt` response is the completion boundary. A successful `end_turn`
stop reason processes the delivery; cancellation and error stop reasons fail it.
Daemon restart reconnects to the durable worker and replays bounded settlements.
The worker loads the persisted session when the server advertises support and
creates a replacement under resume-or-restart when loading fails.

## Delivery Lifecycle

The dispatcher owns per-run serialization and durable status transitions:

```text
queued -> received -> consumed -> processed
                  \-> retrying -> dead-letter
                  \-> rejected / failed
```

The database is authoritative. Adapters claim eligible deliveries, apply the
requested mode or a deterministic queue fallback, and persist the actual mode.
Exactly-once model cognition is not guaranteed; immutable message IDs and
adapter session history provide at-least-once recovery.

## Recovery

Separate desired state from observed state. Existing live tmux panes are
reattached after daemon restart. Missing panes with desired running state start
a new generation and resume adapter sessions when supported.

ttyd manifests include PID, boot ID, process start ticks, UID, executable path
and inode, argv hash, run ID, generation, binding fingerprint, endpoint key,
loopback port, and creation time. Mismatches are never signaled as owned
processes. Current-daemon children may be terminated normally. Exact orphan
signaling remains gated on a safe Linux identity mechanism.

## Portal

Add group-level Start All, per-member recovery state, and restart-only controls
when resume fails. Persist this versioned browser preference object:

```json
{"version":1,"theme":"dark","terminalLayout":"grid"}
```

Apply theme before React mounts, synchronize cross-tab storage changes, and use
system preference only when no saved setting exists.

## Sources

* [Pi RPC protocol](https://github.com/earendil-works/pi/blob/v0.83.0/packages/coding-agent/docs/rpc.md)
* [Pi RPC types](https://github.com/earendil-works/pi/blob/v0.83.0/packages/coding-agent/src/modes/rpc/rpc-types.ts)
* [Agent Client Protocol](https://agentclientprotocol.com/)