<!-- markdownlint-disable-file -->
---
title: Integration isolation changes
description: Implementation record for repository-local coding-agent homes
ms.date: 2026-08-11
ms.topic: reference
---

## Related plan

`.copilot-tracking/plans/2026-08-11/integration-isolation-plan.instructions.md`

## Summary

Nanasa now isolates provider configuration and generated integration assets
beneath `.nanasa/integrations`, supports shared, member, and custom home policies,
and provides setup, auth, and doctor package commands.

## Added

* `apps/daemon/src/agent-config-home.ts`
* `apps/daemon/src/cli-admin.ts`
* Bundled `dist/cli/admin.js` package entry
* Configuration, provisioner, package CLI, collision, path safety, and sentinel
  home tests

## Modified

* Public configuration contracts and strict YAML normalization
* Runtime provisioner and daemon construction
* Package CLI routing and package build
* Active and template Nanasa configuration
* Repository ignore policy and README

## Removed

* Global Copilot hook writes
* Claude and Pi global credential symlinks
* `.nanasa/agents` as the active generated integration location

## Release summary

Existing pre-alpha generated state is intentionally not migrated. Run
`nanasa setup`, authenticate configured agent types with `nanasa auth`, and
restart Nanasa so new managed runs use repository-local homes.
