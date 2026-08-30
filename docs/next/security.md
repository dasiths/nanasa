---
title: Security boundaries
description: Loopback authority, credentials, terminal control, extensions, and package integrity
ms.date: 2026-08-30
ms.topic: concept
---

## Network and operator authority

The daemon binds to loopback by default. HTTP and WebSocket operations enforce Host and Origin policy. Bootstrap tokens are one-use URL fragments exchanged for an HttpOnly SameSite session and CSRF token. Remote access remains inside OpenSSH forwarding.

## Runtime authority

Only the controller lease can send terminal input, paste, focus, resize, or approved effects. Observers are read-only. OSC 52 reads are rejected. Clipboard payloads, raw terminal output, and provider transcripts do not enter ordinary logs or events.

## Supply chain and state

Extension packages are data-only and digest locked. Release artifacts carry exact commit metadata and an SPDX SBOM. Backups hash every state artifact before activation. The package excludes credentials, provider state, databases, terminal data, tests, source maps, and private registry settings.

Agents run under one operating-system user. Use separate users or containers when hostile-agent isolation is required.
