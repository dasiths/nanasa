<!-- markdownlint-disable-file -->
# Role Settings And Agent Order Research

## Scope

Implement portal-managed role presentation and group-local agent ordering that persists in `.nanasa/config.yaml` and drives the tree, terminal tabs, and terminal grid.

## Evidence

- Role presentation is already validated by `RolePresentationSchema` and preserved atomically by `ConfigRepository`.
- Portal snapshots expose effective membership `roleId`, while the portal loads the complete role catalog.
- `snapshot.memberships` is the shared ordering input for `GroupTree` and `TerminalWorkspace`.
- `ConfigRepository.mutate` serializes updates and atomically rewrites validated YAML.
- Reordering identities must not increment group membership revision or restart active runs.

## Selected Approach

- Add a presentation-only role endpoint that replaces `presentation` as one validated object.
- Add optional dense `order` to configured memberships.
- Reorder through a complete member-ID permutation validated inside the serialized repository mutation.
- Sort only `getSnapshot()` memberships by configured order; leave operational membership queries unchanged.
- Normalize order on add, remove, and reorder, while accepting legacy YAML without `order`.

## Alternatives Rejected

- Browser-local ordering would not persist across users or daemon restarts.
- SQLite ordering would conflict with YAML topology ownership.
- Per-membership PATCH requests could leave partial ordering after failures.
- YAML map insertion order is implicit and fragile across serializers.

## Sources

- `.copilot-tracking/research/subagents/2026-08-11/portal-role-presentation-metadata.md`
- `.copilot-tracking/research/subagents/2026-08-11/agent-ordering-design.md`
- `.github/copilot-instructions.md`
- `AGENTS.md`
