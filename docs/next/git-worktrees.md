---
title: Git and worktrees
description: Repository identity, checkout assignment, and managed worktree safety
ms.date: 2026-08-30
ms.topic: how-to
---

## Repository and checkout identity

Nanasa distinguishes a common Git repository from each checkout. It supports normal, linked, bare, packed-ref, and reftable layouts. Every run snapshots its checkout identity and working directory.

## Managed worktrees

Worktree creation validates branch, base, path, operation generation, and conflicts before invoking Git without a shell. Managed provenance is persisted before deletion authority exists.

Removal requires persisted ownership, no active bound run, a matching `.git` relationship, no conflicting operation, and a final identity check. Dirty removal requires explicit confirmation. Branch deletion remains a separate operation.
