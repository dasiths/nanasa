---
title: Troubleshooting
description: Symptom-based diagnostics for startup, service, terminal, provider, and remote failures
ms.date: 2026-09-01
ms.topic: troubleshooting
---

## Startup fails

Run `nanasa doctor`. Confirm Linux glibc, supported Node.js, tmux, Git, the repository configuration, provider commands, and owner-only state directories. A second daemon cannot acquire repository leadership.

Nanasa distinguishes a live lock owner from a Linux zombie process by reading
the process start identity and state. A verified zombie does not block startup;
the existing owner, inode, link-count, and permission checks still protect lock
replacement. Do not remove `daemon.lock` manually when a live owner exists.

A future or old database is refused. Create and verify a backup, then run
`nanasa reset --from-alpha` to initialize the current schema. Nanasa does not
upgrade databases in place. Do not open a newer database with older code.

If the portal reports that an operator session is required, run
`make portal-auth` from a source checkout or `nanasa auth portal` from an
installed package. `make portal` only reopens an already authenticated session.

## Service is not ready

Run `nanasa service status` and `nanasa service logs`. Confirm a systemd user manager exists and that the repository-local package path still exists. Readiness requires matching repository identity and a ready daemon lifecycle.

## Terminal or remote access fails

A terminal reset can follow generation replacement, lease takeover, slow-consumer closure, or planned restart. Resnapshot before retrying input.

For remote failures, run OpenSSH directly to validate authentication, start the remote project service, and retry the printed loopback tunnel command. Tunnel loss does not imply agent-process loss.

## TUI copy does not update the clipboard

A TUI-owned highlight is different from a portal selection. Use the TUI's copy
command and approve the resulting terminal clipboard request. If the browser
denies access, activate Copy again after granting clipboard permission; the
request remains available until it expires.

Wrapped TUI clipboard requests require tmux 3.3 or later. On tmux 3.2, use
Shift+drag on Linux or Windows, Option+drag on macOS, or copy from the terminal
transcript.
