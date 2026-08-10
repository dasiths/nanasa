<!-- markdownlint-disable-file -->
---
title: CRUD portal acceptance final review
description: Final review of terminal-only MCP CRUD and browser acceptance implementation
---

## Findings

### P1: Message state survives selected-group fallback and member removal

`MessageWorkspace` initializes `recipientIds` and `result` once and does not
reconcile either value when `group` or `members` changes
(`apps/portal/src/components/message-workspace.tsx:71-76`). `App` reuses the
same component instance for every selected group
(`apps/portal/src/App.tsx:385`), including the fallback selected after deletion
(`apps/portal/src/App.tsx:112-123`). After deleting a selected group or the
selected DM recipient, the composer can submit the old member ID to the new
group and receive `membership_not_active`; it can also show the previous
group's delivery outcomes under the fallback group's heading. Key the workspace
by group ID or reset recipient and result state when the group/member set
changes. Add a test that deletes the selected group or recipient in Message
Mode and then sends to the fallback selection.

### P1: Worker-scoped Playwright state is not isolated between tests

The acceptance service and its repository are worker-scoped
(`test/acceptance/fixtures/package-fixture.ts:300-314`), while per-test reset
deletes groups only (`test/acceptance/fixtures/package-fixture.ts:283-288`).
Group deletion deliberately retains profiles and append-only events, so every
test accumulates profiles and audit history from earlier tests in the same
worker. This makes browser behavior order-dependent and can hide retention or
selection defects. Create the temporary repository per test, or provide a
fresh package-owned database/runtime per test while retaining worker-scoped
build artifacts only.

### P2: Inline rename can submit concurrent non-idempotent updates

The inline rename Save control remains enabled during `onSave`
(`apps/portal/src/components/group-tree.tsx:64-100`), and parent busy state is
not passed into either rename form (`apps/portal/src/components/group-tree.tsx:436-442`,
`apps/portal/src/components/group-tree.tsx:530-536`). Each PATCH invocation
generates a new idempotency key (`apps/portal/src/api.ts:91-99`). Repeated Enter
or Save actions can therefore append duplicate update events, and a slower
earlier request can overwrite a later edit. Track submission state in
`InlineRename`, disable both controls while pending, and reuse one key for a
single logical rename attempt. Cover rapid double submission.

### P2: Browser CRUD never proves stop-before-delete for live runs

The CRUD acceptance case seeds members and immediately removes them or their
group without starting a run (`test/acceptance/crud-workflows.spec.ts:3-47`).
Store and mocked coordinator tests cover their halves, but no packaged route
test proves that deleting a running member/group stops the real ttyd/view/owner
pane before graph deletion and leaves reusable profiles intact. Start the safe
echo members, capture pane IDs, delete one member and then the group, and assert
the panes disappear while profiles and deletion events remain.

### P2: Restart acceptance can pass without observing recovery

The test calls a synchronous `restartDaemon()` and only asserts `connected`
before and after it (`test/acceptance/restart-recovery.spec.ts:13-28`). It does
not observe `reconnecting`, preserve and compare run IDs/generations or endpoint
URLs, or send input after restart (`test/acceptance/restart-recovery.spec.ts:30-47`).
A stale connected indicator plus surviving pane text can satisfy the current
assertions without proving browser reconnection or terminal usability. Split
stop and start in the test, assert the disconnected transition, compare full
run/endpoint identity, and send unique post-restart markers through both
terminals.

### P3: Keyboard focus and mobile destructive UI remain unverified

Escape from inline rename only removes the focused input
(`apps/portal/src/components/group-tree.tsx:80-85`) and does not restore focus
to the rename trigger or tree row. The unit test checks only that the input is
gone (`apps/portal/src/App.test.tsx:203-224`). Mobile acceptance checks rail
geometry and horizontal overflow but never opens a destructive dialog
(`test/acceptance/preferences-and-responsive.spec.ts:35-63`). Restore focus
explicitly after rename cancellation and add keyboard assertions plus mobile
dialog bounds and accessible-name checks.

## Validation

Focused daemon store, coordinator, server, and portal API tests passed. The
portal package suite passed 35 tests. The production package build also passed.

The five Playwright tests could not execute in this container because Chromium
failed before page creation with missing `libnspr4.so`. Browser behavior and
teardown under an actual page failure therefore remain residual risks.