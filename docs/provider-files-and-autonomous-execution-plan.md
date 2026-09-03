---
title: Provider files and autonomous execution implementation plan
description: Plan for scoped provider-native MCP files and trusted adapter-owned autonomous execution profiles
---

## Goal

Allow consumers to select provider-native MCP configuration files and
well-known autonomous execution behavior without replacing a built-in provider
command.

Nanasa will remain responsible for selecting configuration by scope, resolving
an effective policy, snapshotting referenced files, and composing its generated
prompt, reporter, permission floor, and coordination MCP configuration. Each
provider will continue to own the syntax and semantics of its MCP file.

The change must produce unattended agents without treating arbitrary command
arguments as trusted adapter behavior. It must also preserve the existing
custom-command consent boundary for wrappers and executable replacement
commands.

## User outcome

A consumer can:

1. Define a reusable autonomous execution profile in `.nanasa/config.yaml`.
2. Assign the profile to each provider integration without writing native CLI
   flags.
3. Reference provider-native MCP files at integration scope.
4. Append or replace those files for one configured agent.
5. Keep a reviewer autonomous while retaining the role's read-only denial
   floor.
6. Start built-in providers without a custom-command consent request.
7. Inspect which profile, files, hashes, and provider translations apply before
   starting an agent.
8. Opt into capability-expanding behavior through operator-owned daemon policy
   rather than repository configuration granting authority to itself.

## Current behavior

### Configuration has no provider-file or execution-profile contract

The strict authored schemas in
[`packages/contracts/src/config.ts`](../packages/contracts/src/config.ts) and
[`apps/daemon/src/config-loader.ts`](../apps/daemon/src/config-loader.ts) accept
provider kind, command, launcher, state, credentials, model, recovery,
extensions, and environment at integration scope. A configured agent can select
an integration, role, model, instructions, attention policy, checkout, and
order. Unknown fields are rejected.

The only provider-independent permission policy is:

```ts
type RolePermissionPolicy = "inherit" | "read-only";
```

`inherit` preserves provider defaults. It does not approve tools or suppress
provider questions. `read-only` is a denial floor and cannot be weakened by a
less restrictive agent or integration setting.

### Built-in commands and custom commands have different trust paths

[`apps/daemon/src/config-loader.ts`](../apps/daemon/src/config-loader.ts)
derives these commands when an authored integration omits `command`:

| Provider kind | Built-in command |
|---------------|------------------|
| `copilot`     | `copilot`        |
| `claude-code` | `claude`         |
| `pi`          | `pi`             |
| `opencode`    | `opencode`       |

An explicit `command` produces `commandSource: custom` and requires a
`launcher`. The runtime gate in
[`apps/daemon/src/runtime-launch-consent-gate.ts`](../apps/daemon/src/runtime-launch-consent-gate.ts)
allows a built-in command immediately. A custom command requires a durable
decision over the exact consent subject before credentials or generated launch
state are created.

Consumers can place native flags in an explicit command today, but doing so
changes the command to `custom`. This is the wrong mechanism for trusted,
well-known options such as Copilot `--autopilot`, Claude Code permission mode,
or OpenCode `--auto`.

### Provider arguments already come from trusted adapters

[`apps/daemon/src/providers/provider-snapshot-evaluator.ts`](../apps/daemon/src/providers/provider-snapshot-evaluator.ts)
builds adapter-owned arguments for prompts, reporters, models, native session
recovery, read-only denial floors, and Nanasa MCP registration. It appends those
arguments to the configured command or exposes them through the declared
launcher environment strategy.

This provides the precedent for autonomous profiles. The consumer selects a
bounded semantic option, the active provider snapshot declares support, and the
evaluator emits known arguments without accepting a free-form argument list.

### Nanasa MCP registration is global and adapter-owned

`nanasa start --mcp` or `NANASA_MCP_ENABLED=true` enables one authenticated
Nanasa coordination endpoint. Startup configuration is resolved in
[`apps/daemon/src/index.ts`](../apps/daemon/src/index.ts), and each run receives
a capability bound to its group, member, run, and generation.

