---
title: Roles, prompt composition, and unread persistence research
description: Evidence for canonical roles, provider prompt injection, runtime restart behavior, and portal unread persistence
ms.date: 2026-08-11
ms.topic: reference
---

## Research questions

* Which files and symbols control reusable roles, instruction scopes, effective prompt composition, provider-native injection, role exposure, and active-run restart behavior?
* Which schema and migration changes would these features require?
* Which implementation phases and focused tests minimize risk?
* Which files and symbols control unread message bubble counts?
* Is message group sequence plus a persisted browser or client read cursor sufficient?
* Does the existing identity and authentication model favor server-side or browser-side read-state persistence?

## Findings

Status: Complete.

### Executive findings

* Nanasa has no role or instruction model today. Configuration stops at agent type,
  profile name, membership alias, and provider command. Runtime provisioning injects MCP
  and status integration immediately before tmux launch, which is the correct ownership
  point for provider-native prompt injection.
* Declarative `.nanasa/config.yaml` is authoritative for profiles and memberships and is
  projected into SQLite. A reusable role catalog and instruction file references belong in
  this configuration. Effective prompt text should be composed from repository files at
  launch, not copied into SQLite.
* Composition should have one provider-independent implementation. Recommended order is
  top-level instructions, canonical role instructions, profile instructions, membership
  instructions, then generated Nanasa identity and collaboration context. Preserve declared
  array order, normalize line endings, add fixed section delimiters, and hash the exact UTF-8
  bytes passed to the provider.
* Copilot CLI, Claude Code, and OpenCode have native named-agent selection. Pi has native
  system-prompt append support but no equivalent named main-agent abstraction. Provider
  adapters should consume the same generated effective prompt artifact.
* A prompt change cannot affect an already-running process. Current daemon restart recovery
  intentionally preserves a matching tmux pane, so safe rollout requires a persisted launch
  digest and an explicit, serialized generation replacement path. A daemon restart alone is
  not sufficient.
* Portal unread state is currently duplicated and memory-only. The group rail and message
  launcher use different cursors and different read semantics. One browser-local cursor store
  should drive both.
* Group sequence plus a persisted cursor is sufficient for the current retained-history model
  when unread count is clamped by `oldestRetainedGroupSeq`. `latestGroupSeq - cursor` alone is
  not sufficient after retention pruning or clear-history gaps.
* Persist read cursors in browser `localStorage`, not SQLite. Portal REST routes have no user
  authentication, portal messages hard-code `portal-operator`, and a server cursor would merge
  unrelated browsers into one reader. Server persistence should wait for a real authenticated
  operator or client identity.

### Current role and prompt data flow

1. `packages/contracts/src/index.ts` defines strict `NanasaConfigSchema`,
   `ConfiguredAgentProfileSchema`, and `ConfiguredMembershipSchema`. There are no role,
   instruction, or launch-digest fields.
2. `apps/daemon/src/config.ts` parses `.nanasa/config.yaml`, rejects unknown keys, resolves
   `cwd`, validates isolated agent homes, and produces canonical config. The current agent type
   transform intentionally drops legacy adapter, recovery, and capability fields.
3. `apps/daemon/src/config-repository.ts` atomically writes profile, group, and message changes.
   `TopologyService` calls `NanasaStore.reconcileTopology` after API mutations.
4. `NanasaStore.reconcileTopology` projects configured profiles and memberships into
   `agent_profiles` and `memberships`. `AgentProfile` and `GroupMembership` are then hydrated
   from SQLite for snapshots and launches.
5. `TmuxRuntime.startRun` calls `NanasaStore.createRunForMembership`, then
   `TmuxRuntime.#launchCreatedRun`. `TmuxRuntime.#launch` calls
   `AgentRuntimeProvisioner.provision(membership, profile)` immediately before constructing the
   tmux command and environment.
6. `AgentRuntimeProvisioner.provision` writes private provider configuration under
   `.nanasa/integrations`, adds MCP and status hooks, and returns the final command and
   environment. It currently receives only membership and profile, so no role or top-level
   config can reach the provider.
7. `createDaemon` captures `agentConfigHomes` in the provisioner at startup. It does not watch
   `.nanasa/config.yaml`; `/api/config` reloads the file for display, but runtime launch inputs
   remain the startup capture unless a daemon API mutation reconciles the store.

### Recommended configuration and composition model

Keep runtime provider selection separate from organizational role:

