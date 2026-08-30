---
title: Install Nanasa
description: Supported Linux hosts, prerequisites, package installation, and first startup
ms.date: 2026-08-30
ms.topic: how-to
---

## Support boundary

Nanasa hosts run on Linux glibc x64 or arm64. Supported distributions are Ubuntu 22.04, Ubuntu 24.04, and Debian 12. Node.js 22 and 24, tmux 3.2 or later, Git, and OpenSSH are required. WSL2 is preview. Native macOS and Windows hosts are unsupported.

The portal targets current Chromium, Firefox, and WebKit engines. A browser is a client, not a runtime host.

## Install and initialize

Install the exact prerelease in the repository development dependencies, preserve the package-manager lockfile, and run `nanasa init` from the Git repository. Review the generated `.nanasa/config.yaml` before setup.

Run `nanasa setup`, then `nanasa doctor`. Start interactively with `nanasa start` or install the project-local user service with `nanasa service install`.

## Package contents

The npm package includes the CLI, daemon bundle, portal assets, generated offline help, systemd template, build identity, SPDX SBOM, license, notices, README, and configuration template. It excludes tests, source maps, credentials, provider state, databases, terminal data, and private registry configuration.
