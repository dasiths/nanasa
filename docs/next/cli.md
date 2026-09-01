---
title: CLI reference
description: Operator command families, output contract, and local lifecycle commands
ms.date: 2026-09-01
ms.topic: reference
---

## Command contract

Operational commands use the versioned daemon control plane. Local bootstrap and lifecycle commands can run before the daemon is available. Output is compact JSON by default. Exit code 0 means success, 1 means an operational failure, and 2 means invalid command usage.

Command families cover metadata, config, auth, state, trust, extensions, topology, runs, status, messages, actions, waits, terminals, consoles, Git, events, daemon diagnostics, service lifecycle, remote access, and completion.

## Generated command inventory

The [CLI registry](reference/cli.json) is generated from the same declarations used for parsing, completion, and help. Run `nanasa completion bash` to produce shell completion.

Service commands operate on the exact repository-local systemd user unit. Remote commands retain OpenSSH as the authentication authority.

## Portal login

Run `nanasa auth portal` to mint a short-lived, one-use login URL from the
running daemon. The command authenticates with the repository's owner-only
operator credential. In a source checkout, `make portal-auth` rebuilds the
packaged CLI, mints the URL, and opens it through `BROWSER` or `xdg-open`.

`make portal` opens only the base portal URL and therefore requires an existing
browser session. Minting a new URL does not revoke current browser sessions.
