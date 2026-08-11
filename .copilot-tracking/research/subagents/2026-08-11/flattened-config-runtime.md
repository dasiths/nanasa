---
title: Flattened configuration runtime research
description: Direct alpha refactor from agent types and profiles to integrations and roles
ms.date: 2026-08-11
ms.topic: concept
---

## Status

Complete.

## Research questions

* What concrete schema should replace `agentTypes`, `agentProfiles`, and
  `groups.memberships` with `integrations`, `roles`, and `groups.agents`?
* How should stable integration, role, agent, and member identifiers work?
* How can existing SQLite and runtime internals be retained with minimal risk?
* Which symbols and files require changes?
* How should the current `.nanasa/config.yaml` migrate?
* Which tests are affected?

## Current architecture

The YAML model has three execution and placement layers:

* `agentTypes[key]` owns executable integration settings.
* `agentProfiles[profileId]` owns a reusable name, agent type reference,
  default role, and profile instructions.
* `groups[groupId].memberships[membershipId]` owns the group-scoped member ID,
  alias, optional role override, membership instructions, and order.

`NanasaStore.reconcileTopology` projects those layers into existing SQLite
`agent_profiles` and `memberships` tables. A membership row has both a globally
unique primary key and a group-scoped `member_id`. Runs and messages use
`(group_id, member_id)` as the operational address, while runtime provisioning
uses the membership primary key for persistent per-agent directories.

`resolveEffectiveAgentPrompt` currently orders instruction sources as built-in,
global, group, role, profile, and membership. The requested model can combine
the final two configured sources into one agent source without changing the
effective precedence.

## Proposed schema

Use a strict, unversioned root schema. Removing the root `version` literal is
preferable for this alpha because no parser dispatch, compatibility path, or
migration support is required. Version fields for status events and generated
runtime manifests are unrelated and should remain.

```yaml
instructions:
  - .nanasa/instructions/team.md
integrations:
  copilot:
    name: GitHub Copilot
    kind: copilot
    command: [copilot]
    cwd: .
    agentConfigHome: { scope: integration }
roles:
  implementor:
    name: Implementor
    instructions:
      - .nanasa/instructions/implementor.md
    permissionPolicy: inherit
groups:
  grp_example:
    name: Agent Team
    instructions:
      - .nanasa/instructions/groups/agent-team.md
    agents:
      agent_example:
        memberId: copilot.example-name
        name: GitHub Copilot
        integrationId: copilot
        roleId: implementor
        instructions: []
        order: 0
messages:
  retentionPerGroup: 1000
```

The canonical types should be:

* `IntegrationId` is the stable map key for an integration. It uses the current
  lowercase kebab-case key constraint.
* `RoleId` remains the stable global role map key and keeps the current
  lowercase kebab-case constraint. Agents reference it through `roleId`.
* `ConfiguredAgentId` is the stable `groups.agents` map key. It must be globally
  unique across all groups and path-safe because runtime state uses it in a
  directory path. A maximum of 128 characters and
  `^[a-z0-9]+(?:[._-][a-z0-9]+)*$` accepts existing IDs while excluding path
  separators and traversal.
* `memberId` remains explicit, stable, and unique within its group. It is the
  messaging, run, MCP, and human-visible recipient identity. Creation may
  generate `${integrationId}.${dockerName}`, but reconciliation must never
  recompute it after creation.
* `ConfiguredAgent` contains `memberId`, `name`, `integrationId`, optional
  `roleId`, defaulted `instructions`, and optional `order`.
* `ConfiguredGroup` contains `name`, defaulted `instructions`, and defaulted
  `agents`.
* `IntegrationConfig` contains the current executable agent type fields. Its
  canonical `id` must equal its map key.

The strict cross-reference validation must reject unknown integration and role
references, duplicate agent IDs across groups, and duplicate member IDs within
a group. Keep the role optional so an unassigned agent remains representable.

Rename agent configuration home terminology in the same breaking change:

