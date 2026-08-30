---
title: Support policy
description: Supported hosts, browsers, services, remote access, and excluded deployment models
ms.date: 2026-08-30
ms.topic: reference
---

## Supported

Nanasa supports Linux glibc x64 and arm64 hosts on Ubuntu 22.04, Ubuntu 24.04, and Debian 12, with Node.js 22 or 24 and tmux 3.2 or later. Foreground startup and project-local systemd user services are supported. Chromium, Firefox, and WebKit are supported portal engines after their required matrix jobs pass.

## Preview and unsupported

WSL2 is preview. Native macOS and Windows runtime hosts are unsupported. Containers are suitable for disposable validation, not continuity-sensitive production ownership. Public reverse proxies, direct portal exposure, multi-user tenancy, distributed runners, executable plugins, and automatic self-update are unsupported.

Provider authentication and native resume require supported provider versions and operator-owned accounts. Same-user provider processes are not a hostile-code sandbox.
