---
title: Flattened prompt provisioning research
description: Dependency trace and migration recommendations for flattened group agents
ms.date: 2026-08-11
ms.topic: reference
---

## Research scope

* Trace every dependency on `agentProfiles`, `defaultRoleId`, membership role overrides, profile instructions, membership instructions, `memberId`, and `agentProfileId`.
* Cover prompt resolution, runtime provisioning, provider homes and authentication, MCP and status, messages, and tests.
* Propose how flattened group agents with `integration`, `role`, and `instructions` preserve the built-in, global, group, role, and agent instruction layers.
* Separate implementation details that can remain internal from public contracts that must change.

## Findings

### Current configuration and canonical projection

* `packages/contracts/src/index.ts` defines `agentProfiles` as reusable records
  containing `name`, `agentType`, optional `defaultRoleId`, and profile
  `instructions`. Each configured membership contains a stable public
  `memberId`, an `agentProfileId`, an optional role override, and membership
  `instructions`.
* `NanasaConfigSchema` validates profile-to-agent-type references, profile
  default roles, membership-to-profile references, membership role overrides,
  and uniqueness of `memberId` within a group.
* `apps/daemon/src/store.ts` projects each configured profile into the existing
  `agent_profiles` table. It resolves the effective persisted membership role
  as `membership.roleId ?? profile.defaultRoleId`, while retaining both the
  internal membership row ID and public `memberId`.
* Canonical `GroupMembership` and `AgentRun` API records expose
  `agentProfileId`. `PortalSnapshot` also exposes the complete
  `agentProfiles` array. These are public legacy-profile dependencies, not only
  implementation details.

### Prompt resolution

* `apps/daemon/src/instruction-resolver.ts` owns prompt composition. It accepts
  `profileId`, `groupId`, and internal `membershipId`, verifies the membership
  references the requested profile, then resolves the role override before the
  profile default.
* The current additive order is built-in coordination, built-in assignment,
  global files, group files, resolved role files, profile files, and membership
  files. Duplicate instruction paths across all configured scopes are rejected.
* Built-in assignment text embeds public `memberId`, alias, resolved role name
  and ID, and role description. The prompt manifest records the resolved role,
  permission policy, revision, and ordered sources.

### Runtime and provider homes

* `apps/daemon/src/server.ts` reloads current configuration at launch and calls
  the resolver with canonical profile and membership IDs. This prevents stale
  prompt material from being reused after a stopped agent is reconfigured.
* `apps/daemon/src/tmux-runtime.ts` creates a run from `groupId + memberId`, then
  passes the canonical profile and membership to
  `AgentRuntimeProvisioner.provision`.
* `apps/daemon/src/agent-runtime-provisioner.ts` uses the profile's `agentType`
  to select provider-home policy and the canonical profile's command, kind,
  arguments, working directory, and environment to launch the provider.
* Provider homes and generated agent names are keyed by internal membership ID,
  not public `memberId` or `agentProfileId`. This gives each configured agent a
  stable private persistence location even if its alias or role changes.
* Copilot, Claude Code, Pi, and OpenCode receive the same resolved prompt through
  provider-specific files or arguments. The resolved role's `read-only` policy
  also drives provider-specific tool denial.
* MCP configuration and status reporters are materialized into each provider
  home. `NANASA_MCP_TOKEN` is injected per run rather than stored in public
  configuration.

### Identity boundaries

* Internal membership ID is the stable persistence key for provider homes and
  declarative record reconciliation.
* Public `memberId` is the stable group-local address for run control, MCP
  identity, status lookup, messages, terminal labels, and delivery records.
* `agentProfileId` identifies reusable launch configuration today. It is not an
  authorization or message-routing identity and can disappear from public
  contracts after launch configuration moves directly onto each group agent.

### MCP, status, and messages

* `apps/daemon/src/mcp-auth.ts` signs capabilities containing `groupId`,
  `memberId`, `runId`, and generation. Authentication fences the capability
  against the active membership and latest active run. It has no profile or
  role dependency.
* `apps/daemon/src/mcp-server.ts` uses `memberId` for caller identity, direct and
  multicast recipients, and status lookup. Its `list_members` implementation is
  the only MCP profile dependency: it joins `membership.agentProfileId` to the
  snapshot profile array to report `agentType`.
* `apps/daemon/src/store.ts` builds status summaries by joining the membership
  to its profile for `agentType` and to configuration for role presentation.
  Status generation fencing uses only group, member, run, and generation.
* `apps/daemon/src/agent-status-routes.ts` authenticates status events through
  the run capability. `agent-status-reducer.ts` and the generated status
  reporters are profile-agnostic.
