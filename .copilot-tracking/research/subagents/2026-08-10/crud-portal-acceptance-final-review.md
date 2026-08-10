<!-- markdownlint-disable-file -->
---
title: CRUD portal acceptance final review research
description: Evidence gathered for the final terminal-only MCP CRUD implementation review
---

## Research Questions

* Are group and member rename/delete operations correct, idempotent, and retention-safe?
* Does group deletion stop active runs before removing persistent group data?
* Does selected-group state fall back correctly after rename and deletion?
* Are portal CRUD controls accessible and responsive, and is message UX terminal-only?
* Are Playwright fixtures isolated and deterministic across restart and cleanup paths?

## Working Hypothesis

Deletion correctness is controlled by coordinator sequencing, while rename,
profile/event retention, and idempotency are store invariants. Portal selection
fallback and fixture lifecycle tests provide the cheapest discriminating checks.

## Discoveries

* Store rename and delete operations preserve membership revisions on rename,
	retain profiles and domain events, clear stale group-scoped idempotency rows,
	and persist the delete replay after graph removal.
* Coordinator deletion serializes with lifecycle operations, stops active or
	desired-running latest generations before store deletion, aborts on a stop
	failure, and converges on retry.
* `MessageWorkspace` keeps local recipient and result state when its `group` and
	`members` props change. Selected-group fallback or membership removal can
	therefore submit a stale member ID and display outcomes from the previous
	group.
* Inline rename controls remain enabled while the asynchronous PATCH is in
	flight. Repeated submit events use distinct generated idempotency keys and can
	create duplicate update events or allow a late response to overwrite a newer
	edit.
* Inline rename cancellation removes the focused input without restoring focus
	to the rename trigger or tree row.
* The Playwright service is worker-scoped and `resetGroups` deletes groups only.
	Profiles and append-only events intentionally survive group deletion, so all
	tests in the worker share retained state and are order-dependent.
* CRUD acceptance deletes only stopped groups and members. It does not prove
	packaged stop-before-delete behavior for a running pane.
* Restart acceptance waits for `connected` before and after a synchronous
	restart, but never observes `reconnecting`, compares run IDs or generations,
	checks endpoint URL stability, or sends post-restart terminal input.
* Mobile acceptance checks layout and horizontal overflow but never opens the
	destructive dialog or exercises keyboard focus behavior.

## References And Evidence

* `.copilot-tracking/plans/2026-08-10/terminal-only-mcp-crud-plan.instructions.md`
* `apps/daemon/src/run-runtime-coordinator.ts:126-150`
* `apps/daemon/src/store.ts:251-340`
* `apps/daemon/src/store.ts:477-555`
* `apps/daemon/src/store.ts:720-738`
* `apps/daemon/src/store.ts:1299-1337`
* `apps/portal/src/App.tsx:112-123`
* `apps/portal/src/App.tsx:385`
* `apps/portal/src/components/message-workspace.tsx:71-76`
* `apps/portal/src/components/group-tree.tsx:64-100`
* `apps/portal/src/api.ts:91-99`
* `test/acceptance/fixtures/package-fixture.ts:283-329`
* `test/acceptance/crud-workflows.spec.ts:3-47`
* `test/acceptance/restart-recovery.spec.ts:3-47`
* `test/acceptance/preferences-and-responsive.spec.ts:35-63`

Validation evidence:

* Focused daemon store, coordinator, server, and portal API tests passed.
* The portal package test command passed 35 tests across three files.
* `pnpm acceptance` completed the production package build, then all five
	Playwright cases stopped before page creation because Chromium could not load
	`libnspr4.so` in the container.

## Follow-On Questions

* Run the five Playwright cases in an image with Chromium system dependencies
	after addressing the identified fixture and coverage gaps.

## Clarifying Questions

None.