* Add a top-level `roles` record keyed by a bounded slug. Each role has a display name,
  optional description, and ordered repository-relative instruction file list.
* Add a top-level ordered `instructions` file list.
* Add an ordered `instructions` list to each configured agent profile.
* Add `roleId` and an ordered `instructions` list to each configured membership. Membership is
  the correct assignment point because one provider profile can serve different roles in
  different groups.
* Keep role definitions reusable and canonical. Reject unknown membership role IDs during
  cross-reference validation.
* Resolve only regular UTF-8 files beneath the real repository root. Reject NULs, lexical and
  symlink escapes, oversized files, duplicate references, and unsupported encodings. Reuse or
  extract the repository-boundary logic currently private in `config.ts`.
* Compose one immutable `EffectiveAgentPrompt` containing text, SHA-256 digest, role metadata,
  and ordered source metadata. Do not rely on JavaScript object-key iteration for precedence.
* Normalize CRLF to LF and ensure one trailing newline before hashing. Include stable section
  headings and source identifiers so equal inputs always produce equal bytes and diagnostics can
  identify the controlling scope.
* Do not store prompt content in SQLite. It may contain sensitive repository guidance. Store the
  digest and bounded source metadata needed for audit and replacement decisions.

Suggested owning module: `apps/daemon/src/effective-agent-prompt.ts`. It should be called by a
launch-context resolver shared by initial start and recovery. Avoid putting composition branches
inside each provider switch.

### Provider-native injection

Copilot CLI:

* Installed CLI supports `--agent`, `--no-custom-instructions`, and
  `--additional-mcp-config`.
* Generate a private `.agent.md` under the isolated `COPILOT_HOME/agents` with the composed body,
  then append `--no-custom-instructions --agent <generated-name>` to the existing launch command.
* Disabling automatic custom instructions avoids loading `AGENTS.md`, `CLAUDE.md`, and
  `.github` instructions a second time in provider-defined order. GitHub documents that the
  general precedence among multiple instruction files is undefined and that active sessions
  require restart after instruction changes.

Claude Code:

* Installed CLI supports `--agent`, `--agents`, `--system-prompt`, and
  `--append-system-prompt`.
* Generate a private main-agent Markdown file under `CLAUDE_CONFIG_DIR/agents` and launch with
  `--agent <generated-name>`. Claude documents that this replaces the main system prompt and
  persists on resume.
* Claude still loads `CLAUDE.md` through its normal context flow. If strict total-prompt
  determinism is required, the adapter must also suppress automatic customizations. `--bare`
  accepts explicit `--agents`, but the installed CLI does not expose an `@file` form for that
  JSON. Passing prompt JSON or text in argv creates size and process-list disclosure risks.
  Treat this as a provider limitation to resolve before claiming byte-for-byte total-context
  determinism.

Pi:

* Installed CLI supports repeatable `--append-system-prompt`, and provider documentation says a
  file path causes file contents to be appended.
* Launch with `--no-context-files --append-system-prompt <effective-prompt-path>` in addition to
  the existing MCP and status extensions. This is the cleanest deterministic adapter because it
  suppresses automatic `AGENTS.md` and `CLAUDE.md` discovery.

OpenCode:

* Installed CLI supports `--agent`; official configuration supports a named primary agent with
  `prompt: "{file:...}"`.
* Merge a generated primary agent entry into the existing private `opencode.json`, preserve user
  keys, point its prompt at the effective artifact, and append `--agent <generated-name>`.
* Verify whether project rule discovery can be disabled or explicitly replaced before claiming
  total-context determinism. The isolated XDG and OpenCode config homes prevent user-global
  leakage but do not by themselves prove repository rule suppression.

### Role exposure

The server should derive role from the authenticated membership, never trust reporter or MCP
input:

* Extend `GroupMembership` with `roleId`, and expose canonical role display data either in the
  portal config or as a small `RoleSummary` contract.
* Extend `AgentStatusSummarySchema` and `AgentStatusDetailSchema` with `roleId` and `roleName`.
  Populate them in `NanasaStore.#getAgentStatusDetail`; `agentStatusSummary` will then carry them
  into snapshots and status events.
* Extend `mcp-server.ts:listMembersResult` structured content and text with role ID/name.
  `listAgentStatusesResult` and `getAgentStatusResult` will inherit the status additions.
* In `group-tree.tsx`, show role in member rows and the status popover. Add role selection to the
  membership creation flow in `AddAgentForm`; do not make role part of provider profile creation.

### Schema and migration implications

