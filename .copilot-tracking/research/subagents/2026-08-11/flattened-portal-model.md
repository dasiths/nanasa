---
title: Flattened portal model research
description: Portal and API changes needed to replace profiles and memberships with integrations, roles, groups, and agents
ms.date: 2026-08-11
ms.topic: concept
---

## Research questions

* Where do contracts, daemon routes, portal API code, application views, group tree, terminal workspace, and tests expose profiles or memberships?
* What exact command and response shapes support integrations, roles, groups, and agents while preserving compatibility where practical?
* How should create, edit, remove, and reorder workflows behave when a group owns ordered agents?
* How should one Agent Settings form expose editable agent fields and read-only inherited instructions?
* What migration sequence minimizes persistence, runtime, and portal regression risk?

## Findings

### Current model and mismatch

* `agentTypes` are the configured integration catalog. Each entry owns provider kind,
  launch command, working directory, environment, and configuration-home policy.
* `agentProfiles` are reusable launch selections. A profile owns a display name,
  `agentType`, default role, and profile instruction paths.
* A group's `memberships` own `memberId`, alias, profile reference, role override,
  assignment instruction paths, and order.
* Effective prompt order is builtin coordination, builtin assignment, global,
  group, role, profile, then membership. The profile default role is used only
  when the membership has no override.
* The portal exposes both abstractions. Adding an agent can select or create a
  profile, then add a membership. Agent Settings has separate Membership and
  Reusable profile forms. Removal promises that the reusable profile remains.
* The runtime identity is already the group plus `memberId`. Runs, messages,
  status, terminals, MCP authorization, and recovery do not need a reusable
  profile as a user-facing concept. `agentProfileId` is an internal launch lookup.

The target model should therefore project each active membership and its referenced
profile as one group-owned agent. A public agent has a stable agent ID equal to the
current `memberId`, a name equal to the membership alias, an integration equal to
the profile's `agentType`, an effective role, and combined agent instructions.
Profile names have no distinct meaning after flattening.

### Behavioral constraints

* Reorder currently requires a complete, duplicate-free permutation of active
  member IDs. The daemon rejects stale sets with HTTP 409 and persists all order
  values in one configuration mutation.
* Alias and group-name changes are allowed while a run is active.
* Role, group-instruction, profile-role, and profile-instruction changes are
  rejected while an affected run is active. Integration changes are not currently
  supported after profile creation.
* Removing an agent stops its current run, revokes queued deliveries, removes the
  group membership, and preserves the profile. Deleting a group additionally
  removes runs, messages, and deliveries.
* The snapshot contains only active memberships and sorts them by declarative
  order. Terminal tabs and the group tree already preserve snapshot order.

### Affected product surfaces

* `packages/contracts/src/index.ts`: replace portal-facing profile and membership
  schemas with integration and agent projections; add atomic agent commands and
  results; retain old schemas temporarily for compatibility and daemon internals.
* `apps/portal/src/api.ts`: replace profile plus membership calls with agent calls,
  and use agent route names for run and reorder operations.
* `apps/portal/src/App.tsx`: consume `snapshot.agents`; replace the two-step add and
  split update callbacks with one create and one update operation.
* `apps/portal/src/components/group-tree.tsx`: simplify Add Agent and Agent Settings,
  remove profile source/default/override language, and change all member or
  membership copy to agent terminology.
* `apps/portal/src/components/terminal-workspace.tsx`: accept agents and `agentId`.
  The component's behavior and layout do not otherwise need to change.
* `apps/portal/src/member-status.ts` and message workspace inputs: rename portal
  view-model parameters to agents while mapping to the existing member protocol.
* `apps/daemon/src/server.ts`: add agent routes and keep old profile/membership
  routes only during a deprecation window.
* `apps/daemon/src/topology-service.ts`: add atomic create and update agent methods;
  this is the controlling change, because integration, role, name, and instructions
  currently span two configuration records.
* `apps/daemon/src/config-repository.ts`, `store.ts`, and
  `instruction-resolver.ts`: add a flattened projection and normalize agent prompt
  sources. Retain SQLite profile and membership tables in the first release.
* Portal unit tests, daemon server/config tests, terminal workspace tests, and all
  acceptance fixtures must stop constructing or asserting portal profiles and
  memberships. Runtime, MCP, and recovery tests may retain member terminology
  until their wire protocol is deliberately versioned.

## Recommendations

### Terminology boundary

Use these terms in the portal and new REST surface:

* Integration: a configured provider/launcher currently named `agentType`
* Role: a configured instruction and permission policy
* Group: an ordered owner of agents
* Agent: one group-owned runnable identity
* Agent ID: the existing immutable `memberId` value, displayed only where an
  operator needs a routing identifier
* Agent instructions: the only agent-editable instruction layer
* Inherited instructions: global, group, and selected-role paths, displayed
  read-only

Keep `memberId`, membership revision, profile IDs, and membership IDs inside the
daemon and existing MCP/message compatibility protocol. Do not perform a broad
wire rename in the portal flattening change.

### Public response shapes

Introduce a portal projection instead of returning `NanasaConfig` and the raw
runtime snapshot separately. The portal should call `GET /api/portal` and parse:

```ts
interface PortalModel {
  sequence: number;
  generatedAt: string;
  configRevision?: string;
  configStatus: ConfigStatus;
  globalInstructions: InstructionPath[];
  integrations: Integration[];
  roles: PortalRole[];
  groups: PortalGroup[];
  agents: Agent[];
  runs: PortalAgentRun[];
  agentStatuses: PortalAgentStatus[];
  messages: Message[];
  deliveryOutcomes: DeliveryOutcome[];
  messageGroups: GroupMessageState[];
}

interface Integration {
  id: AgentTypeKey;
  name: string;
  kind: AgentKind;
}

interface PortalRole extends RoleDefinition {
  id: RoleId;
}

interface PortalGroup {
  id: string;
  name: string;
  instructions: InstructionPath[];
  agentRevision: number;
  createdAt: string;
  updatedAt: string;
}

interface Agent {
  id: string;
  groupId: string;
  name: string;
  integrationId: AgentTypeKey;
  roleId?: RoleId;
  instructions: InstructionPath[];
  order: number;
  createdAt: string;
}
```

`PortalAgentRun` and `PortalAgentStatus` should expose `agentId`, not `memberId` or
`agentProfileId`. Their values map directly to existing runtime member IDs. The
compatibility snapshot can remain available until non-portal clients migrate.

For Agent Settings, derive the read-only list from `globalInstructions`, the owning
group's `instructions`, and the selected role's `instructions`. Display empty
sections explicitly. Agent instructions remain an editable array on `Agent`.

### Command and result shapes

Create an agent atomically:

```http
POST /api/groups/:groupId/agents
```

```ts
interface CreateAgentCommand {
  name: string;
  integrationId: AgentTypeKey;
  roleId?: RoleId;
  instructions?: InstructionPath[];
}
// 201 Agent
```

Update the same four fields through one route:

```http
PATCH /api/groups/:groupId/agents/:agentId
```

```ts
interface UpdateAgentCommand {
  name?: string;
  integrationId?: AgentTypeKey;
  roleId?: RoleId | null;
  instructions?: InstructionPath[];
}
// 200 Agent
```

Require at least one field. Name-only updates remain live. If `integrationId`,
`roleId`, or `instructions` changes while the agent is active, return HTTP 409:

```json
{
  "code": "active_agent_change_requires_restart",
  "message": "Stop the agent before changing its integration, role, or instructions",
  "fields": ["integrationId", "roleId", "instructions"]
}
```

Remove an agent:

```http
DELETE /api/groups/:groupId/agents/:agentId
```

```ts
interface RemoveAgentResult {
  groupId: string;
  agentId: string;
  deletedRuns: number;
  revokedDeliveries: number;
}
```

Return the result instead of a synthetic removed membership. Reorder agents with a
complete permutation and optimistic revision:

```http
PUT /api/groups/:groupId/agent-order
```

```ts
interface ReorderAgentsCommand {
  agentIds: string[];
  expectedAgentRevision: number;
}

interface ReorderAgentsResult {
  groupId: string;
  agentIds: string[];
  agentRevision: number;
}
```

Reject duplicates, missing or extra agents, and revision mismatches with HTTP 409
`agent_order_stale`. Keep the full-permutation rule because it is already atomic
and tested. Rename run routes without changing runtime behavior:

```text
POST   /api/groups/:groupId/agents/:agentId/run
DELETE /api/groups/:groupId/agents/:agentId/run
POST   /api/groups/:groupId/runs/start-all
```

Update group deletion results from `deletedMemberships` to `deletedAgents`. Preserve
the old field only on the deprecated route or compatibility schema.

### Portal workflows

* Add Agent opens one form with Name, Integration, Role, and Agent instruction
  files. Integration and role options come from the portal model. Submit one POST.
* Agent Settings uses the same four controls in one form. Below them, show Global,
  Group, and Role instruction lists as read-only inherited layers. Do not show
  profile defaults, role overrides, assignment instructions, or two save buttons.
