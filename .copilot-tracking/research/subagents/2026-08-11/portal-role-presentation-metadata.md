---
title: Portal role presentation metadata research
description: Minimal implementation path for portal-editable role icon, color, and short name metadata
author: GitHub Copilot
ms.date: 2026-08-11
ms.topic: reference
---

## Research questions

* Which exact contract symbols must carry role presentation metadata?
* Which daemon repository, topology, and route symbols form the minimal persistence path?
* Which portal API, application state, and group tree settings patterns should be mirrored?
* What active-run safety constraints apply when presentation metadata changes?
* What is the smallest focused test plan across contracts, daemon, and portal?

## Scope

* packages/contracts/src/index.ts
* apps/daemon/src/config-repository.ts
* apps/daemon/src/topology-service.ts
* apps/daemon/src/server.ts
* Relevant files under apps/daemon/test
* apps/portal/src/api.ts
* apps/portal/src/App.tsx
* apps/portal/src/components/group-tree.tsx
* Relevant portal tests

## Findings

The presentation model already exists in the contracts and persisted configuration. The missing
surface is a narrow mutation path and portal form.

* `RolePresentationIconSchema` defines `briefcase-business`, `clipboard-list`, `code`, `hammer`,
  `scan-search`, `shield-check`, `waypoints`, and `wrench`
* `RolePresentationColorSchema` defines `amber`, `blue`, `cyan`, `rose`, `slate`, `teal`, and
  `violet`
* `RolePresentationSchema` requires `icon` and `color`; `shortName` is trimmed, optional, and
  limited to 24 characters
* `RoleDefinitionSchema.presentation` is already optional, and `NanasaConfigSchema.roles` already
  persists `RoleDefinitionSchema` values
* No new contract shape is required for the minimal API. Reuse `RolePresentation`,
  `RolePresentationSchema`, `RoleDefinition`, and `RoleDefinitionSchema`
* `ConfigRepository.mutate` already serializes mutations, reloads the latest configuration, and
  validates the result before returning
* `ConfigRepository.#write` already writes `config.roles` through `document.set("roles",
  config.roles)`, validates the candidate, checks the source revision twice, and atomically renames
  the temporary file
* `TopologyService` has no role mutation today. Its update pattern is repository mutation, store
  reconciliation, runtime event emission, and return of the refreshed projection
* `server.ts` has no role route today. Existing update routes parse a strict contract schema and
  delegate to `TopologyService`
* `PortalClient` and `api` have no role update method. Existing PATCH methods encode path IDs,
  validate the command before sending, and validate the response
* `App.runAction` handles busy and error state and refreshes portal data after a successful
  mutation. The new callback should use this path so the updated config reaches every role
  consumer
* `GroupTree` already receives the complete `NanasaConfig`, enumerates `config.roles`, and renders
  each assigned role through `RoleIdentity`. Presentation rendering exists, but there is no global
  role settings entry or update callback
* A global role settings dialog opened from the `GroupTree` rail header is the smallest
  semantically correct UI. It exposes unused roles and does not imply that global metadata belongs
  to one group, profile, or membership

## Evidence

* `packages/contracts/src/index.ts`: `RolePresentationIconSchema`,
  `RolePresentationColorSchema`, `RolePresentationSchema`, `RoleDefinitionSchema`, and
  `NanasaConfigSchema`
* `apps/daemon/src/config-repository.ts`: `ConfigRepository.mutate` and
  `ConfigRepository.#write`
* `apps/daemon/src/topology-service.ts`: `TopologyService.updateGroup`,
  `TopologyService.updateAgentProfile`, and `TopologyService.updateMembership`
* `apps/daemon/src/server.ts`: `PATCH /api/groups/:groupId`,
  `PATCH /api/agent-profiles/:profileId`, and
  `PATCH /api/groups/:groupId/memberships/:memberId`
* `apps/portal/src/api.ts`: `PortalClient`, `commandInit`, `api.updateGroup`, and
  `api.updateAgentProfile`