The evaluator currently registers the endpoint as follows:

| Provider      | Current registration mechanism                                      |
|---------------|---------------------------------------------------------------------|
| Copilot       | `--additional-mcp-config @<overlay>/mcp/config.json`                 |
| Claude Code   | `--mcp-config <overlay>/mcp.json`                                   |
| Pi            | Pinned MCP adapter and `--mcp-config <overlay>/mcp.json`             |
| OpenCode      | Generated `mcp.nanasa` entry in `OPENCODE_CONFIG_CONTENT`            |

The generated files contain only Nanasa-owned registration. There is no YAML
field for selecting additional provider-native MCP files.

### Provider state scope is not configuration inheritance

[`packages/contracts/src/provider.ts`](../packages/contracts/src/provider.ts)
defines membership, integration, and custom provider-state homes.
[`apps/daemon/src/provider-state-home.ts`](../apps/daemon/src/provider-state-home.ts)
maps those policies to isolated directories under `.nanasa/integrations`.

State scope controls where provider authentication, sessions, preferences, and
provider-owned files live. It must not be reused to describe how repository
configuration references inherit. Provider-file inheritance is a separate
contract.

### Native providers have different autonomous controls

The currently certified provider families expose different controls:

| Provider      | Relevant native behavior                                                |
|---------------|-------------------------------------------------------------------------|
| Copilot       | Autopilot continuation, disabled questions, and explicit tool/path/URL grants |
| Claude Code   | Permission modes, including `auto` and unrestricted bypass             |
| Pi            | Tool availability and project-file trust rather than one general bypass flag |
| OpenCode      | Automatic approval for operations not explicitly denied                |

These controls are not semantically equivalent. A single opaque
`autonomous: true` flag would hide material differences and prevent capability
validation.

## Product decisions

### Keep MCP definitions provider-native

Nanasa will not introduce a common MCP server schema. Consumers author files in
the format expected by the selected provider. Nanasa stores only validated
references and immutable content snapshots.

This boundary avoids lagging provider-specific transports, OAuth fields, tool
filters, and extension settings. It also prevents the main Nanasa configuration
schema from becoming a partial MCP compatibility layer.

### Support integration and agent scopes first

The first release supports provider files at:

* Integration scope, applying to every agent assigned to the integration.
* Configured-agent scope, appending to or replacing the integration selection.

Role scope is deferred. Roles can be shared across provider kinds, so a native
file attached directly to a role would either be ambiguous or require a nested
provider-kind map. Group scope is also deferred until a concrete use case
justifies another inheritance layer.

The effective order is:

```text
integration provider files < configured-agent provider files < Nanasa-owned overlay
```

Nanasa-owned registration remains independent. An agent-level `replace` removes
inherited consumer files but does not remove the Nanasa coordination MCP entry.

### Keep built-in commands built in

Selecting an execution profile or provider file does not author `command` and
does not change `commandSource`. The active adapter translates the effective
selection into its closed launch strategy.

As a result, these options do not create a custom-command consent request. An
explicit command or wrapper continues to use the existing custom-launch consent
workflow.

### Separate autonomy from permission floors

Execution profiles describe continuation and approval behavior. Role policy
continues to impose a denial floor.

The merge is restrictive:

```text
effective capabilities = execution profile grants intersect role permission floor
```

An autonomous reviewer can use every allowed read-only tool without prompting,
but an unrestricted profile cannot restore edit, write, or shell operations
denied by a read-only role.

### Require operator-owned authorization for capability expansion

Repository configuration can request autonomous behavior, but it cannot grant
itself unrestricted filesystem, network, or tool authority. An agent may be
able to modify repository files, including `.nanasa/config.yaml` and referenced
provider files.

Add daemon-owned policy outside repository configuration. The initial policy
supports:

```text
supervised
autonomous-repository
autonomous-unrestricted
```

`supervised` is always allowed. `autonomous-repository` and
`autonomous-unrestricted` require an operator deployment allowlist. A package
CLI flag and equivalent environment setting may populate that allowlist, but
the repository configuration cannot.

