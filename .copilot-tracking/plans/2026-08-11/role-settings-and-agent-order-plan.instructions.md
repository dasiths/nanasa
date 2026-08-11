<!-- markdownlint-disable-file -->
# Role Settings And Agent Order Plan

## User Requests

- Manage role icon, color, and compact name from the portal.
- Reorganize agent order in the left panel.
- Reflect agent order in terminal tabs and terminal grid.
- Persist agent order to YAML.

## Context Summary

Follow `.github/copilot-instructions.md`, `AGENTS.md`, and the repository's existing YAML-topology ownership model. Research is recorded in `.copilot-tracking/research/2026-08-11/role-settings-and-agent-order-research.md`.

## Implementation Checklist

### Phase 1: Contracts And Persistence
<!-- parallelizable: false -->
- [x] Add role presentation update contracts.
- [x] Add configured membership order and reorder contracts.
- [x] Normalize dense membership order on topology mutations.
- [x] Expose role presentation and reorder HTTP endpoints.

### Phase 2: Snapshot And Portal API
<!-- parallelizable: false -->
- [x] Sort portal snapshot memberships by configured order.
- [x] Add typed portal API methods.
- [x] Wire App action handlers and refresh behavior.

### Phase 3: Portal UX
<!-- parallelizable: false -->
- [x] Add role presentation settings dialog.
- [x] Add Move up and Move down agent commands.
- [x] Preserve accessible focus and busy states.

### Phase 4: Validation
<!-- parallelizable: false -->
- [x] Add contract, daemon, API, component, and live-browser coverage.
- [x] Verify YAML persistence and restart behavior.
- [x] Verify tree, tabs, and grid use one order.
- [x] Verify live terminal continuity during reorder.

## Success Criteria

- Role presentation edits persist and update all role surfaces.
- Agent reorder is atomic and persists as dense YAML order values.
- Tree, tabs, and grid always use the same order.
- Active agents do not restart and membership revision does not change.
- Existing YAML without order remains valid.