* `apps/portal/src/App.tsx`: `runAction`, `updateGroup`, `updateAgentProfile`, and the `GroupTree`
  prop wiring
* `apps/portal/src/components/group-tree.tsx`: `GroupTreeProps`, `roleOptions`,
  `GroupSettingsDialog`, `AgentSettingsDialog`, the rail header, and `RoleIdentity`
* `apps/daemon/test/server.test.ts`: `assigns roles and rejects role changes while an agent run is
  active` demonstrates prompt-affecting active-run guards and live-safe name updates
* `apps/daemon/test/config.test.ts`: `loads role instructions and composes deterministic effective
  prompts` is the nearest role configuration fixture, but a new direct test is unnecessary if the
  route integration test verifies the write and reload
* `apps/portal/src/api.test.ts`: `updates reusable profile role and Markdown instruction defaults`
  and `sends encoded group and membership CRUD commands` provide the request assertion pattern
* `apps/portal/src/App.test.tsx`: `edits membership overrides and reusable profile defaults
  independently` provides the settings-dialog interaction pattern; `keeps row actions keyboard
  accessible without obscuring labels` already asserts a presentation color class
* `apps/portal/src/components/terminal-workspace.test.tsx`: `uses semantic agent status colors in
  tabs while the terminal is ready` already proves configured color and `shortName` rendering

## Minimal implementation path

### Contracts

No source change is required in `packages/contracts/src/index.ts` for the minimal path.

Use these existing public symbols:

* Request body: `RolePresentation` validated by `RolePresentationSchema`
* Response body: `RoleDefinition` validated by `RoleDefinitionSchema`
* Form option values: `RolePresentationIcon`, `RolePresentationColor`, and the corresponding enum
  schemas

Treat the request as complete replacement of the presentation subresource. This gives omission of
`shortName` a clear meaning: remove the configured short name. A partial merge would require a new
nullable command shape to distinguish removal from preservation.

### Config repository

No change is required in `apps/daemon/src/config-repository.ts`. Call
`ConfigRepository.mutate`; `#write` already persists and validates the complete `roles` mapping.

### Topology service

Add this exact public method to `TopologyService`:

```typescript
public async updateRolePresentation(
  roleId: string,
  presentation: RolePresentation,
): Promise<RoleDefinition>
```

The mutation should:

1. Read `config.roles[roleId]`
2. Throw `new DomainError("role_not_found", "Role not found", 404)` when absent
3. Replace only `role.presentation`, preserving `name`, `description`, `instructions`, and
   `permissionPolicy`
4. Call `this.#store.reconcileTopology(mutation.loaded.config, mutation.loaded.status)`
5. Emit `this.#store.recordRuntimeEvent("role.presentation.updated", "role", roleId, { roleId })`
6. Return `mutation.loaded.config.roles[roleId]`

### Daemon route

Add this route beside the other configuration-backed PATCH routes in
`apps/daemon/src/server.ts`:

```text
PATCH /api/roles/:roleId/presentation
```

Parse the body with `RolePresentationSchema.parse(request.body)` and delegate to
`topology.updateRolePresentation(request.params.roleId, presentation)`. The response is the updated
`RoleDefinition`. This mirrors the existing PATCH route pattern while keeping prompt-affecting role
fields outside the endpoint.

### Portal API

Add this exact method to `PortalClient` and `api` in `apps/portal/src/api.ts`:

```typescript
updateRolePresentation(
  roleId: string,
  presentation: RolePresentation,
): Promise<RoleDefinition>;
```

The implementation should call the recommended endpoint with an encoded role ID,
`commandInit("PATCH", RolePresentationSchema.parse(presentation))`, and
`RoleDefinitionSchema` as the response validator.

### App wiring

Add a local `updateRolePresentation` callback in `apps/portal/src/App.tsx`:

