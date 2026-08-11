<!-- markdownlint-disable-file -->
# Flattened Agent Model Research

## Scope

Replace the alpha operator model of agent types, reusable profiles, and memberships with integrations, roles, groups, and group-owned agents. Preserve layered instructions and runtime identity.

## Selected Model

```yaml
instructions: []
integrations: {}
roles: {}
groups:
  group-id:
    name: Team
    instructions: []
    agents:
      agent-id:
        memberId: integration.runtime-name
        name: Agent name
        integrationId: integration-id
        roleId: role-id
        instructions: []
        order: 0
messages:
  retentionPerGroup: 1000
```

The root schema is strict and unversioned. Old `version`, `agentTypes`, `agentProfiles`, and `memberships` keys are rejected.

## Instruction Layers

1. Built-in Nanasa coordination
2. Built-in assignment identity
3. Global instruction files
4. Group instruction files
5. Role instruction files
6. Agent instruction files

Integrations do not own behavioral instructions.

## Runtime Boundary

SQLite profile and membership tables remain private runtime projection details. Every configured group agent projects to a same-ID private launch profile and membership. Existing agent map keys and `memberId` values are retained so provider homes, MCP identity, messages, status, and run recovery remain stable.

## Research Sources

- `.copilot-tracking/research/subagents/2026-08-11/flattened-config-runtime.md`
- `.copilot-tracking/research/subagents/2026-08-11/flattened-portal-model.md`
- `.copilot-tracking/research/subagents/2026-08-11/flattened-prompt-provisioning.md`
- `.github/copilot-instructions.md`
- `AGENTS.md`