When a requested profile is not allowed, startup returns a stable policy error
instead of creating an interactive consent item. This lets an operator configure
an unattended installation once while preventing a checked-out branch from
silently elevating itself.

### Treat provider files as executable configuration

A provider-native MCP file may launch a stdio process, interpolate environment
variables, connect to a remote service, or expose destructive tools. Because
Nanasa deliberately does not normalize the file format, it cannot safely infer
that a file is read-only.

The daemon policy therefore controls whether repository provider files are
allowed. When enabled, every selected file still enters immutable launch
provenance by content digest. Changing content changes the launch digest and
the next run uses a new overlay snapshot.

The first release does not create a second interactive provider-file consent
screen. Deployments that do not authorize repository provider files fail closed
with a typed error.

## Configuration contract

### Define execution profiles

Add a strict top-level `executionProfiles` record:

```yaml
executionProfiles:
  autonomous:
    continuation: autonomous
    questions: disabled
    approvals: unrestricted
```

Initial fields are:

| Field          | Values                                      | Purpose                                      |
|----------------|---------------------------------------------|----------------------------------------------|
| `continuation` | `interactive`, `autonomous`                 | Controls provider continuation behavior       |
| `questions`    | `enabled`, `disabled`                       | Controls provider-initiated user questions    |
| `approvals`    | `provider-default`, `allow-known`, `unrestricted` | Controls native tool approval behavior    |

Keep the profile provider-independent. Provider snapshots declare which values
they support and how accurately they can enforce them. Configuration loading
validates references, while runtime capability negotiation validates the
selected profile against the active provider snapshot.

### Reference a profile from an integration

Add optional `executionProfile` to `IntegrationConfigSchema` and its authored
counterpart:

```yaml
integrations:
  copilot:
    name: GitHub Copilot
    kind: copilot
    executionProfile: autonomous
```

Omission preserves current provider behavior. This keeps existing version 2
configuration valid and avoids a migration for supervised installations.

Do not add an agent-level execution-profile override in the first release.
Consumers can create a second integration of the same provider kind when two
agents need materially different execution authority. This keeps authority
selection visible at the integration boundary and avoids accidental privilege
changes in a single agent stanza.

### Add scoped provider-file references

Add this strict type to integrations and configured agents:

```ts
interface ProviderFileSelection {
  mcp: {
    mode: "append" | "replace" | "disabled";
    paths: readonly string[];
  };
}
```

The authored YAML is:

```yaml
integrations:
  copilot:
    name: GitHub Copilot
    kind: copilot
    providerFiles:
      mcp:
        mode: append
        paths:
          - .nanasa/providers/copilot/mcp.json

groups:
  backend-team:
    name: Backend Team
    agents:
      worker:
        memberId: worker
        name: Worker
        integrationId: copilot
        providerFiles:
          mcp:
            mode: append
            paths:
              - .nanasa/providers/copilot/worker.mcp.json
```

Default `mode` to `append` when `mcp` is present. Default `providerFiles` to an
empty selection. `disabled` requires an empty `paths` list and disables only
consumer files. `replace` requires at least one path.

### Validate paths and source files

Create a provider-file path schema separate from `InstructionPathSchema`.
Require each path to:

* Be repository-relative and free of traversal and NUL characters.
* Use forward slashes in authored configuration.
* Reference a regular file owned by the daemon user.
* Remain beneath the repository after resolving symlinks.
* Use an allowed provider configuration suffix such as `.json` or `.jsonc`.
* Remain within a bounded path length, file count, individual size, and combined
  size.

Reject duplicate effective paths after normalization. Read files with the same
no-follow, identity-checking pattern used by
[`apps/daemon/src/custom-launch-consent-subject.ts`](../apps/daemon/src/custom-launch-consent-subject.ts)
so content cannot change between inspection and snapshot creation.

Do not expose file content through the API, portal, logs, or consent records.

## Effective policy resolution

### Add a focused resolver