```typescript
const updateRolePresentation = (roleId: string, presentation: RolePresentation) =>
  runAction(`${roleId}:presentation`, () =>
    client.updateRolePresentation(roleId, presentation),
  );
```

Pass it to `GroupTree` as `onUpdateRolePresentation`. `runAction` supplies local busy/error handling
and refreshes both snapshot-backed state and configuration after success.

### Group tree settings UI

In `apps/portal/src/components/group-tree.tsx`:

* Add `GroupTreeProps.onUpdateRolePresentation(roleId, presentation)`
* Add a `RolePresentationSettingsDialog` controlled by a
  `showRolePresentationSettings` state value
* Open it from a `Settings2` icon button in the global rail header next to `Create group`; use an
  accessible label and title such as `Role presentation settings`
* Include a role selector sourced from `Object.entries(config.roles)` so unused roles remain
  editable
* Include icon and color selectors sourced from `RolePresentationIconSchema.options` and
  `RolePresentationColorSchema.options`
* Render a color swatch and icon preview instead of relying on enum text alone
* Include an optional short-name input with a 24-character limit; omit `shortName` when the trimmed
  value is empty
* For a role without `presentation`, leave required icon and color choices unset instead of
  silently inventing defaults
* Mirror the controlled form, `busy`, inline error, modal lifecycle, and submit handling used by
  `GroupSettingsDialog` and `AgentSettingsDialog`
* Keep the dialog open on failure. On success, `App.runAction` refreshes `config`, after which the
  existing `RoleIdentity` and terminal role consumers render the new values

## Active-run safety implications

Presentation-only updates should be allowed while agents are active.

* Existing guards reject group instruction changes, profile role or instruction changes, and
  membership role or instruction changes with HTTP 409
* Existing guards allow group names, profile names, and membership aliases to change during a run
* Icon, color, and short name do not change effective role selection, role instructions,
  permission policy, launch configuration, or terminal lifecycle. They match the live-safe naming
  category
* `updateRolePresentation` should not inspect active runs and should not call the runtime
  coordinator
* The method must replace only `presentation`. A broader `updateRole` endpoint would create an
  active-run hazard if instructions or `permissionPolicy` were later added without matching guards
* Store reconciliation is still required so in-memory projections and events remain consistent;
  the existing live-safe rename paths establish this pattern
* The runtime event is important for other connected portal instances. The initiating portal also
  refreshes explicitly through `runAction`
* Repeating the same full replacement is naturally idempotent. The portal's existing
  `commandInit` will still add an idempotency key even though current PATCH routes do not consume
  it

## Smallest test plan

1. Add one integration test to `apps/daemon/test/server.test.ts`. Start a membership run, PATCH a
   role presentation, expect HTTP 200, confirm the run remains active, and GET `/api/config` to
   verify the new presentation survived repository write and reload while all non-presentation
   role fields remained unchanged. In the same test, cover an invalid enum value as HTTP 400 and an
   unknown role as `role_not_found` HTTP 404.
2. Add one request-shape test to `apps/portal/src/api.test.ts`. Call
   `api.updateRolePresentation("reviewer/lead", ...)`, return a valid role definition fixture, and
   assert the encoded `/api/roles/reviewer%2Flead/presentation` URL, PATCH method, normalized body,
   and response parsing.
3. Add one interaction test to `apps/portal/src/App.test.tsx`. Extend `createClient` with
   `updateRolePresentation`, open the global role settings dialog, edit reviewer icon, color, and
   short name, save, and assert the exact client call. Mock the subsequent `loadConfig` result and
   assert the existing `RoleIdentity` reflects the refreshed short name and color.

No new `config.test.ts` case is needed because the daemon integration test exercises schema
validation, `ConfigRepository.#write`, reload, and the route together. No new terminal workspace
test is needed because existing coverage already verifies role color and short-name rendering.

## Clarifying questions

None. The recommended endpoint deliberately limits scope to presentation metadata. A future role
editor for names, instructions, descriptions, or permission policy should be designed separately
with explicit active-run rules.