---
title: Continuity and recovery
description: Process, daemon, browser, terminal, and provider recovery guarantees
ms.date: 2026-08-30
ms.topic: concept
---

## Continuity levels

A browser reload reconnects to the daemon and resnapshots durable state. A terminal reconnect receives a bounded tmux-derived baseline. A daemon restart preserves matching tmux-owned agent processes and adopts exact run bindings.

Confirmed pane loss creates a new generation. A validated provider-native session can resume only through the bound adapter and fenced reporter confirmation. Optional terminal checkpoints are owner-only, bounded, expiring, and never replayed into a PTY.

## Planned upgrades

An upgrade stops the Nanasa daemon, preserves tmux-owned processes, stages package and state artifacts, activates the package pointer last, starts the candidate service, and requires readiness. Browsers receive typed restart behavior and resnapshot. Live gateway WebSockets and attachment PTYs are not handed off.

Failed readiness restores the exact previous package pointer and state artifacts before the previous service restarts.
