# Understand state and recovery

People who operate Nanasa can predict what survives a browser reload, daemon
restart, pane loss, or package upgrade.

## Durable and private state

Configuration version 2 records desired repository topology and policy. The
private database records stable identities, runs, observations, status,
messages, deliveries, actions, waits, Git identities, extensions, events,
audits, retention, and replay information.

Provider credentials and sessions stay in private provider homes. Raw terminal
streams, clipboard payloads, browser layouts, and unrestricted provider
transcripts are not durable control-plane state.

## Browser and terminal reconnect

A browser reload reconnects to the daemon and requests a fresh snapshot. A
terminal reconnect receives a bounded baseline from tmux. Closing a browser
terminal removes only its disposable attachment; it does not stop the owner
pane.

Each run allows one controller and up to three observers. A controller takeover,
lease expiry, slow client, or generation change can reset an attachment without
stopping the agent.

## Daemon restart

A planned or unexpected daemon restart leaves matching tmux-owned processes in
place. On startup, Nanasa verifies pane identity, run ID, and generation before
adoption. A failed tmux inspection is not treated as proof that a process is
gone.

The browser resnapshots after reconnect. Existing WebSockets and attachment
pseudo-terminals are not handed from one daemon process to another.

## Pane loss and provider resume

Confirmed pane loss creates a new generation. Nanasa first tries provider-native
resume when the adapter has validated session evidence and the configured policy
allows it. Success requires a matching process and session-ready report. If
resume is unsafe or fails, Nanasa starts a new native session.

Optional terminal checkpoints are owner-only, bounded, and expiring. They are
labeled as previous output and never replayed as input into a new terminal.

## Status and completion

Canonical semantic states describe starting, idle, working, waiting, blocked,
suspected-stuck, stopped, failed, and unknown work. Exact revisions prevent an
acknowledgement for one generation from hiding later evidence. Open waits
represent questions, permissions, elicitation, and plan approval.

A message delivery tracks transport. An action tracks work acceptance and
completion. Only evidence tied to the current run and generation can establish
semantic progress.

## Package upgrade

A service upgrade verifies and stages package and state artifacts, stops only
the daemon, activates the package pointer last, and waits for readiness. Failed
readiness restores the previous package and exact state set. Database schema
changes are not upgraded in place. See [Services](../guides/services.md) and
[Release and rollback](../development/release.md).
