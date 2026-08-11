<!-- markdownlint-disable-file -->
# Flattened Agent Model Changes

## Related Plan

`.copilot-tracking/plans/2026-08-11/flattened-agent-model-plan.instructions.md`

## Implementation Date

2026-08-11

## Summary

Replaced the operator-facing agent type, profile, and membership topology with integrations, roles, groups, and group-owned agents. Runtime profiles and memberships remain private SQLite projection details so existing runs, messages, status, terminals, homes, and member IDs keep their identities.

## Modified

- Configuration contracts, parser, repository, template, and live `.nanasa/config.yaml` now use a strict unversioned flattened schema.
- Daemon topology, REST routes, provisioning, prompt resolution, MCP joins, status joins, and ordering now resolve configured agents directly.
- Portal API and forms now provide one Add Agent flow and one Agent Settings flow with inherited instructions shown read-only.
- Documentation, CLI text, acceptance fixtures, runtime fixtures, and package tests use integration and agent terminology.
- Focused tests cover old-schema rejection, flattened projection, direct CRUD and run routes, prompt layers, ordering, package setup, and recovery.

## Removed

- Root configuration version dispatch and compatibility handling.
- Operator-facing `agentTypes`, `agentProfiles`, and group `memberships`.
- Reusable profile CRUD routes and portal forms.
- Profile default-role and membership role-override behavior.
- Profile and membership prompt source layers.

## Validation

- Static checks, complete repository tests, production build, live API health, browser CRUD/reorder/delete, mobile and desktop layout, terminal grid presentation, and daemon restart recovery all passed.