Add `apps/daemon/src/provider-policy-resolver.ts` to resolve:

* The integration's execution-profile reference.
* The immutable execution-profile definition.
* Integration provider files.
* Configured-agent provider-file mode and paths.
* The role permission floor.
* The operator-owned daemon authorization policy.

Return a frozen provider policy containing source metadata for diagnostics:

```ts
interface EffectiveProviderPolicy {
  executionProfileId?: string;
  executionProfile?: ExecutionProfile;
  providerFiles: readonly ResolvedProviderFile[];
  permissionFloor: "inherit" | "read-only";
  authorization: {
    executionProfileAllowed: boolean;
    providerFilesAllowed: boolean;
  };
}
```

Resolve this policy before creating a run. Missing profiles, unsupported profile
values, unauthorized capability expansion, and invalid files must not consume a
run generation or create private provider state.

### Preserve source information

Each resolved file records:

```text
path
scope: integration | agent
content digest
byte size
```

Diagnostics and dry-run output can show these fields without revealing file
content. Profile fields report whether their source is the profile definition,
the provider default, or the role denial floor.

## Provider capability contract

### Extend provider snapshots

Extend the provider capability contract in
[`packages/contracts/src/provider-runtime.ts`](../packages/contracts/src/provider-runtime.ts)
and the resolved adapter model in
[`apps/daemon/src/providers/resolved-provider-adapter.ts`](../apps/daemon/src/providers/resolved-provider-adapter.ts).

Add an execution capability that declares:

```text
supported continuation values
supported question values
supported approval values
native translation version
whether read-only remains independently enforced
```

Add a provider-file capability that declares:

```text
supported file kinds
accepted suffixes
composition strategy
maximum selected files and bytes
reserved server names
```

Provider package validation rejects incomplete or contradictory declarations.
Snapshots remain immutable and content-addressed, so changing translation policy
produces a new provider generation.

### Add built-in execution translations

Update
[`apps/daemon/src/providers/builtin-provider-packages.ts`](../apps/daemon/src/providers/builtin-provider-packages.ts)
and
[`apps/daemon/src/providers/builtin-provider-package-catalog.ts`](../apps/daemon/src/providers/builtin-provider-package-catalog.ts)
with explicit translations.

The initial intended mappings are:

| Provider      | Autonomous translation                                                  |
|---------------|-------------------------------------------------------------------------|
| Copilot       | Autopilot continuation, disabled ask-user tool, and selected approval grants |
| Claude Code   | Native automatic or unrestricted permission mode according to the profile |
| Pi            | Native tool selection plus adapter settings; reject unsupported semantics |
| OpenCode      | Native automatic approval while preserving explicit denial policy       |

Do not silently drop an unsupported field. Fail with
`execution_profile_unsupported` and identify the provider and field. This is
especially important for Pi, which does not expose one direct equivalent for
every other provider's permission mode.

### Preserve read-only enforcement

Generate autonomous arguments first, then apply the existing role denial floor.
Provider-specific output must ensure deny rules win over grants.

Add conformance assertions showing that an autonomous read-only profile cannot
write through:

* Copilot denied tools.
* Claude Code denied Edit, Write, and Bash tools.
* The Pi read-only extension.
* OpenCode edit and bash denial policy.

## Provider-file composition

### Snapshot files into the generated overlay

Do not launch providers against mutable repository paths. During overlay
planning, copy the already-verified bytes into a revisioned directory such as:

```text
<overlay>/provider-files/mcp/00-integration.json
<overlay>/provider-files/mcp/01-agent.json
```

Record path, source scope, source digest, overlay-relative path, and ownership
kind in the overlay manifest. Reuse
[`apps/daemon/src/providers/provider-overlay-repository.ts`](../apps/daemon/src/providers/provider-overlay-repository.ts)
for staging and atomic activation.

The overlay content digest must include the copied bytes and composition order.
Recovery uses the committed overlay rather than rereading repository files for
an existing run.

### Compose Copilot files