* `scope: agent-type` becomes `scope: integration`.
* `scope: member` becomes `scope: agent`.
* Custom placeholders become `{integrationId}` and `{agentId}`.

The configured prompt order becomes built-in, global, group, role, and agent.
The built-in coordination and assignment sections remain first. Profile and
membership instruction arrays are concatenated, in that order, into the new
agent instruction array during the one-time YAML migration.

## Runtime and persistence strategy

Keep the SQLite schema, runtime contracts, and run coordinator unchanged for
the alpha. Treat the flattened config as a source model and project every
configured agent into the existing runtime model:

1. For each `groups[groupId].agents[agentId]`, resolve
   `integrations[agent.integrationId]`.
2. Upsert `agent_profiles` with `id = agentId`, `name = agent.name`, and
   executable fields copied from the integration.
3. Upsert `memberships` with `id = agentId`, `agent_profile_id = agentId`,
   `member_id = agent.memberId`, `alias = agent.name`, and the explicit role.
4. Keep runs, deliveries, messages, status, terminal sessions, and coordinator
   calls addressed by `groupId` plus `memberId`.

This projection deliberately retains `AgentProfile`, `GroupMembership`,
`AgentRun.agentProfileId`, the `agent_profiles` and `memberships` table names,
and `RunRuntimeCoordinator` member-oriented methods. Renaming those internals
would add database and recovery risk without improving the requested YAML.

For the current repository, reuse each old membership map key as the new agent
map key. The existing membership row and per-agent runtime path then remain
stable. Reconciliation creates a same-ID internal profile projection and
updates that membership's profile foreign key. Old profile rows can remain for
historical runs. Snapshot profile queries should expose profiles referenced by
active memberships, rather than every orphaned historical profile.

No database schema migration or `DATABASE_SCHEMA_VERSION` increment is needed.
The current `UNIQUE (group_id, member_id)` and run foreign key constraints stay
valid. New agent creation should generate `agent_<uuid>` or the existing
idempotent 32-hex equivalent, but the parser must continue to accept the opaque
preexisting membership IDs used by the one-time YAML migration.

The REST boundary should use configured agent IDs for resource mutation and
member IDs for operational messaging:

* `POST /api/groups/:groupId/agents` creates one configured agent directly.
* `PATCH /api/groups/:groupId/agents/:agentId` updates its name, role, or agent
  instructions. Integration and member IDs remain immutable after creation.
* `DELETE /api/groups/:groupId/agents/:agentId` resolves the stable member ID,
  stops its run, and removes the configured agent.
* `PUT /api/groups/:groupId/agent-order` accepts a complete `agentIds`
  permutation.
* `POST` and `DELETE /api/groups/:groupId/agents/:agentId/run` resolve the
  configured agent and translate its member ID before calling
  `RunRuntimeCoordinator`.

Remove the separate agent profile create and update endpoints. A reusable
profile concept would contradict the flattened source model.

## Exact change surface

