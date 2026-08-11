<!-- markdownlint-disable-file -->
---
title: Declarative topology and bounded messaging changes
description: Alpha implementation record for YAML topology and paginated retained messages
ms.date: 2026-08-11
ms.topic: reference
---

## Related plan

`.copilot-tracking/plans/2026-08-11/declarative-topology-messaging-plan.instructions.md`

## Summary

Nanasa now stores desired profiles, groups, memberships, aliases, and message
retention in `.nanasa/config.yaml`. SQLite projects that topology for runtime
foreign keys and retains transactional run, delivery, message, status, event,
and idempotency state.

## Added

* Atomic serialized config repository with revision checks
* YAML-backed topology service and startup reconciliation
* SQLite schema version 3 message sequence and idempotency expiry fields
* Group message state, cursor page, and clear-history contracts and endpoints
* UTF-8 byte limits and repository-relative oversized-content guidance
* Paged portal cache with latest-20 loading and older-page prepend handling

## Modified

* Topology REST routes now mutate YAML and reconcile SQLite
* Portal snapshots use compact message group summaries
* Message events no longer persist complete message bodies
* Portal clear deletes SQLite messages and deliveries
* Active and template configuration include topology and retention sections
* Runtime and acceptance tests use isolated declarative configurations

## Removed

* Browser-local message body history
* Eager full message and delivery arrays from the portal HTTP snapshot

## Release summary

Restart Nanasa to activate the new config repository and schema migration. The
existing active topology is already represented in `.nanasa/config.yaml`.
