<!-- markdownlint-disable-file -->
---
title: Terminal MCP final code review
description: Final findings for the terminal-only runtime, MCP, migration, delivery, and package implementation
ms.date: 2026-08-10
ms.topic: reference
---

## Findings

### High: Non-loopback mode exposes unauthenticated control and terminal routes

`apps/daemon/src/index.ts:73-98` permits a non-loopback listener once an MCP operator token is configured, but the token protects only `/mcp`. The REST routes in `apps/daemon/src/server.ts:209-361` have no authentication, and the ttyd routes in `apps/daemon/src/terminal-proxy.ts:76-102` and `apps/daemon/src/terminal-proxy.ts:215-248` enforce same-origin behavior without authenticating clients.

A remote client can read `/api/snapshot`, discover a run's terminal endpoint through `/api/runs/:runId/terminal`, and connect to the writable ttyd WebSocket with a self-supplied matching `Host` and `Origin`. The same client can submit messages, interrupt or stop runs, and rename or delete groups without the operator token. This makes the documented remote MCP configuration an unauthenticated remote control and terminal exposure unless an external proxy independently restricts every non-MCP path.

Use a separate loopback control listener or require authentication for every control, event, portal, and terminal route when binding non-loopback. Add a test that starts the non-loopback configuration and proves unauthenticated snapshot, mutation, terminal discovery, and terminal WebSocket requests are denied.

### Medium: Ordinary stop kills a pane without ownership or generation fencing

`apps/daemon/src/tmux-runtime.ts:142-158` sends `kill-pane` to the persisted pane ID directly. It does not use the exact binding, run ID, and generation checks in `apps/daemon/src/tmux-runtime.ts:446-485`, even though those checks protect paste, interrupt, and migration replacement.

A stale binding after a tmux server reset or pane ID reuse can therefore make direct stop, membership removal, group deletion, or stopping-row reconciliation kill a pane owned by another run or process. Existing tests in `apps/daemon/test/run-runtime-coordinator.test.ts:26-79` verify ordering with mocks but do not exercise a mismatched real pane.

Verify ownership before every destructive pane operation. If the pane is absent or mismatched, treat the persisted run as stopped without killing it. Add a real tmux test that points a stale run binding at another owned pane and proves stop leaves that pane alive.

### Medium: Remote MCP accepts an unencrypted endpoint

`apps/daemon/src/index.ts:82-98` and `apps/daemon/src/server.ts:124-140` require a sufficiently long operator token for non-loopback MCP, but they accept `http://nanasa.example/mcp`. This leaks operator and agent bearer credentials to network interception despite the TLS requirement in `README.md:231-234`. Host and Origin checks do not provide transport confidentiality.

Require `https:` for non-loopback `NANASA_MCP_URL`, with an explicit development-only override if needed. Add rejection coverage for non-loopback HTTP while preserving external HTTPS URLs used through a loopback reverse-proxy listener.

### Medium: Existing HMAC secret paths bypass permission and symlink checks

`apps/daemon/src/mcp-auth.ts:41-64` creates a new secret with mode `0600`, but normal reopen and the `EEXIST` race path call `readFileSync` directly. A symlink or a 32-byte file readable by other users is accepted, and `mkdirSync(..., mode: 0o700)` does not repair permissions on an existing directory.

Exposure or substitution of this key permits forging active generation-scoped agent capabilities. Reject symlinks, validate file ownership and exact `0600` permissions, enforce `0700` on the parent directory, and use a no-follow open where supported. Add wrong-mode, symlink, ownership, and directory-mode tests comparable to `apps/daemon/test/ttyd-manifest.test.ts:145-179`.

### Low: The root lint gate fails after Playwright generates its report

`playwright.config.ts:12` writes bundled JavaScript under `playwright-report/`, while `eslint.config.js:5` does not ignore Playwright report or result directories. After acceptance output exists, `pnpm lint` scans the report bundle and fails with 3,664 errors. `.gitignore` does not affect ESLint flat-config traversal.

Add `playwright-report/**` and `test-results/**` to ESLint ignores so the Phase 7 sequence can run acceptance and lint in either order.

## Validation

* Focused daemon review suite: 6 files and 39 tests passed
* Package build, archive inspection, clean install, and CLI suite: 6 tests passed
* Repository typecheck: passed
* Maintained-source ESLint: passed
* Biome formatting check: 62 files passed
* Production artifact scan: no retired worker, process, adapter, or supervisor identifiers found
* Root `pnpm lint`: failed only on generated `playwright-report/trace/*.js`
* Packaged Playwright suite: blocked before assertions because Chromium could not load `libnspr4.so`; all five cases failed at browser launch

## Residual Risks

Browser acceptance remains unverified in this container. Terminal delivery remains intentionally at least once around process and database failure boundaries, and `consumed` records successful paste plus Enter rather than semantic processing. The migration intentionally replaces active legacy worker generations and does not preserve in-flight semantic sessions.