* Message audiences, agent senders, delivery outcomes, failed-recipient state,
  terminal delivery labels, and broadcast exclusion all use `memberId`.
  `MessageCommandService` is a pass-through; recipient and sender enforcement
  lives in `apps/daemon/src/store.ts`.
* `membershipRevision` protects group broadcasts from topology races. It does
  not depend on profiles and can remain even if configuration calls the
  flattened collection `agents`.

### Mutation and presentation dependencies

* `apps/daemon/src/topology-service.ts` exposes separate profile and membership
  mutations. Profile role or instruction changes are rejected while any agent
  using that profile is active; membership role or instruction changes are
  rejected while that member is active. Flattening reduces both checks to one
  per-agent restart guard that also covers integration changes.
* `apps/daemon/src/config-repository.ts` writes `agentProfiles` and `groups`
  independently. Its legacy topology import reconstructs profiles first and
  then memberships from a snapshot.
* `apps/daemon/src/config.ts` treats the presence of `agentProfiles` or `groups`
  as declarative topology, normalizes `agentTypes`, validates provider-home
  collisions, and validates every instruction file.
* `apps/daemon/src/agent-config-home.ts` and `apps/daemon/src/cli-admin.ts` use
  `agentType` plus internal membership ID to resolve shared, member-specific,
  or custom provider homes. Shared homes preserve provider authentication
  across agents using one integration; member homes isolate it.
* `apps/portal/src/api.ts`, `App.tsx`, and `components/group-tree.tsx` expose the
  two-step profile-plus-membership workflow. The settings dialog separately
  edits profile defaults and assignment overrides, and the add form can create
  or reuse a profile.
* `components/message-workspace.tsx`, `terminal-workspace.tsx`, and
  `member-status.ts` depend on group membership and `memberId`, not reusable
  profile behavior. They need type-shape adaptation but no routing redesign.

## Proposed model

Use a versioned flattened configuration in which integration definitions own
provider launch and home policy, roles own reusable behavioral policy, and each
group agent owns its final integration, role, and agent-specific instructions.

```yaml
version: 2
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
    instructions: [.nanasa/instructions/implementor.md]
    permissionPolicy: inherit
groups:
  group_one:
    name: Agent Team
    instructions: [.nanasa/instructions/groups/agent-team.md]
    agents:
      agent_one:
        memberId: copilot.silly-brahmagupta
        alias: GitHub Copilot
        integration: copilot
        role: implementor
        instructions: []
        order: 0
```

The map key (`agent_one`) is the stable internal group-agent ID. Keep the
existing configured membership map key during migration so provider homes and
stored membership identity remain stable. Keep `memberId` as an opaque,
group-local public address and do not rewrite existing values merely because
their prefix was generated from an old agent-type key.

Do not add integration instructions. Integrations describe provider execution
and authentication state, not behavior. This preserves one unambiguous prompt
order:

1. Built-in Nanasa coordination
2. Built-in assignment identity and resolved role description
3. Global instruction files
4. Group instruction files
5. Direct role instruction files
6. Flattened agent instruction files

The resolver should accept `groupId` and stable agent ID, read one configured
agent, validate its direct `integration` and optional `role`, and emit the
source scope `agent` instead of `profile` and `membership`. Role permission
policy continues to drive provider tool restrictions.

For migration, resolve each legacy agent as follows:

* Set `integration` to `agentProfiles[agentProfileId].agentType`
* Set `role` to `membership.roleId ?? profile.defaultRoleId`
* Set `instructions` to profile instructions followed by membership
  instructions
* Preserve the group ID, membership map key, `memberId`, alias, and order

Concatenation preserves the old within-agent ordering. Existing validation
already rejects duplicate instruction paths across scopes, so the merged list
cannot introduce a previously accepted duplicate. Prompt text and revision
will change once because the old `profile` and `membership` section labels
become `agent`; the behavioral content and precedence remain stable.

### Internal projection strategy

Retain the SQLite `agent_profiles`, `memberships`, and `runs.agent_profile_id`
storage initially. Treat `agent_profiles` as daemon-private launch records and
materialize one deterministic internal launch profile per flattened group
agent. Historical profile rows can remain for old run foreign keys.

The persisted membership row ID stays equal to the flattened agent map key.
Provider-home paths and generated provider-agent names therefore remain stable.
New runs reference the per-agent internal launch profile, while public records
project `integration` instead of `agentProfileId`.