Emit one `--additional-mcp-config @<overlay-file>` argument for every selected
consumer file, in effective order. Emit Nanasa's generated MCP argument last.

Copilot supports repeated additional MCP configuration arguments. Keep the
generated `nanasa` entry in its existing dedicated file so consumer files do not
become Nanasa-owned content.

### Compose Claude Code files

Pass selected overlay files through Claude Code's native `--mcp-config`
mechanism in effective order, followed by the Nanasa-owned MCP file. Do not add
`--strict-mcp-config`; existing provider-owned user configuration must retain
its current behavior.

Add certification coverage for multiple files because native merge and
same-name precedence are provider-version-sensitive.

### Compose Pi files

Keep the pinned `pi-mcp-adapter` as the only MCP extension. Extend the
adapter-owned generated root configuration so it composes selected files using
the adapter's supported file/import model, then adds the Nanasa server at the
highest reserved-name precedence.

Do not emit multiple unrelated `--mcp-config` flags and depend on undocumented
last-argument behavior. Preserve current `directTools: true` and
`hostConfigDiscovery: off` settings unless the provider capability version
explicitly changes them.

### Compose OpenCode files

OpenCode currently receives Nanasa-owned configuration through
`OPENCODE_CONFIG_CONTENT`. Add an adapter composition step that reads the
selected native JSON or JSONC snapshots, applies OpenCode's merge order, and
then inserts Nanasa-owned plugin, agent, permission, and MCP fields.

The generated values must win for reserved Nanasa namespaces. Consumer values
outside those namespaces retain native OpenCode semantics. Continue setting the
isolated XDG and TUI paths already declared by the provider snapshot.

### Reserve Nanasa-owned identities

Reject consumer files that define the `nanasa` MCP server or overwrite a
Nanasa-owned generated agent, reporter plugin, hook, or extension identity.

This requires a narrow provider-specific inspection step. It does not make
Nanasa responsible for validating the complete provider file. Each adapter
checks only its reserved namespaces and leaves all other fields opaque.

## Runtime and provenance changes

### Extend runtime planning input

Update
[`apps/daemon/src/provider-runtime-provisioner.ts`](../apps/daemon/src/provider-runtime-provisioner.ts)
to resolve the effective provider policy before preview and binding. Pass the
execution profile and immutable provider-file snapshots into
[`apps/daemon/src/providers/provider-bound-runtime-planner.ts`](../apps/daemon/src/providers/provider-bound-runtime-planner.ts).

Update `ProviderOverlayContext`, `SnapshotLaunchInput`, overlay recipes, and
launch selection contracts so preview and committed planning use the same
inputs. Avoid a preview path that validates different bytes from the committed
overlay.

### Extend launch identity

Add these fields to final launch provenance:

```text
execution profile ID and canonical profile digest
operator authorization policy digest
ordered provider-file source paths and content digests
provider-file composition strategy version
effective permission floor
```

Do not include file contents, environment values, credentials, MCP tokens, or
generated run paths in public responses.

Provider update reconciliation treats a changed adapter translation or
composition strategy as a provider snapshot update. A changed selected file
applies to the next run or explicit restart and receives a new final launch
digest.

### Leave custom-command consent intact

Do not add execution profiles or provider files to
`CustomLaunchConsentSubject` when the command is built in. They are authorized
through provider capability validation and daemon policy instead.

For a true custom command, retain existing consent and add the effective
execution profile ID plus ordered provider-file digests to the stable subject.
A wrapper can discard generated arguments or load files differently, so changes
to either selection must stale the previous custom-launch decision.

## Errors and diagnostics

Add stable domain errors:

| Code                                      | Condition                                              |
|-------------------------------------------|--------------------------------------------------------|
| `execution_profile_not_found`             | An integration references an unknown profile           |
| `execution_profile_unsupported`           | The active provider cannot enforce a selected field     |
| `execution_profile_not_authorized`        | Daemon policy disallows the requested authority         |
| `provider_file_invalid`                   | A path, file type, owner, size, or syntax check fails   |
| `provider_file_not_authorized`            | Daemon policy disallows repository provider files       |
| `provider_file_reserved_identity`         | A file defines a Nanasa-owned identity                  |
| `provider_file_composition_unsupported`   | The provider cannot compose the effective selection     |

