<!-- markdownlint-disable-file -->
---
title: Chat history and persistent agent MCP research
description: Research for the shared message timeline and per-membership MCP client provisioning
ms.date: 2026-08-10
ms.topic: reference
---

## Scope

* Render every persisted group message, including agent-to-agent MCP traffic, as a chronological chat timeline.
* Identify portal senders as Human and agents by their active membership aliases.
* Preserve per-agent configuration under `.nanasa/agents/` across run and daemon restarts.
* Expose Nanasa's authenticated HTTP MCP tools to Copilot, Claude Code, Pi, and OpenCode.

## Evidence

* The daemon snapshot already contains all persisted messages and delivery outcomes for every sender.
* Agent MCP messages use `sender.kind: agent` with a trusted member and run identity; portal messages use `sender.kind: operator`.
* Runtime launch currently injects `NANASA_MCP_URL` and a generation-scoped `NANASA_MCP_TOKEN`, but no CLI receives an MCP client configuration.
* Membership database IDs are generated, stable across reactivation, globally unique, and filesystem-safe. User-controlled member IDs are group-scoped and unsuitable as path components.
* Copilot supports `--additional-mcp-config @file`; Claude supports `--mcp-config file`; both formats expand `${NANASA_MCP_TOKEN}` in HTTP headers.
* Pi has no native MCP client. The official `pi-mcp-adapter` package reads `$PI_CODING_AGENT_DIR/mcp.json`, supports authenticated Streamable HTTP, and recommends `protocolVersion: auto` for MCP SDK v2 servers.
* OpenCode supports `OPENCODE_CONFIG`, remote MCP entries, and `{env:NANASA_MCP_TOKEN}` interpolation.

## Selected approach

* Create `.nanasa/agents/<membership-id>/` with mode `0700` and reject symlink traversal.
* Generate non-secret MCP configuration files with mode `0600`. Keep the bearer capability only in the process environment.
* Preserve each CLI's existing authentication source. Do not replace Copilot or Claude homes, and do not move OpenCode provider data.
* Give Pi a per-membership `PI_CODING_AGENT_DIR` because Pi owns both adapter configuration and session persistence there. Link only its existing `auth.json` when available.
* Add CLI arguments or environment variables in a typed provisioner rather than shell wrappers or tracked repository config.
* Merge local portal submissions with authoritative snapshot messages by message ID, then discard local duplicates when the snapshot catches up.

## CLI configuration

* Copilot: generated `mcp-config.json`, loaded with `--additional-mcp-config @<path>`.
* Claude Code: generated `mcp-config.json`, loaded with `--mcp-config <path>`.
* Pi: generated `<agent-root>/pi/mcp.json`, loaded through the pinned `pi-mcp-adapter` extension and `PI_CODING_AGENT_DIR`.
* OpenCode: generated `opencode.json`, selected with `OPENCODE_CONFIG`.

## Security constraints

* Generated files never contain a bearer token.
* Runtime-owned environment values override profile environment values.
* Agent directories and files must not traverse symlinks and must be owned by the current user.
* Old run tokens remain generation-fenced by the MCP credential issuer.
* `.nanasa/agents/` remains ignored by Git.

## Validation

* Unit-test generated paths, permissions, formats, token placeholders, and command augmentation for every CLI kind.
* Run each installed CLI's MCP listing or config diagnostic against an isolated test endpoint where practical.
* Verify agent-originated messages render in the timeline and portal messages render as Human.
* Verify chronological order, recipient expansion, live delivery status, deduplication, and bottom-scroll behavior in portal and Playwright tests.
