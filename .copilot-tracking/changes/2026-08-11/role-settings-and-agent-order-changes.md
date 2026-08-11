<!-- markdownlint-disable-file -->
# Role Settings And Agent Order Changes

## Related Plan

`.copilot-tracking/plans/2026-08-11/role-settings-and-agent-order-plan.instructions.md`

## Summary

- Added validated role icon, color, and compact-name settings with a portal editor.
- Added YAML-owned dense membership order and atomic reorder commands.
- Projected one order into the group tree, terminal tabs, and terminal grid.
- Preserved active runs, iframe identity, and group membership revision during reorder.
- Refined terminal role identity, member IDs, and copy controls.

## Added

- `apps/daemon/src/membership-order.ts`
- `apps/daemon/test/membership-order.test.ts`
- `apps/portal/src/components/role-identity.tsx`

## Modified

- `.nanasa/config.yaml`
- `README.md`
- `templates/config.yaml`
- `packages/contracts/src/index.ts`
- `packages/contracts/test/contracts.test.ts`
- `apps/daemon/src/config-repository.ts`
- `apps/daemon/src/server.ts`
- `apps/daemon/src/store.ts`
- `apps/daemon/src/topology-service.ts`
- `apps/daemon/test/config.test.ts`
- `apps/daemon/test/server.test.ts`
- `apps/portal/src/api.ts`
- `apps/portal/src/api.test.ts`
- `apps/portal/src/App.tsx`
- `apps/portal/src/App.test.tsx`
- `apps/portal/src/components/group-tree.tsx`
- `apps/portal/src/components/terminal-workspace.tsx`
- `apps/portal/src/components/terminal-workspace.test.tsx`
- `apps/portal/src/styles.css`

## Validation

- 45 contract tests passed.
- 142 daemon tests passed.
- 62 portal tests passed.
- 9 packed-package tests passed.
- Typecheck, lint, format check, build, and `git diff --check` passed.
- Live browser verified role editing, YAML reorder, restart persistence, responsive layout, and iframe continuity.
