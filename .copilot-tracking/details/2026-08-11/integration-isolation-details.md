<!-- markdownlint-disable-file -->
---
title: Integration isolation implementation details
description: File-level execution notes for repository-local provider homes
ms.date: 2026-08-11
ms.topic: reference
---

## Context

* Plan: `.copilot-tracking/plans/2026-08-11/integration-isolation-plan.instructions.md`
* Research: `.copilot-tracking/research/2026-08-11/integration-isolation-research.md`

## Phase details

### Configuration

Update contracts and daemon YAML parsing together. Keep the policy in loaded
configuration rather than SQLite because runtime provisioning can resolve it by
the immutable profile agent-type key and stable membership ID.

### Provisioning

Add a shared resolver module used by runtime and CLI administration. The
provisioner receives the integrations root and normalized policies. Provider
environment overrides are authoritative over profile environment values.

### CLI administration

Bundle a small CLI administration entry that imports the daemon configuration
and integration resolver. Keep `bin/nanasa.js` responsible for argument routing
and process lifecycle only.

### Validation

Use config tests to validate schema and path safety, provisioner tests to validate
generated files and environments, and package CLI tests to validate installed
behavior. Add a sentinel home that must remain byte-for-byte unchanged.