This compatibility layer avoids a risky database rewrite and keeps
`AgentRuntimeProvisioner`, `TmuxRuntime`, provider argument generation, MCP
injection, status reporters, and read-only enforcement structurally unchanged.
The internal parameter names `profile` and `membership` can be renamed later
without affecting behavior.

## Contract impact

### Public contracts that must change

* Replace configuration `agentTypes` with `integrations`, remove
  `agentProfiles`, and replace `groups.*.memberships` with
  `groups.*.agents` containing direct `integration`, `role`, and
  `instructions` fields.
* Bump the configuration version. A breaking schema under version 1 would make
  diagnostics and migration ambiguous.
* Replace `ConfiguredAgentProfile` and `ConfiguredMembership` with a configured
  group-agent contract. Validate integration and role references directly and
  retain duplicate-`memberId` and order validation.
* Replace public `AgentProfile` and `GroupMembership` projection with a
  `GroupAgent` containing stable ID, group ID, `memberId`, alias, integration,
  role, and state. Remove `PortalSnapshot.agentProfiles` and expose flattened
  agents.
* Replace public `AgentRun.agentProfileId` with `integration`, or omit launch
  configuration from runs and resolve it through the snapshot agent. Exposing
  the integration is preferable for historical run inspection.
* Replace `AgentStatusSummary.agentType` and MCP `list_members.agentType` with
  `integration`. Keep status role ID and role name.
* Remove profile CRUD commands and `/api/agent-profiles`. Replace add/update
  membership commands with one group-agent create/update command carrying
  integration, role, alias, and instructions.
* Update portal client methods, forms, snapshot parsing, and event handling to
  perform one group-agent mutation. Remove reusable-profile UI and default-role
  wording.
* Emit agent-oriented domain events and payloads for new mutations. Historical
  `agent-profile.*` and `membership.*` events may remain readable in the event
  log.
* Update public custom-home vocabulary from agent type and membership ID to
  integration and stable agent ID, such as `{integration}` and `{agentId}`.
  Internally translating legacy placeholders is sufficient for migration.
* Update README, template configuration, packaged acceptance fixtures, and the
  checked-in `.nanasa/config.yaml` when implementation begins.

### Contracts and internals that can remain

* Keep `memberId` in configuration, run control, terminal labels, MCP claims,
  status APIs, message senders and audiences, delivery outcomes, and portal
  recipient controls.
* Keep `groupId`, `runId`, generation fencing, role IDs, role permission policy,
  instruction path validation, prompt size limits, and prompt hashing.
* Keep `membershipRevision` and message broadcast semantics. Membership remains
  a valid routing concept even when the configured collection is named
  `agents`.
* Keep SQLite table and column names, internal membership IDs, internal launch
  profiles, provider-home directory layout, and historical rows.
* Keep MCP token format and authentication checks. Integration and role do not
  belong in the capability because authorization is bound to active run
  identity.
* Keep provider-specific prompt, MCP, status-hook, and read-only-policy
  materialization. Only the source of command/home policy changes from profile
  plus agent type to flattened agent plus integration.
* Keep message storage, delivery dispatch, terminal delivery, status reducer,
  and status reporter assets unchanged apart from public type adaptation.

## Test impact

Rewrite profile-specific setup and assertions, but preserve `memberId` behavior
tests unless their fixture types or URLs change.

* `packages/contracts/test/contracts.test.ts` should cover version 2, direct
  integration and role references, missing references, duplicate member IDs,
  ordering, and the flattened agent default instruction list.
* `apps/daemon/test/config.test.ts` should assert prompt source order
  `builtin, builtin, global, group, role, agent`, direct role policy, home
  collision checks under integrations, and deterministic legacy migration.
* `apps/daemon/test/agent-runtime-provisioner.test.ts` should replace profile
  fixtures with internal launch records but retain all four provider prompt,
  home, MCP, status, file-mode, and read-only assertions.
* `apps/daemon/test/server.test.ts` should replace two-step profile and
  membership CRUD with group-agent CRUD, assert one restart guard for
  integration, role, or instruction changes, and verify the flattened snapshot
  and events.
* `apps/daemon/test/store.test.ts` should verify the private per-agent launch
  projection, stable membership ID and provider home, historical run retention,
  direct integration status projection, and absence of public profiles.
* `apps/daemon/test/mcp-server.test.ts` should expect `integration` from the
  flattened agent. `mcp-auth.test.ts`, `agent-status-store.test.ts`,
  `delivery-dispatcher.test.ts`, and `terminal-delivery.test.ts` should retain
  their member/run fencing and routing assertions with updated fixtures.
* `membership-order.test.ts` and `run-runtime-coordinator.test.ts` need type and
  helper renames; their ordering, start-all, recovery, and `memberId` behavior
  remains valid.
