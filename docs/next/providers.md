---
title: Providers
description: Provider adapters, authentication state, reporters, models, and recovery
ms.date: 2026-08-30
ms.topic: how-to
---

## Built-in providers

Nanasa includes closed adapters for GitHub Copilot CLI, Claude Code, Pi, and OpenCode. Generic runtime, status, action, and terminal services depend on provider interfaces rather than provider-kind switches.

## Authentication and state

Run `nanasa auth login <integration>` for provider-managed login. Membership scope is the default provider-state boundary. Named credential references can inject short-lived values without persisting raw credentials.

Nanasa-managed reporter, prompt, MCP, and permission-floor files live in revisioned generated overlays. Provider-owned state remains separate. Health and drift checks never grant arbitrary extension code execution.

## Models and resume

Configuration records desired model policy. Fenced reporter evidence records the effective model and native session. Live tmux adoption outranks cold resume. A resume is successful only after matching process and session-ready evidence.
