<!-- markdownlint-disable-file -->
# Flattened Agent Model Details

## References

- Plan: `.copilot-tracking/plans/2026-08-11/flattened-agent-model-plan.instructions.md`
- Research: `.copilot-tracking/research/2026-08-11/flattened-agent-model-research.md`

## Contract Shape

Configured agents directly own name, integration, role, instructions, and order. Their map key is the stable private projection ID. `memberId` remains the runtime and messaging address.

## Private Projection

Each configured agent becomes one same-ID private launch profile and one same-ID membership row. Internal `AgentProfile`, `GroupMembership`, `AgentRun.agentProfileId`, and SQLite naming remain until a later internal cleanup.

## Mutation Rules

Name-only changes are live-safe. Integration, role, or agent-instruction changes require the active run to stop. Agent create, update, remove, reorder, and run operations are atomic group-agent routes.

## Prompt Rules

Profile and membership source scopes are removed. One agent source follows the selected role source. Duplicate paths remain invalid across every effective configuration layer.
