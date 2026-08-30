---
title: Nanasa concepts
description: Ownership and identity model for repositories, groups, members, runs, and terminals
ms.date: 2026-08-30
ms.topic: concept
---

## Ownership

One fenced daemon owns repository control-plane mutation. SQLite owns durable domain facts and events. tmux owns agent processes, PTYs, live terminal state, geometry, history, and exit evidence. The portal owns routes, focus, preferences, xterm rendering, and local selection.

## Identities

A repository contains ordered groups. A stable member points to a provider profile and can have many run generations. Every live effect pins the current run, generation, daemon epoch, and relevant reporter or terminal identity.

Message delivery records transport progress. Agent actions record semantic work acceptance and completion. Terminal input never proves semantic completion.

## Authority

Provider reports own semantic status only after reporter, process, source, sequence, session, and generation fencing. Tmux activity and screen text can trigger reconciliation or provide bounded hints, but they do not prove work state.
