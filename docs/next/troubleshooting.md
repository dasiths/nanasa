---
title: Troubleshooting
description: Symptom-based diagnostics for startup, service, terminal, provider, and remote failures
ms.date: 2026-08-30
ms.topic: troubleshooting
---

## Startup fails

Run `nanasa doctor`. Confirm Linux glibc, supported Node.js, tmux, Git, the repository configuration, provider commands, and owner-only state directories. A second daemon cannot acquire repository leadership.

A future or unsupported old database is refused. Create and verify a backup before reset or migration. Do not open a newer database with older code.

## Service is not ready

Run `nanasa service status` and `nanasa service logs`. Confirm a systemd user manager exists and that the repository-local package path still exists. Readiness requires matching repository identity and a ready daemon lifecycle.

## Terminal or remote access fails

A terminal reset can follow generation replacement, lease takeover, slow-consumer closure, or planned restart. Resnapshot before retrying input.

For remote failures, run OpenSSH directly to validate authentication, start the remote project service, and retry the printed loopback tunnel command. Tunnel loss does not imply agent-process loss.