| File | Symbols | Required change |
|------|---------|-----------------|
| `packages/contracts/src/index.ts` | `AgentTypeKeySchema`, `AgentTypeConfigSchema`, `ConfiguredAgentProfileSchema`, `ConfiguredMembershipSchema`, `ConfiguredGroupSchema`, `NanasaConfigSchema` | Replace config-facing agent type and profile schemas with `IntegrationIdSchema`, `IntegrationConfigSchema`, `ConfiguredAgentIdSchema`, and `ConfiguredAgentSchema`; change groups to `agents`; remove the root config version; enforce integration, role, global agent ID, and group member ID references. |
| `packages/contracts/src/index.ts` | `CreateAgentProfileCommandSchema`, `UpdateAgentProfileCommandSchema`, `AddGroupMembershipCommandSchema`, `UpdateGroupMembershipCommandSchema`, reorder schemas | Remove profile commands; add `CreateGroupAgentCommandSchema`, `UpdateGroupAgentCommandSchema`, and agent reorder schemas. Keep internal `AgentProfileSchema`, `GroupMembershipSchema`, `AgentRunSchema`, `membershipRevision`, and `DeleteGroupResult.deletedMemberships` for the runtime projection. |
| `apps/daemon/src/config.ts` | `RawAgentTypeConfigSchema`, `RawNanasaConfigSchema`, `validateAgentType`, `parseNanasaConfigSource`, `LoadedNanasaConfig.hasDeclarativeTopology` | Rename raw integration symbols and diagnostics, normalize map keys into integration IDs, validate integration home collisions, remove `agentProfiles`, parse `groups.agents`, and delete legacy topology detection. |
| `apps/daemon/src/config-repository.ts` | `initializeTopology`, `mutate`, `#write` | Delete SQLite-to-YAML topology import. Keep serialized atomic YAML mutation and write `instructions`, `roles`, `groups`, and `messages`; integrations remain administrator-authored configuration. |
| `apps/daemon/src/topology-service.ts` | `reconcile`, `createGroup`, profile CRUD, membership CRUD and reorder methods | Reconcile desired member IDs from `groups.agents`; initialize new groups with `agents: {}`; remove profile CRUD; add, update, remove, and reorder configured agents by agent ID. Resolve member IDs only when calling the coordinator or store. |
| `apps/daemon/src/store.ts` | `reconcileTopology`, `getSnapshot`, `createAgentProfile`, `#requireConfiguredAgentType` | Project each configured agent into same-ID `agent_profiles` and `memberships` rows. Read ordering from `groups.agents`. Remove the config-facing profile creator and agent type lookup, but retain `createInternalAgentProfile` and all runtime hydration methods. Filter snapshot profiles to those referenced by active memberships if historical orphan rows are retained. |
| `apps/daemon/src/server.ts` | `createDaemon`, runtime provisioner setup, profile and membership routes | Remove `initializeTopology`; build configuration-home policies from integrations; pass the stable configured agent ID to prompt resolution; remove profile routes; register group agent CRUD and order routes; translate agent IDs to member IDs before coordinator calls. |
| `apps/daemon/src/run-runtime-coordinator.ts` | Entire class | No behavioral refactor is required. It should continue to operate on internal `GroupMembership` objects and `(groupId, memberId)` addresses. Only server or topology call sites may change. |

Required adjacent changes, even though they are outside the requested focus:

* `apps/daemon/src/instruction-resolver.ts` replaces profile and membership
  lookup with one configured agent lookup and emits the `agent` source.
* `apps/daemon/src/agent-config-home.ts` renames scopes, placeholders, argument
  names, reserved directories, and diagnostics to integration and agent terms.
* `apps/daemon/src/agent-runtime-provisioner.ts` accepts path-safe configured
  agent IDs instead of requiring the `membership_` prefix. Its internal
  `GroupMembership` and `AgentProfile` inputs can remain.
* `apps/daemon/src/cli-admin.ts` selects integrations and changes `auth` wording
  from agent type and membership ID to integration and agent ID.
* `apps/daemon/src/membership-order.ts` may be renamed to `agent-order.ts`, but
  the ordering algorithm does not need to change.
* `apps/portal/src/api.ts`, `apps/portal/src/App.tsx`, and
  `apps/portal/src/components/group-tree.tsx` replace the two-step reusable
  profile plus membership workflow with one configured agent form and request.
* `templates/config.yaml` and `README.md` must describe integrations, agent
  scopes, configured agents, and the new instruction layering.
* Generated `dist` files should be rebuilt by the normal build process, not
  edited manually.

## Configuration migration

Replace the current `.nanasa/config.yaml` with this shape. Existing group,
membership-map, member, integration, and role IDs are retained. The obsolete
profile IDs disappear because each profile is currently used by one agent and
contains no additional instruction files.