* When a run is active, allow name edits and disable the three restart-sensitive
  fields with a concise stopped-run requirement. Keep the server-side 409 check.
* Remove Agent confirmation says the current run will stop, queued deliveries will
  be revoked, and the agent will be removed from the group. Remove every promise
  that a profile remains.
* Move Up and Move Down may remain for the first release. Each sends the complete
  ordered agent ID list and current `agentRevision`; refresh after a stale response.
* Group deletion copy uses agents rather than memberships. Empty-state and summary
  copy uses agents consistently, including the workspace count and terminal prompt.

### Lowest-risk migration

1. Add flattened contracts and a pure projection from current config plus snapshot.
  Keep current profile, membership, SQLite, message, MCP, and recovery contracts.
2. Add atomic `TopologyService.createAgent`, `updateAgent`, `removeAgent`, and
  `reorderAgents` methods. New agents receive a private internal profile. Existing
  shared profiles are copy-on-write when an agent changes integration or direct
  settings, so another group agent never changes unexpectedly.
3. For legacy agents, project `name = alias`, `integrationId = profile.agentType`,
  `roleId = membership.roleId ?? profile.defaultRoleId`, and agent instructions as
  profile instructions followed by membership instructions. On the first
  prompt-affecting edit, normalize to a private profile with no role/instruction
  defaults and store the complete direct role and instruction list on the internal
  membership.
4. Add `/api/portal` and `/agents` routes, then migrate the portal and its tests.
  Keep `/api/config`, `/api/snapshot`, `/api/agent-profiles`, and `/memberships`
  during one compatibility release, but stop calling them from the portal.
5. Change event names for the new facade to `agent.created`, `agent.updated`,
  `agent.removed`, and `agent.reordered`. Continue emitting or translating legacy
  events while old clients are supported.
6. After compatibility telemetry or a documented release window, migrate YAML to a
  version 2 `integrations` and group-owned `agents` shape with an explicit offline
  migration command. Do not combine that persistence rewrite with the portal
  change. Requiring stopped agents during this later migration avoids recovery
  identity changes.
7. Remove profile and membership REST routes and public schemas only after the
  version 2 loader, migration rollback, daemon restart recovery, and config comment
  preservation are tested.

## Evidence

* `packages/contracts/src/index.ts` defines `ConfiguredAgentProfile`,
  `ConfiguredMembership`, profile and membership commands, the raw portal snapshot,
  complete membership-order validation, and member/profile fields on runs.
* `apps/daemon/src/instruction-resolver.ts` proves effective role fallback and the
  current global, group, role, profile, membership instruction order.
* `apps/daemon/src/topology-service.ts` owns declarative mutations, active-run
  restrictions, generated member IDs, complete reorder validation, and the current
  two-record create workflow.
* `apps/daemon/src/config-repository.ts` writes `agentProfiles` and group
  `memberships` atomically to YAML; `apps/daemon/src/store.ts` reconciles those into
  separate SQLite tables and orders snapshots from declarative membership order.
* `apps/daemon/src/server.ts` exposes separate profile and membership routes and
  nests run routes beneath memberships.
* `apps/portal/src/App.tsx` performs create-profile then add-membership and exposes
  independent member and profile update callbacks.
* `apps/portal/src/components/group-tree.tsx` contains the current profile-source
  add flow, split Agent Settings forms, inherited instruction display, complete
  reorder calls, and profile-preserving removal copy.
* `apps/portal/src/components/terminal-workspace.tsx` only needs alias, member ID,
  role, and runs; it does not otherwise depend on profiles.
* `apps/portal/src/App.test.tsx`, `apps/portal/src/api.test.ts`,
  `apps/daemon/test/server.test.ts`, and `test/acceptance/crud-workflows.spec.ts`
  assert the current terminology and split behavior and identify the primary test
  migration surface.
* `.nanasa/config.yaml` demonstrates one profile per current agent, while the code
  permits sharing. This makes private profiles a compatible first step but does not
  justify assuming profiles are always unique.

## Follow-on questions

* Decide the compatibility release duration and whether external REST consumers
  exist beyond the bundled portal.
* Decide whether the later YAML version 2 migration is in scope for the same product
  milestone. It should remain a separate implementation change even if planned now.

## Clarifying questions

* Should integrations and roles remain repository-configured catalogs, or must the
  portal also create and delete them? The requested Agent Settings form only needs
  selection, and current daemon APIs support role presentation edits but no full
  integration or role CRUD.