Config can remain version 1 as a backward-compatible additive change if all new collections and
lists default empty and `roleId` is initially optional. Strict Zod schemas in both contracts and
`config.ts` must change together. Requiring a role for every membership should be a later config
version or a validation mode because existing repositories have no role value.

SQLite needs a version 4 migration if role is made part of canonical runtime objects and prompt
replacement is automatic:

* Add `role_id` and `instructions_json` to `memberships`.
* Add `instructions_json` to `agent_profiles`.
* Add nullable `effective_prompt_digest` and bounded prompt-source metadata to `runs`.
* Backfill lists as `[]` and role as `NULL`. For legacy active runs, treat a null digest as
  compatible only when the desired effective prompt is empty. A configured nonempty prompt must
  trigger one controlled replacement.
* Increment `DATABASE_SCHEMA_VERSION` and add a transactionally fenced migration after
  `#migrateMessageHistory`.

Top-level role definitions and instruction contents do not need normalized database tables because
configuration remains authoritative. If role is resolved only through `snapshot.config`, the role
columns can be deferred, but MCP/status code becomes coupled to configuration lookups and run
history cannot report the role that actually launched. Persisting role ID and prompt digest is the
safer operational model.

### Safe active-run replacement

Current `RunRuntimeCoordinator.reconcile` preserves any desired-running run for which
`TmuxRuntime.isCurrentRun` succeeds. Only `terminal_runtime_migration` forces replacement. A new
prompt therefore needs these semantics:

1. Resolve current desired launch context and digest before creating or recovering a run.
2. Persist the digest on the run before spawning its pane.
3. During serialized coordinator reconciliation, preserve a current pane only when its persisted
   digest equals the desired digest.
4. On mismatch, mark recovery reason `effective_prompt_changed`, stop ttyd, remove the linked view,
   terminate the generation-fenced owner pane, mark the old run failed/replaced, and create exactly
   one next generation with the new digest.
5. Reuse recovery cooldown and maximum-attempt behavior. Never launch the replacement before the
   old owned pane is verified dead, and never mutate an older generation after a newer one exists.
6. Publish explicit replacement lifecycle events so portal status explains why the terminal was
   restarted.

This should be a dedicated coordinator/runtime replacement operation, not a call to operator
`stopRun`, because operator stop changes desired state to stopped. `TmuxRuntime.recoverRun` already
contains most generation fencing and migration replacement behavior, but its forced-pane kill is
hard-coded to `terminal_runtime_migration` and should be generalized narrowly.

Manual config edits are not observed while the daemon runs. Minimal safe behavior is to apply new
prompts on daemon restart and API-driven reconciliation. Hot reload requires a later explicit
config-reload endpoint or file watcher that atomically reloads, validates, reconciles, computes all
affected digests, and then queues serialized replacements.

### Current unread data flow

* `NanasaStore.submitMessage` increments `groups.message_sequence` transactionally and assigns the
  result to `Message.groupSeq`.
* Retention deletes the oldest message rows but does not reset `message_sequence`.
  `clearMessageHistory` deletes all messages but also leaves the sequence monotonic.
* `getGroupMessageState` exposes latest sequence, oldest retained sequence, retained count, and
  delivery state. `/api/snapshot` omits message bodies but includes these group states.
* `App` owns an in-memory `seenMessageSequence` map for group badges. Selecting a group immediately
  advances that cursor even when the message overlay is closed.
* `MessageWorkspace` owns a second in-memory `seenSequence`. It initializes to the latest sequence
  at mount and advances only while the overlay is open. It computes its latest value from the
  currently loaded page rather than authoritative `messageState`.
* Both maps are lost on refresh. The existing `localStorage` code persists only overlay-open state
  and portal preferences.

### Recommended unread cursor model

Create one `useMessageReadCursors` hook and pass its count/cursor and `markReadThrough` callback to
both `App`/`GroupTree` and `MessageWorkspace`.

Persist records in `localStorage` under a new versioned key. Scope each record by repository
identity, group ID, and group `createdAt`; storing `createdAt` prevents a deleted and recreated
group with the same declarative ID from inheriting an obsolete high cursor. The repository root in
`configStatus` is already exposed to the portal and can namespace repositories served from the
same local origin.

For a state with retained messages, calculate:

`unread = latestGroupSeq - max(cursor, oldestRetainedGroupSeq - 1)`