```yaml
instructions:
  - .nanasa/instructions/nanasa-mcp.md
  - .nanasa/instructions/team.md
integrations:
  copilot:
    name: GitHub Copilot
    kind: copilot
    command: [copilot]
    cwd: .
    agentConfigHome: { scope: integration }
  pi:
    name: Pi
    kind: pi
    command: [pi]
    cwd: .
    agentConfigHome: { scope: integration }
  opencode:
    name: OpenCode
    kind: opencode
    command: [opencode]
    cwd: .
    agentConfigHome: { scope: integration }
  claude-code:
    name: Claude Code
    kind: claude-code
    command: [claude]
    cwd: .
    agentConfigHome: { scope: integration }
  claude-copilot:
    name: Claude Code via Copilot
    kind: claude-code
    command: [make, claude-copilot]
    cwd: .
    agentConfigHome: { scope: integration }
roles:
  project-manager:
    name: Project Manager
    description: Coordinates assignments, dependencies, decisions, and completion
    instructions:
      - .nanasa/instructions/project-manager.md
    permissionPolicy: inherit
    presentation:
      icon: clipboard-list
      color: teal
  implementor:
    name: Implementor
    description: Implements assigned changes and validates the result
    instructions:
      - .nanasa/instructions/implementor.md
    permissionPolicy: inherit
    presentation:
      icon: hammer
      color: blue
  reviewer:
    name: Reviewer
    description: Reviews changes and reports prioritized findings without modifying files
    instructions:
      - .nanasa/instructions/reviewer.md
    permissionPolicy: read-only
    presentation:
      icon: shield-check
      color: amber
groups:
  grp_2d506f47-630f-449c-bcb8-851f655d3fa8:
    name: Agent Team
    instructions:
      - .nanasa/instructions/groups/agent-team.md
    agents:
      membership_888894a6-8b04-45b5-8bdc-615c7924ab53:
        memberId: claude-copilot.magical-bose
        name: Claude Copilot
        integrationId: claude-copilot
        roleId: project-manager
        instructions: []
        order: 0
      membership_1bb181be-949e-4355-a854-3f36b38861f5:
        memberId: copilot.silly-brahmagupta
        name: GitHub Copilot
        integrationId: copilot
        roleId: implementor
        instructions: []
        order: 1
      membership_2f19022f-7c27-47bb-b0e3-c8c2a95204b1:
        memberId: opencode.nice-kalam
        name: Open Code
        integrationId: opencode
        roleId: implementor
        instructions: []
        order: 2
      membership_df3f1bb8-4484-4a1a-8bc9-94347c0d16c8:
        memberId: pi.dazzling-northcutt
        name: PI
        integrationId: pi
        roleId: reviewer
        instructions: []
        order: 3
messages:
  retentionPerGroup: 1000
```

Perform this as a coordinated code and YAML change while the daemon is stopped.
The old YAML must fail strict parsing after the refactor. No dual-schema reader,
root version switch, automatic profile expansion, or compatibility aliases
should be added.

## Test impact

Direct rewrites are required in these tests:

* `packages/contracts/test/contracts.test.ts` updates configuration defaults,
  reference failures, role layering, integration-home scopes, and agent CRUD
  command contracts. Add rejection cases for legacy `version`, `agentTypes`,
  `agentProfiles`, and `groups.memberships`.
* `apps/daemon/test/config.test.ts` updates all YAML fixtures and diagnostics,
  changes prompt sources to built-in, global, group, role, and agent, and
  replaces the legacy SQLite import test with a config-authoritative startup
  test.
* `apps/daemon/test/server.test.ts` replaces profile plus membership setup with
  direct agent creation, changes route paths and reorder payloads, and updates
  active-run mutation checks to agent role or instruction changes.
* `apps/daemon/test/store.test.ts` updates its `NanasaConfig` fixtures and adds
  focused flattened-config projection and restart assertions while retaining
  its direct internal profile and membership tests.
* `apps/daemon/test/ttyd-runtime.test.ts` updates its config fixture and agent
  creation and run routes. Restart and terminal identity assertions remain.
* `apps/daemon/test/agent-runtime-provisioner.test.ts` updates integration and
  agent home scope names, path expectations, custom placeholders, and valid
  configured agent IDs.
* `apps/daemon/test/membership-order.test.ts` updates names and fixtures only if
  the helper is renamed. Its ordering behavior remains unchanged.
