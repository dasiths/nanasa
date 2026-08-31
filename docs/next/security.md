---
title: Security boundaries
description: Loopback authority, credentials, terminal control, extensions, and package integrity
ms.date: 2026-08-31
ms.topic: concept
---

## Network and operator authority

The daemon binds to loopback by default. HTTP and WebSocket operations enforce Host and Origin policy. Bootstrap tokens are one-use URL fragments exchanged for an HttpOnly SameSite session and CSRF token. Remote access remains inside OpenSSH forwarding.

## Runtime authority

Only the controller lease can send terminal input, paste, focus, resize, or
approve effects. Observers are read-only. The daemon consumes OSC 52 reads,
malformed writes, unsupported terminal string controls, and clipboard writes
seen by observers. Valid controller writes remain memory-only until approval or
expiry. Clipboard payloads are not rendered and do not enter terminal history,
ordinary logs, events, or persistence.

## Supply chain and state

Extension packages are data-only and digest locked. Release artifacts carry exact commit metadata and an SPDX SBOM. Backups hash every state artifact before activation. The package excludes credentials, provider state, databases, terminal data, tests, source maps, and private registry settings.

Checkpoint deletion verifies the persisted digest and file identity through an owner-only open descriptor. Nanasa truncates and synchronizes that descriptor before recording the deletion audit. A random quarantine rename is organizational only; no pathname is unlinked or trusted for content destruction. Zero-byte owner-only checkpoint and quarantine tombstones are retained as harmless audit artifacts without automated pathname cleanup. If another same-user process substitutes or moves an entry, Nanasa destroys only the verified open inode and leaves the replacement untouched. Secure physical block overwrite is not promised on modern filesystems.

Agents run under one operating-system user. Use separate users or containers when hostile-agent isolation is required.