Clamp the result to `[0, retainedMessageCount]`. When retained count is zero, unread is zero. This
handles clear-history and retention gaps. Mark read through authoritative
`messageState.latestGroupSeq` when the message overlay is open, not merely when a group is selected.
Advance cursors monotonically and ignore malformed, negative, noninteger, or future records tied to
a different `createdAt`.

Use a `storage` listener plus a same-tab custom event, following `usePortalPreferences`, so tabs
converge. Failure to access storage should fall back to an in-memory map without breaking the UI.

Sequence plus cursor is sufficient only for the current definition, where every retained group
message counts and deletion is oldest-first or all-at-once. It is not sufficient if unread later
filters out operator-authored messages, audience-invisible messages, message types, or arbitrary
individual deletions. Such filtering would require server queries/counts or a persisted set/range
model rather than simple subtraction.

### Minimal implementation phases

1. Add config contracts, secure instruction loading, canonical role validation, and the pure
   effective-prompt composer. Expose a digest in launch context but do not restart existing runs.
2. Add provider-specific generated artifacts and command flags for new runs. Make the provisioner
   obtain current validated config through a resolver rather than a startup-captured partial map.
3. Add role fields to memberships, MCP results, status contracts, and portal displays. Add SQLite
   version 4 role and run-digest migration.
4. Add serialized digest-mismatch replacement and startup reconciliation. Add hot reload only if
   live manual config edits are a product requirement.
5. Independently replace both unread maps with one browser-persisted cursor hook and authoritative
   group-state calculation.

## Evidence

### Local controlling files and symbols

* `packages/contracts/src/index.ts`: `NanasaConfigSchema`,
  `ConfiguredAgentProfileSchema`, `ConfiguredMembershipSchema`, `AgentProfileSchema`,
  `GroupMembershipSchema`, `AgentRunSchema`, `AgentStatusSummarySchema`,
  `AgentStatusDetailSchema`, `GroupMessageStateSchema`, and `PortalSnapshotSchema`
* `apps/daemon/src/config.ts`: `RawNanasaConfigSchema`, `parseNanasaConfigSource`,
  `assertInsideRepository`, and `loadNanasaConfig`
* `apps/daemon/src/config-repository.ts`: `ConfigRepository.#write` and `mutate`
* `apps/daemon/src/topology-service.ts`: `TopologyService.reconcile` and membership/profile
  mutations
* `apps/daemon/src/store.ts`: `DATABASE_SCHEMA_VERSION`, `reconcileTopology`,
  `createRunForMembership`, `#getAgentStatusDetail`, `getGroupMessageState`,
  `submitMessage`, `clearMessageHistory`, `getSnapshot`, and `#migrate`
* `apps/daemon/src/agent-runtime-provisioner.ts`: `AgentRuntimeProvisioner.provision`
* `apps/daemon/src/tmux-runtime.ts`: `startRun`, `recoverRun`, `#launchCreatedRun`, `#launch`, and
  `isCurrentRun`
* `apps/daemon/src/run-runtime-coordinator.ts`: `reconcile`, `#recoverMissingRun`, `#startRun`, and
  `#serialize`
* `apps/daemon/src/server.ts`: `createDaemon`, startup topology reconciliation, runtime provisioner
  construction, unauthenticated portal API routes, and snapshot message elision
* `apps/daemon/src/mcp-server.ts`: `listMembersResult`, `listAgentStatusesResult`, and
  `getAgentStatusResult`
* `apps/portal/src/App.tsx`: `seenMessageSequence`, `latestMessageSequence`, and `unreadCounts`
* `apps/portal/src/components/message-workspace.tsx`: `seenSequence`, `unreadCount`,
  `loadOverlayOpen`, and authoritative page loading
* `apps/portal/src/hooks/use-portal-preferences.ts`: existing versioned `localStorage`, cross-tab
  synchronization, and storage-failure pattern

### Provider references

* GitHub Copilot CLI installed help on 2026-08-11 confirms `--agent`,
  `--no-custom-instructions`, and `--additional-mcp-config`.
* [GitHub custom agents](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/create-custom-agents-for-cli)
  documents `.github/agents`, `~/.copilot/agents`, `.agent.md`, `--agent`, and restart after agent
  creation.
* [GitHub custom instructions](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-custom-instructions)
  documents automatic instruction discovery, undefined general precedence, and session restart
  after changes.
* Claude Code installed help on 2026-08-11 confirms `--agent`, `--agents`, `--system-prompt`,
  `--append-system-prompt`, and `--bare`.
