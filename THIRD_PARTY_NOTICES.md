---
title: Nanasa third-party notices
description: Runtime dependency notices for the Nanasa npm distribution
author: Nanasa
ms.date: 2026-08-30
ms.topic: reference
---

## Runtime dependencies

Nanasa distributes JavaScript packages from the npm ecosystem and builds the
native `node-pty` attachment helper for the installation host. Each dependency
retains its own copyright and license terms. The resolved build and runtime
dependency inventory is recorded in `dist/meta/sbom.spdx.json` inside the npm
package.

The primary runtime components include Fastify, Zod, YAML, ws, the Model Context
Protocol TypeScript SDK, xterm, and node-pty. Review the installed package
metadata and the generated SPDX document before redistribution.

## Host tools

Git, OpenSSH, tmux, Node.js, systemd, browsers, and provider CLIs are host
prerequisites. They are not redistributed in the Nanasa npm tarball.