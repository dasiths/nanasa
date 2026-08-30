---
title: State and models
description: Durable state boundaries, lifecycle status, actions, waits, and model selection
ms.date: 2026-08-30
ms.topic: concept
---

## Durable state

Configuration version 2 stores desired topology and policy. SQLite schema 7 stores stable identities, runs, observations, reporters, status revisions, messages, deliveries, actions, waits, Git identities, extensions, events, audits, and retention metadata.

Credentials, raw terminal streams, browser grids, clipboard content, and unrestricted provider transcripts are not durable control-plane state.

## Semantic status

Canonical states are `starting`, `idle`, `working`, `waiting`, `blocked`, `suspected_stuck`, `stopped`, `failed`, and `unknown`. Status and completion revisions let clients acknowledge exact evidence without confusing a later generation.

## Work models

Messages are durable communication. Deliveries track transport. Actions and attempts pin exact runtime identity. Open waits represent questions, permissions, plan approvals, and elicitation. Only fenced provider acknowledgements can establish accepted, started, completed, failed, or cancelled work.