`doctor` should validate static references and active provider capabilities.
A new dry-run or explain command should show the effective policy without
starting a process:

```bash
nanasa config explain-agent <group-id> <agent-id>
```

Output includes profile fields, permission floor, provider translation names,
provider-file paths, scopes, hashes, and authorization status. It excludes
provider-file content and secret values.

## Portal behavior

The first release does not add an editor for profiles or provider files. The
portal remains a projection of repository configuration.

Add read-only details to the agent setup or settings surface:

* Effective execution profile and authorization status.
* Effective role permission floor.
* Provider-file paths, scopes, and abbreviated content digests.
* A clear error when the active provider cannot implement the profile.

Do not present typed adapter-owned options as custom launch consent. Continue to
show the existing consent pane only for an authored custom command.

## Documentation and examples

Update:

* [`docs/next/guides/configuration.md`](next/guides/configuration.md) with profile
  and provider-file inheritance.
* [`docs/next/guides/providers.md`](next/guides/providers.md) with native
  translation and composition behavior.
* [`docs/next/guides/messaging-and-mcp.md`](next/guides/messaging-and-mcp.md) to
  distinguish Nanasa coordination MCP from consumer provider files.
* [`docs/next/concepts/security.md`](next/concepts/security.md) with daemon-owned
  authorization and executable provider-file risks.
* [`docs/next/troubleshooting/providers.md`](next/troubleshooting/providers.md)
  with unsupported-profile and composition failures.
* [`examples/multi-coding-agents/.nanasa/config.yaml`](../examples/multi-coding-agents/.nanasa/config.yaml)
  so every integration selects the autonomous profile and its provider-native
  MCP file.
* [`examples/multi-coding-agents/README.md`](../examples/multi-coding-agents/README.md)
  with daemon authorization prerequisites and expected provider behavior.

Regenerate the checked-in configuration schema and reference documentation with
the existing documentation generator. Do not hand-edit generated reference
files.

## Testing strategy

### Contract and configuration tests

Extend [`packages/contracts/test/contracts.test.ts`](../packages/contracts/test/contracts.test.ts)
and [`apps/daemon/test/config.test.ts`](../apps/daemon/test/config.test.ts) to
cover:

* Strict profile definitions and references.
* Backward-compatible omission defaults.
* Integration and agent provider-file selections.
* Append, replace, and disabled resolution.
* Missing profiles, duplicate paths, traversal, symlinks, ownership, and size
  bounds.
* Rejection of an agent-level execution-profile field in the first release.

### Resolver and authorization tests

Add `apps/daemon/test/provider-policy-resolver.test.ts` for:

* Integration-to-agent file inheritance.
* Role read-only floors winning over autonomous grants.
* Daemon authorization for each execution authority level.
* Provider-file authorization independent of repository requests.
* Stable source metadata and canonical profile digests.
* Failures occurring before run creation and provider-state provisioning.

### Provider golden and conformance tests

Extend
[`apps/daemon/test/built-in-launch-goldens.test.ts`](../apps/daemon/test/built-in-launch-goldens.test.ts)
and
[`apps/daemon/test/built-in-provider-snapshot-conformance.test.ts`](../apps/daemon/test/built-in-provider-snapshot-conformance.test.ts)
with a matrix for every built-in provider:

* Supervised without consumer MCP files.
* Autonomous with one integration file.
* Autonomous with integration and agent files.
* Autonomous read-only with denial precedence.
* Nanasa MCP disabled and enabled.
* Unsupported semantic fields.
* Reserved `nanasa` identity rejection.

Assert complete command arrays, environment names, generated files, ownership
kinds, composition order, and content digests.

### Consent and provenance tests

Extend
[`apps/daemon/test/runtime-launch-consent-gate.test.ts`](../apps/daemon/test/runtime-launch-consent-gate.test.ts)
to prove:

* A built-in command with an authorized execution profile does not create a
  custom-launch request.
* Built-in provider files do not change `commandSource`.
* A custom command still requires consent.
* Changing profile or provider-file digests stales custom-command consent.
* Unauthorized profiles and files fail without creating a consent request or
  run.

Extend provider snapshot persistence and run-binding tests to verify that
profile and file digests survive daemon restart and remain immutable for an
existing run.

### Documentation and example tests

Extend
[`apps/daemon/test/documentation-examples.test.ts`](../apps/daemon/test/documentation-examples.test.ts)
to parse the updated example, resolve all four provider profiles, and verify the
reviewer remains read-only.

Run focused provider certification for Copilot, Claude Code, Pi, and OpenCode.
Native merge behavior is version-sensitive and cannot be established by unit
goldens alone.

## Implementation phases

### Phase 1: Contracts and effective policy

1. Add execution-profile and provider-file schemas to the contracts package.
2. Extend authored and normalized configuration schemas.
3. Add cross-reference, path, and bounded-file validation.
4. Implement the effective provider policy resolver.
5. Add daemon-owned authorization configuration and typed errors.
6. Complete contract, loader, resolver, and authorization tests.

Exit criteria: configuration resolves deterministic immutable policy before run
creation, and existing version 2 files remain valid.

### Phase 2: Provider capabilities and launch planning

1. Extend provider capability declarations and validation.
2. Add built-in autonomous translations for all four providers.
3. Snapshot selected files into generated overlays.
4. Implement provider-specific MCP composition.
5. Apply role denial floors after autonomous grants.
6. Extend launch goldens and provider conformance tests.

Exit criteria: every built-in provider produces deterministic launch state for
supervised, autonomous, and autonomous read-only cases.

### Phase 3: Provenance, recovery, and consent integration

1. Extend launch selection and run-binding provenance.
2. Persist ordered file and profile digests without file contents.
3. Keep built-in runs outside custom-command consent.
4. Extend custom consent subjects for effective profile and file changes.
5. Verify restart, native recovery, and provider-update reconciliation.

Exit criteria: daemon restarts preserve exact launch evidence, and no authority
change reuses stale custom-launch trust.

### Phase 4: Operator surfaces and documentation

1. Add `doctor` checks and the effective-policy explain command.
2. Add read-only effective policy details to the portal.
3. Update the multi-coding-agents example with autonomous integrations.
4. Update guides, security documentation, and troubleshooting.
5. Regenerate schemas and references.
6. Run the full static, unit, package, acceptance, and provider certification
   suites.

Exit criteria: consumers can configure and diagnose unattended agents without
knowing provider-native launch flags, while MCP server definitions remain in
provider-owned files.

## Acceptance criteria

The implementation is complete when:

* Existing configurations without new fields retain current launch behavior.
* All four built-in providers accept a supported autonomous profile without an
  authored command.
* Typed adapter-owned options do not trigger custom-command consent.
* Repository configuration cannot enable unauthorized execution authority or
  provider files by itself.
* Integration and agent provider-file selections resolve with deterministic
  append, replace, and disabled semantics.
* Providers launch from immutable overlay copies rather than mutable repository
  files.
* Consumer files cannot replace the Nanasa coordination MCP identity.
* A read-only role remains read-only under every autonomous profile.
* Final launch provenance records profile and provider-file digests without
  leaking content or credentials.
* `doctor` and explain output identify unsupported mappings before process
  launch.
* The multi-coding-agents example starts every agent with an autonomous profile
  after operator-owned daemon authorization is enabled.

## Deferred work

The first release does not include:

* A Nanasa-native MCP server definition schema.
* Free-form provider argument arrays on built-in integrations.
* Role-scoped or group-scoped provider-native files.
* Agent-level execution-profile overrides.
* Portal editing of repository profiles or provider files.
* Automatic conversion between Copilot, Claude Code, Pi, and OpenCode MCP
  formats.
* Content-level safety classification of arbitrary provider files.