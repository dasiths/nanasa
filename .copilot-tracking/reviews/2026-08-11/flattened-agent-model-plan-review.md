<!-- markdownlint-disable-file -->
# Flattened Agent Model Review

## Metadata

- Plan: `.copilot-tracking/plans/2026-08-11/flattened-agent-model-plan.instructions.md`
- Review date: 2026-08-11
- Status: Complete

## Request Fulfillment

- Complete: Profiles and memberships are absent from operator YAML and portal workflows.
- Complete: The alpha schema is strict, unversioned, and has no compatibility parser.
- Complete: Instruction composition is built-in, global, group, role, then agent.
- Complete: Integrations, roles, groups, and ordered agents are the only operator topology concepts.
- Complete: Existing agent map keys, member IDs, runtime homes, runs, status, messages, and terminals remain stable through private same-ID projection.

## Placement And Quality

- Public contracts and parser own the flattened configuration boundary.
- The daemon store owns projection into private runtime records.
- The topology service owns atomic YAML-backed agent mutations and active-run restrictions.
- The portal uses direct agent endpoints and does not reconstruct profile or override behavior.
- Internal runtime contract names remain intentionally unchanged; renaming them would add storage migration risk without improving the operator model.

## Validation

- `pnpm lint`: passed.
- `pnpm format:check`: passed.
- `pnpm typecheck`: passed.
- `pnpm test`: 49 contract, 146 daemon, 62 portal, and 9 package tests passed.
- `pnpm build`: passed.
- `git diff --check`: passed.
- Live production validation passed at 390x844 and 1440x900 with no document-level horizontal overflow.
- Live direct agent create, reorder, remove, role presentation, stable terminal identity, and restart recovery passed.

## Residual Risk

- SQLite and runtime snapshots still expose private profile and membership naming to internal code. This is deliberate and not an operator-facing compatibility layer.
- Existing stable agent IDs retain their historical `membership_` prefix; new behavior treats the value only as an opaque agent identifier.