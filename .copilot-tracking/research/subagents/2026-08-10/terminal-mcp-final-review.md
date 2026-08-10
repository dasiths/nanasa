---
title: Terminal MCP final review research
description: Evidence and findings for the terminal-only runtime and MCP final review
ms.date: 2026-08-10
ms.topic: reference
---

## Research Scope

* Review terminal-only runtime correctness and in-place migration.
* Review tmux ownership and generation fencing.
* Review durable terminal delivery semantics.
* Review MCP Streamable HTTP integration, Host and Origin validation, agent HMAC capabilities, and operator tokens.
* Review remote access assumptions and secret handling.
* Review package output and focused test coverage.
* Ignore retained compatibility columns and parser constants unless they affect active behavior.

## Plan Criteria

* Existing ACP and RPC worker generations are replaced exactly once without losing repository-local records.
* Every configured agent launches directly in an owned tmux pane.
* Every routed message is durable paste plus a separate Enter key, with generation fencing and no semantic completion claim.
* MCP tools use authenticated Streamable HTTP and the authoritative message command service.
* Agent identity is bound to an active run generation, while remote operators use an explicit token.
* Host, Origin, remote exposure, secrets, and published artifacts meet the plan constraints.

## Discoveries

* `TmuxRuntime.recoverRun` checks pane ownership tags before killing a migration-marked legacy worker pane, then marks the old generation failed and creates the replacement generation.
* `DeliveryDispatcher` retains SQLite claims, leases, bounded retries, expiry handling, membership revocation, and a terminal-only consumed outcome after paste plus Enter returns.
* `TmuxRuntime.pasteToRun` verifies run and generation ownership tags, enforces a one MiB limit, uses bracketed paste, and sends Enter as a distinct tmux command.
* `TmuxRuntime.stopRun` currently kills the persisted pane ID without calling the ownership check used by paste, interrupt, and forced migration replacement.
* MCP uses the official server and Node packages, validates Host and Origin before bearer authentication, binds agent identity to the active run generation, excludes the agent sender from group broadcast, and routes tools through `MessageCommandService`.
* A non-loopback `NANASA_HOST` exposes the entire Fastify application. Only `/mcp` authenticates a bearer token; REST mutations, snapshots, terminal endpoint discovery, and ttyd proxy routes remain unauthenticated.
* Non-loopback MCP startup requires an operator token but accepts an `http://` endpoint URL even though documentation requires TLS termination.
* New HMAC secret files use mode `0600`, but an existing secret is read without rejecting symlinks or validating ownership and permissions.
* Package build and clean-install tests pass. The bundle has one daemon entry and contains no ACP/RPC worker, process, adapter, or supervisor implementation identifiers.
* Root lint fails after Playwright output exists because `playwright-report/` is not in ESLint ignores. Maintained-source lint and Biome formatting pass.
* Packaged Playwright acceptance could not launch Chromium because `libnspr4.so` is absent from the environment; all five cases failed before application assertions.

## Findings Under Validation

All candidate findings were resolved into the findings below.

### High: Non-loopback mode exposes unauthenticated control and terminal routes

`apps/daemon/src/index.ts:73-98` permits a non-loopback listener when an MCP operator token is configured, but `apps/daemon/src/server.ts:209-361` applies no authentication to the REST control plane. `apps/daemon/src/terminal-proxy.ts:76-102` and `apps/daemon/src/terminal-proxy.ts:215-248` enforce same-origin browser behavior but do not authenticate clients. A remote client can read the snapshot, discover terminal endpoint URLs, mutate or delete groups, start or stop runs, submit messages, and connect to writable ttyd WebSockets without the MCP token. The operator credential therefore does not make remote daemon exposure authenticated.

### Medium: Ordinary stop kills a pane without ownership or generation fencing

`apps/daemon/src/tmux-runtime.ts:142-158` sends `kill-pane` to the persisted pane ID directly. The exact binding, run ID, and generation checks in `apps/daemon/src/tmux-runtime.ts:446-485` protect paste, interrupt, and migration replacement but not stop. Direct stop, membership removal, group deletion, and stopping-row reconciliation can therefore terminate another pane if the stored binding is stale after a tmux server reset or pane ID reuse. Existing tests verify stop ordering but do not create a mismatched owned pane and prove it survives.

### Medium: Remote MCP accepts an unencrypted endpoint

`apps/daemon/src/index.ts:82-98` and `apps/daemon/src/server.ts:124-140` require only a sufficiently long operator token for a non-loopback endpoint. `http://nanasa.example/mcp` is accepted, exposing operator and agent bearer credentials to network interception despite the TLS requirement documented in `README.md:231-234`. Host and Origin validation do not provide transport confidentiality.

### Medium: Existing HMAC secret paths bypass permission and symlink checks

`apps/daemon/src/mcp-auth.ts:41-64` creates a new secret with mode `0600`, but both normal reopen and the `EEXIST` path call `readFileSync` directly. A symlink or a 32-byte file readable by other users is accepted, and `mkdirSync(..., mode: 0o700)` does not repair an existing directory's permissions. Exposure or substitution of this key permits forging active generation-scoped agent capabilities. No test covers wrong-mode files, symlinks, ownership, or directory permissions, although the ttyd manifest implementation already applies those checks.

### Low: The documented root lint gate fails on Playwright output

`playwright.config.ts:12` always writes an HTML report to `playwright-report/`, while `eslint.config.js:5` ignores only distribution, dependency, and coverage paths. After acceptance output exists, `pnpm lint` scans bundled report JavaScript and fails with thousands of errors. `.gitignore` does not affect ESLint flat-config traversal. The Phase 7 lint gate therefore cannot pass after the prescribed acceptance run.

## Validation

* Focused daemon tests: 6 files, 39 tests passed
* Package build, archive inspection, clean install, and CLI tests: 6 tests passed
* Repository typecheck: passed
* Maintained-source ESLint: passed
* Biome formatting check: 62 files passed
* Root `pnpm lint`: failed on generated `playwright-report/trace/*.js`
* Packaged Playwright acceptance: blocked before assertions by missing `libnspr4.so`
* Production bundle scan: no retired worker, process, adapter, or supervisor identifiers found

## Residual Risks

* Playwright behavior remains unverified in this environment because Chromium could not start.
* Terminal delivery is intentionally at least once around process or database failure boundaries; `consumed` means paste plus Enter completed, not semantic processing.
* Migration intentionally restarts active legacy worker runs and does not preserve in-flight semantic sessions.

## References

* .copilot-tracking/plans/2026-08-10/terminal-only-mcp-crud-plan.instructions.md
* .copilot-tracking/research/2026-08-10/terminal-only-mcp-crud-research.md

## Clarifying Questions

None.
