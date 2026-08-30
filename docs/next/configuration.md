---
title: Configuration
description: Authoring and validating strict Nanasa configuration version 2
ms.date: 2026-08-30
ms.topic: reference
---

## Authoring contract

`.nanasa/config.yaml` must declare `version: 2`. Older and omitted versions are rejected. The file defines repository intent, integrations, provider state, credential references, model and recovery policy, terminal policy, extensions, roles, groups, and agents.

Writes use revision checks, a temporary file, file synchronization, rename, and directory synchronization. Invalid configuration never becomes mutable runtime state.

## Generated reference

The [configuration JSON Schema](reference/config.schema.json) is generated from the runtime Zod schema. The shipped template is `templates/config.yaml` in the package.

Do not place tokens, private keys, or raw credentials in configuration. Use named broker references or provider-managed login.