* [Claude Code custom agents](https://code.claude.com/docs/en/sub-agents) documents main-session
  `--agent`, agent file scopes, replacement of the default system prompt, normal continued loading
  of `CLAUDE.md`, and resume behavior.
* Pi installed help and [Pi coding agent documentation](https://github.com/earendil-works/pi/tree/main/packages/coding-agent)
  confirm `--append-system-prompt`, file-content append behavior, and `--no-context-files`.
* OpenCode installed help confirms `--agent`. [OpenCode agents](https://opencode.ai/docs/agents/)
  documents primary agent configuration and `prompt: "{file:...}"`.

## Risks

* Provider-native agents do not guarantee identical total context across providers. Claude and
  OpenCode may still load repository rules unless explicitly suppressed. Document the guarantee as
  deterministic Nanasa-composed content until each adapter proves total-context isolation.
* Prompt text in argv is visible to process inspection and may exceed platform limits. Prefer
  private generated files and provider file references. Claude's strict bare-mode path needs a
  separate compatibility decision.
* Shared agent-type config homes can cause generated agent-name collisions between memberships.
  Use membership-derived bounded names and atomic private writes; never overwrite user-authored
  agents.
* Runtime provisioner configuration is currently captured at daemon startup. Adding composition
  without replacing this capture can launch stale roles after an API mutation.
* Restarting a working agent loses conversational state even if provider session files persist.
  Surface pending/restarting status and avoid unbounded restart loops.
* Persisting full prompt content or instruction paths in domain events can leak repository policy.
  Emit role IDs, digest prefixes, and source counts instead.
* Browser cursors can be manually altered or cleared. This is acceptable for presentation state,
  but they must never authorize message access or delivery.
* A global server-side cursor would be incorrect today because every browser is the same
  unauthenticated `portal-operator` and portal REST routes have no principal.
* Exact unread subtraction depends on retained sequences being contiguous. If arbitrary deletion
  is added, the server must expose an unread count query or retained sequence ranges.

## Recommended tests

* `packages/contracts/test/contracts.test.ts`: defaults, unknown role references, bounded role IDs,
  new membership/run/status fields, and backward-compatible legacy parsing
* `apps/daemon/test/config.test.ts`: strict role schema, ordered source preservation, path and
  symlink escape rejection, duplicate references, missing files, size limits, and stable digest
* New focused composer test: exact section order, LF normalization, stable bytes/digest, role
  lookup, and no provider branching
* `apps/daemon/test/agent-runtime-provisioner.test.ts`: exact Copilot/Claude/Pi/OpenCode generated
  files and argv, preservation of user config, private permissions, collision isolation, and no
  prompt text or token in command/config output where avoidable
* `apps/daemon/test/store.test.ts`: version 4 migration, role projection, digest hydration, legacy
  null digest behavior, and snapshot/status role exposure
* `apps/daemon/test/mcp-server.test.ts`: role in `nanasa.list_members`, list statuses, and detail
  structured content; verify caller cannot forge role
* `apps/daemon/test/run-runtime-coordinator.test.ts`: matching digest preserves pane; mismatched
  digest stops ttyd/view/owner in order and creates one generation; failed replacement backs off;
  stale generations are fenced; repeated reconcile does not duplicate replacement
* `test/acceptance/restart-recovery.spec.ts`: unchanged prompt preserves run ID, generation, and
  pane; changed prompt creates one replacement generation and reports the reason
* New portal cursor-hook tests: malformed storage, unavailable storage, refresh/remount,
  already-read exclusion, new-message increment, cross-tab storage event, repository/group
  isolation, recreated group ID, clear-history gap, retention clamp, and 99+ display
* `apps/portal/src/App.test.tsx`: group badge and launcher use the same cursor; selecting a group
  while messages are closed does not mark it read; opening messages marks through authoritative
  latest sequence
* Browser acceptance test: read messages, refresh and retain zero unread; receive a newer message
  and show one unread; a separate browser context starts with independent read state

## Clarifying questions

* Does product language require every membership to have exactly one role, or may roles be absent
  during migration? The recommended first schema makes `roleId` optional for compatibility.
* Must a manual edit to `.nanasa/config.yaml` restart affected runs without daemon restart? If yes,
  config watching or an explicit reload API belongs in the initial delivery rather than a later
  phase.
* Does deterministic effective prompt mean only Nanasa-composed role/instruction bytes, or the
  provider's complete final context after its built-in and repository discovery? The latter needs
  provider-specific suppression work, especially for Claude Code and OpenCode.