* `terminal-proxy.test.ts`, `ttyd-manifest.test.ts`, `ttyd-runtime.test.ts`, and
  `ttyd-supervisor.test.ts` need run/agent fixture updates only. Terminal
  ownership remains keyed by run and member.
* `apps/portal/src/api.test.ts`, `App.test.tsx`, and
  `components/terminal-workspace.test.tsx` should use flattened agents and a
  single create/update API.
* `test/acceptance/fixtures/package-fixture.ts` should seed each agent with one
  request. `crud-workflows.spec.ts` should stop asserting reusable profiles.
  Restart and messaging acceptance tests should continue asserting stable
  `memberId`, pane identity, recipients, and delivery labels.
* `test/package-cli.test.mjs` must use `integrations` in generated configuration
  fixtures.

## Recommendations

1. Adopt configuration version 2 with `integrations`, `roles`, and
   `groups.*.agents`; do not retain public profiles or default-role overrides.
2. Preserve stable group-agent map keys and `memberId`. They protect provider
   homes, run recovery, status, and message addressing from unnecessary churn.
3. Collapse legacy profile and membership instructions into one agent list in
   that order, then make the resolver emit exactly the six layers above.
4. Keep launch profiles and membership tables as a daemon-private compatibility
   projection. Separate daemon-private launch types from exported contracts so
   `agentProfileId` cannot leak back into snapshots.
5. Replace profile-plus-membership REST and portal workflows atomically. Avoid
   a transitional UI that can create orphan profiles or partially configured
   agents.
6. Keep MCP credentials and all message addressing based on `memberId`; only
   change member discovery and status presentation from `agentType` to
   `integration`.
7. Require stopped runs before changing integration, role, or agent
   instructions, and require all group runs stopped before changing global,
   group, or role instruction content that affects them.
8. Add a deterministic one-shot migration with a dry-run diagnostic. Reject
   version 1 at normal version 2 load after migration rather than silently
   interpreting both shapes.

## References and evidence

* `packages/contracts/src/index.ts`: configuration, profile, membership, run,
  status, message, delivery, and snapshot schemas
* `apps/daemon/src/config.ts`: raw YAML schema, normalization, topology
  detection, provider-home collision checks, and instruction validation
* `apps/daemon/src/config-repository.ts`: YAML writes and legacy topology import
* `apps/daemon/src/instruction-resolver.ts`: role fallback and complete prompt
  composition order
* `apps/daemon/src/store.ts`: topology projection, run creation, status joins,
  message validation, delivery addressing, and snapshot assembly
* `apps/daemon/src/topology-service.ts`: profile and membership mutation rules
  and active-run restart guards
* `apps/daemon/src/server.ts`: prompt resolver and runtime provisioner wiring
* `apps/daemon/src/tmux-runtime.ts`: run-to-profile-to-provisioner launch path
* `apps/daemon/src/agent-runtime-provisioner.ts`: all provider prompt, MCP,
  status, home, and permission materialization
* `apps/daemon/src/agent-config-home.ts` and `cli-admin.ts`: provider-home
  identity and lifecycle
* `apps/daemon/src/mcp-auth.ts` and `mcp-server.ts`: run capability identity,
  member discovery, status, and message tools
* `apps/daemon/src/agent-status-routes.ts`: authenticated status ingestion
* `apps/daemon/src/message-command-service.ts` and `terminal-delivery.ts`: message
  submission boundary and public sender labels
* `apps/portal/src/api.ts`, `App.tsx`, and `components/group-tree.tsx`: public
  profile and membership workflow
* `.nanasa/config.yaml`: concrete legacy profile-to-membership topology used by
  the current workspace
* `packages/contracts/test/contracts.test.ts`, `apps/daemon/test/config.test.ts`,
  `agent-runtime-provisioner.test.ts`, `server.test.ts`, `store.test.ts`,
  `mcp-auth.test.ts`, `mcp-server.test.ts`, and portal and acceptance tests:
  current regression surface

## Follow-on questions

* Decide whether the public noun `alias` remains or becomes `name`. This choice
  does not affect provisioning or prompt order.
* Decide whether REST paths retain `/memberships/:memberId` for compatibility or
  move to `/agents/:memberId`. For an alpha-only breaking release, `/agents` is
  clearer; message `membershipRevision` can still remain.
* Define whether version 1 migration is a CLI command or an automatic backup
  and rewrite. The mapping itself is deterministic.

## Clarifying questions

None required to recommend the model. The follow-on naming and migration-entry
choices can be made during implementation without changing the architecture.
