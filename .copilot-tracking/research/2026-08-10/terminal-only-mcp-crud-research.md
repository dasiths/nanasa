<!-- markdownlint-disable-file -->
---
title: Terminal-only runtime, MCP, CRUD, and browser research
description: Consolidated architecture decisions for the terminal-only Nanasa increment
---

## Scope

* Replace model-specific ACP and RPC adapters with direct tmux-owned CLI terminals.
* Preserve durable terminal message delivery, ttyd observation, lifecycle, and recovery.
* Add local stdio MCP tools for DM, multicast, and sender-excluded broadcasts.
* Add group and member rename/delete operations in the daemon and portal.
* Add Playwright acceptance coverage for the resulting product surface.

## Sources

* `.copilot-tracking/research/subagents/2026-08-10/terminal-only-runtime-research.md`
* `.copilot-tracking/research/subagents/2026-08-10/mcp-crud-browser-research.md`
* `AGENTS.md`
* `.github/copilot-instructions.md`

## Selected architecture

Nanasa becomes terminal-only. `TmuxRuntime` launches every configured command directly. `TtydSupervisor` exposes the pane to the portal. A narrowed durable dispatcher performs bracketed paste followed by a separate Enter key and records injection outcomes without semantic completion claims.

The MCP server uses Streamable HTTP at `/mcp` inside the authoritative Fastify daemon. Tool handlers call the same internal message submission service as the portal REST route, without loopback requests or direct SQLite access from another process.

Agent clients use generation-scoped HMAC bearer capabilities bound to the run, member, and group so sender identity cannot be selected by tool arguments. Remote operator clients use an explicitly configured bearer credential. The daemon binds to loopback by default; remote MCP access requires an explicit non-loopback host, authentication, and TLS termination through a trusted reverse proxy.

Portal "agent" rename/delete operates on a group membership alias and membership lifecycle. Reusable profile records remain internal. Group deletion stops all desired or active runs before deleting the group graph. Profiles and append-only domain events remain for reuse and audit.

## Compatibility

The current `.nanasa/state/nanasa.sqlite` remains in place. A transactional `PRAGMA user_version` migration marks active ACP/RPC worker generations for forced replacement by direct CLI panes and normalizes retained compatibility columns. Historical rows and inert worker session directories are preserved.

The config loader accepts retired `adapter`, `capabilities`, and `recovery` keys as legacy input but removes them from canonical responses. New config templates omit them. Legacy message delivery fields are accepted as input and normalized to terminal injection.

## Validation

* Focused contract, config, store migration, terminal delivery, coordinator, CRUD, authenticated HTTP MCP, portal, and package tests
* Full typecheck, tests, lint, formatting, build, package build, ttyd smoke, and diff check
* Playwright production-package acceptance for Start All, terminal messaging, preferences, responsive layout, rename/delete, and daemon restart recovery
* Browser sign-off against safe echo fixtures without real model prompts