* `apps/portal/src/api.test.ts` removes reusable profile requests and validates
  direct agent CRUD and configured integrations.
* `apps/portal/src/App.test.tsx` removes existing-profile selection and separate
  profile defaults, combines profile and membership instructions into agent
  instructions, and updates config fixtures and settings assertions.
* `apps/portal/src/components/terminal-workspace.test.tsx` updates shared config
  fixtures if runtime snapshot contracts remain unchanged.
* `test/acceptance/fixtures/package-fixture.ts` writes `integrations`, seeds one
  agent request per alias, and addresses agent resources by agent ID.
* `test/acceptance/crud-workflows.spec.ts` stops asserting that reusable
  profiles survive agent or group deletion. Run stop and event retention
  assertions remain valuable.
* `test/package-cli.test.mjs` updates integration config, home directories,
  custom placeholders, doctor output, and agent-scoped auth wording.

Most tests that construct `AgentProfile` and `GroupMembership` directly for
store, delivery, MCP, status, terminal, and coordinator behavior should remain
unchanged. In particular, `apps/daemon/test/run-runtime-coordinator.test.ts`
should remain a regression suite for the retained internal model.

Add focused coverage for these risks:

* A configured agent ID and member ID survive daemon restart and reconcile.
* Reconciliation uses the configured agent ID for both internal row IDs without
  changing the database schema version.
* Existing current-config membership IDs reconcile without a unique
  `(group_id, member_id)` violation.
* Historical runs keep resolving their old profile rows after the membership
  projection changes.
* Integration and member IDs cannot be changed through agent update commands.
* The exact prompt source order is built-in, global, group, role, and agent.
* Unknown integrations, unknown roles, duplicate global agent IDs, duplicate
  group member IDs, and duplicate instruction files fail configuration loading.

## Recommendations

1. Make the source schema breaking and unversioned now. Do not carry a second
   parser or legacy topology import into the alpha.
2. Flatten only the declarative and API model. Preserve SQLite and runtime
   profile and membership structures as an internal projection.
3. Keep configured agent IDs and member IDs separate and stable. Use agent IDs
   for CRUD identity and member IDs for messages, MCP recipients, and run
   addressing inside the coordinator.
4. Reuse current membership map keys during migration to preserve membership
   rows and runtime directories. Generate `agent_` IDs only for newly created
   agents.
5. Merge old profile then membership instruction arrays into the new agent
   array, and test the exact global to group to role to agent order.
6. Remove reusable-profile UI and routes in the same change so the product has
   one authoritative concept instead of a flattened YAML with a legacy API.

## References and evidence

* `packages/contracts/src/index.ts` defines the current three-layer config,
  reference validation, runtime profile and membership contracts, and portal
  snapshot.
* `apps/daemon/src/config.ts` performs strict YAML parsing, canonical agent type
  normalization, integration-home collision checks, and legacy topology
  detection.
* `apps/daemon/src/config-repository.ts` atomically serializes config mutations
  and contains the isolated SQLite-to-YAML compatibility import.
* `apps/daemon/src/instruction-resolver.ts` proves the current instruction order
  and duplicate-file rules.
* `apps/daemon/src/store.ts` shows that YAML map keys become SQLite primary keys,
  member IDs are group-scoped unique addresses, and runtime tables can accept a
  flattened projection without schema changes.
* `apps/daemon/src/run-runtime-coordinator.ts` depends only on groups, internal
  memberships, member IDs, and runs. It does not read the YAML profile model.
* `apps/daemon/src/agent-runtime-provisioner.ts` uses membership IDs for stable
  paths and profile execution fields, matching the proposed internal
  projection.
* `apps/daemon/src/server.ts` contains the only startup call to
  `initializeTopology` and the profile plus membership REST workflow.
* `.nanasa/config.yaml` has four one-to-one profile and membership pairs, so its
  migration loses no profile reuse and requires no instruction-file merge.

## Follow-on questions

None required for the requested direct alpha design.

## Clarifying questions

None.
