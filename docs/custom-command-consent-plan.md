---
title: Custom command consent implementation plan
description: Plan for replacing configured-command allowlists with durable operator consent and declarative launcher strategies
---

## Goal

Allow repository-defined provider launch commands without maintaining exact
command allowlists in trusted provider snapshots. Keep built-in launches
frictionless, require informed human consent before a custom command receives
provider or Nanasa credentials, and reuse that consent until a
security-relevant launch property changes.

Move the Claude Code gateway wrapper from the example Makefile into
`examples/multi-coding-agents/bin/claude-copilot`. The script will accept normal
provider arguments and end with `exec claude "$@"`, allowing the general custom
launcher path to replace the current `make claude-copilot` exception.

## Current state

### Optional commands are a completed prerequisite

Authored integrations can omit `command`. The configuration loader derives the
built-in executable from `kind`:

| Provider kind | Default command |
|---------------|-----------------|
| `copilot` | `copilot` |
| `claude-code` | `claude` |
| `pi` | `pi` |
| `opencode` | `opencode` |

The normalized runtime configuration still contains a concrete command. The
template and public examples omit redundant built-in commands. The
multi-coding-agents example retains an explicit command only for its Claude
gateway wrapper.

### Configured-command matching has two responsibilities

The active provider snapshot currently uses `configuredCommandMatchers` to:

1. Reject configured commands that are not in a provider-owned allowlist.
2. Detect a recognized wrapper and decide how generated provider arguments are
   inserted.

These responsibilities must be separated. Consent replaces command
authorization. A declarative launcher strategy replaces wrapper detection and
argument insertion.

### Observed-process matching is a separate boundary

`observedProcessMatchers` determine whether the launched process tree contains
the expected provider process. They support status, recovery, and process
authority. This plan retains observed-process matching.

### Trust persistence exists but is not a consent workflow

`RepositoryTrustService` can digest a launch manifest and store durable trust
receipts. Runtime enforcement is optional and currently occurs after run
creation and provider planning. The HTTP API exposes only trust-receipt listing.

The existing manifest also includes generated command and overlay identities
that may contain run-specific paths. It is not a stable subject for one-time
custom-command consent.

## Product behavior

### Built-in launch

An integration with no authored `command` uses its provider's built-in
executable and argument strategy. It starts without custom-command consent:

```yaml
integrations:
  claude:
    name: Claude Code
    kind: claude-code
```

### Custom launch

An authored `command` opts into a custom launcher:

```yaml
integrations:
  claude-copilot:
    name: Claude Code through GitHub Copilot
    kind: claude-code
    command: [sh, bin/claude-copilot]
    launcher:
      providerArguments: append
```

The first start computes a stable consent subject. If no matching trusted
receipt exists, Nanasa creates a pending launch-consent request and does not
create a provider process, bind credentials, or write private launch overlays.

### In-place portal consent

The selected member's terminal pane displays a launch-consent state before a
PTY exists. The view contains:

* Agent alias and role
* Provider kind and adapter identity
* Exact authored command and arguments
* Working directory
* Launcher argument strategy
* Credential mode without credential values
* Names of environment variables that will be available
* Generated prompt, MCP, and reporter access categories
* Effective permission floor and whether it can be enforced

The actions are `Cancel` and `Trust and start`. The same request appears in the
Attention workspace as an approval item. Only an authenticated human operator
can approve or deny it.

### Durable approval

Approval is reused for starts, restarts, recovery, and daemon restarts while the
stable consent digest remains unchanged. Approval is requested again when any
of these properties change:

* Repository identity
* Integration ID
* Provider kind
* Adapter ID or security-relevant adapter version
* Authored command or argument order
* Launcher argument strategy
* Working directory
* Integration environment variable names
* Credential reference or mode
* Effective permission floor
* Provider capability needed to enforce that floor

Run IDs, generations, terminal sizes, tokens, timestamps, generated overlay
directories, status, aliases, colors, and unrelated configuration do not affect
the consent digest.

### Start all

`Start all` starts members using built-in commands immediately and returns one
pending consent outcome for each untrusted custom launcher. The portal displays
a consolidated approval surface. After approval, it retries the group start;
already-running members remain unchanged.

### Denial and cancellation

Denial records a durable denied receipt for the exact digest and leaves the
member stopped with approval-related attention. A later start does not reopen
the same prompt until the operator explicitly revisits or revokes the decision.

Cancel dismisses the current request without storing a durable denial. A later
start can create a new pending request for the same digest.

## Configuration contract

### Preserve authored command origin

Normalization currently loses whether `command` was authored or derived. Add a
normalized launch-origin field or equivalent internal metadata:

```ts
type IntegrationCommandSource = "builtin" | "custom";
```

This field is derived by the loader and must not be authorable as an arbitrary
claim. Runtime consent policy uses this source rather than comparing the command
text to a default executable.

### Add a launcher strategy

Add an authored `launcher` object that is allowed only with an explicit
`command`:

```yaml
launcher:
  providerArguments: append
```

Initial strategies:

| Strategy | Behavior |
|----------|----------|
| `append` | Append generated provider arguments to the configured command |
| `environment` | Put a shell-escaped argument string in one declared environment variable |

The environment strategy requires a validated variable name:

```yaml
launcher:
  providerArguments:
    kind: environment
    name: CLAUDE_ARGS
```

Prefer `append` for executable scripts. Keep `environment` for wrappers that
cannot accept positional arguments directly. Reject `launcher` when `command`
is omitted because built-in provider launch behavior comes from the adapter.

### Do not treat launcher strategy as permission enforcement

A custom wrapper can discard generated arguments. Launcher consent allows the
operator to accept that risk for `permissionPolicy: inherit`; it does not prove
that a read-only floor survives the wrapper.

For `permissionPolicy: read-only`, require an adapter capability that enforces
the floor independently of the custom wrapper. Otherwise reject the launch with
a specific `custom_launcher_permission_floor_unsupported` error. Do not provide
an approval button that preserves a misleading read-only label.

## Stable consent model

### Introduce a dedicated subject

Create a `CustomLaunchConsentSubject` separate from the final
`RepositoryLaunchManifest`. It contains only stable, reviewable fields:

```ts
interface CustomLaunchConsentSubject {
  repositoryIdentity: string;
  integrationId: string;
  providerKind: AgentKind;
  adapterId: string;
  adapterSecurityVersion: string;
  configuredCommand: readonly string[];
  launcher: ProviderArgumentStrategy;
  workingDirectory?: string;
  environmentNames: readonly string[];
  credentialReference: CredentialProfileReference;
  permissionFloor: "inherit" | "read-only";
}
```

Canonicalize object keys and sorted set-like arrays before hashing. Preserve
command argument order. Never include environment values, credentials, tokens,
prompt text, or hidden provider state in the subject or API response.

### Keep final launch provenance

Continue computing and storing the final run launch digest after approval. The
run binding should retain both:

* Stable consent digest used for human approval
* Final launch digest used for exact run provenance

This avoids weakening forensic and recovery records to make consent reusable.

### Prevent approval races

Approval requests carry the expected subject digest and configuration revision.
When approving, the daemon recomputes the subject from current configuration
and adapter state. If either differs, mark the request stale and return
`launch_consent_stale`. The operator must review the replacement request.

## Persistence

### Reuse trust receipts for durable decisions

Extend the generic trust record with a subject kind such as
`custom-provider-launch`. Store trusted, denied, and revoked decisions against
the stable subject digest. Preserve historical receipts for auditability.

### Add pending launch-consent requests

Add a table for actionable requests because a receipt alone cannot represent an
undecided start:

```text
launch_consent_requests
  id
  repository_identity
  group_id
  agent_id
  member_id
  integration_id
  subject_digest
  config_revision
  redacted_subject_json
  state             pending | approved | denied | cancelled | stale
  requested_at
  decided_at
  decided_by
```

Enforce at most one pending request per configured agent and digest. Repeated
start calls return the existing request. Configuration or adapter changes mark
outdated requests stale during reconciliation.

Do not create an `AgentRun` row until consent is satisfied. Failed or abandoned
consent must not consume run generations or enter process-recovery loops.

## Daemon services

### Add a launch-consent service

Create a service responsible for:

* Determining whether an integration uses a built-in or custom command
* Resolving stable provider and permission metadata before run creation
* Computing the redacted subject and digest
* Looking up trusted or denied receipts
* Creating and reconciling pending requests
* Approving, denying, cancelling, and revoking decisions
* Rechecking configuration and adapter state before approval

The service must not receive or persist credential values.

### Gate run creation

Move custom-command authorization before
`NanasaStore.createRunForMembership()`. The single-run and restart paths ask the
launch-consent service for a decision before calling `TmuxRuntime.startRun()` or
`recoverRun()`.

Outcomes are:

```text
built-in command       → start
trusted custom subject → start
denied custom subject  → return denied outcome
unknown custom subject → create or return pending request
stale request          → create replacement request
```

Automatic recovery cannot create or approve consent. A custom run whose stable
subject changes remains stopped and attention-worthy until a human approves.

### Separate augmentation from recognition

Replace `ProviderSnapshotEvaluator.matchesConfiguredCommand()` and wrapper
matcher lookup with explicit launch input:

* Built-in command uses the adapter's built-in append strategy.
* Custom command uses the normalized integration launcher strategy.

`augmentConfiguredCommand()` becomes a pure strategy application function. It
validates lengths, environment names, and shell encoding but does not authorize
the executable.

Remove from provider snapshot contracts:

* `configuredCommandMatchers`
* `wrapperExecutableNames` where used only for configured launch recognition
* `wrapperArgumentSlot`
* `wrapperArgumentPrefix`

Retain `observedProcessMatchers` and their negotiation checks.

## HTTP and contract changes

### Add launch-consent contracts

Add schemas for:

* Redacted consent subject
* Pending consent request
* Approve command with expected digest and configuration revision
* Deny command
* Cancel command
* Revoke command or receipt revocation
* Single-run start result
* Batch start approval outcome

Use a discriminated start result:

```ts
type StartAgentRunResult =
  | { status: "started"; run: AgentRun }
  | { status: "already-running"; run: AgentRun }
  | { status: "approval-required"; request: LaunchConsentRequest }
  | { status: "denied"; request: LaunchConsentRequest };
```

Extend group start outcomes with `approval-required` and `denied` rather than
reporting them as generic failures.

### Add operator-only routes

Add routes for:

```text
GET  /api/v1/launch-consents
GET  /api/v1/launch-consents/:requestId
POST /api/v1/launch-consents/:requestId/approve
POST /api/v1/launch-consents/:requestId/deny
POST /api/v1/launch-consents/:requestId/cancel
POST /api/v1/trust/:receiptId/revoke
```

Approval returns the receipt and current request state. The portal retries the
original start operation after approval; the retried start recomputes the
subject and accepts only an exact trusted digest.

Add route-specific errors including `launch_consent_required`,
`launch_consent_denied`, `launch_consent_stale`,
`launch_consent_not_found`, and
`custom_launcher_permission_floor_unsupported`.

## Portal changes

### Project pending requests into snapshots

Include pending launch-consent requests in the portal snapshot or a bounded
workspace endpoint. Stream lifecycle events so another browser and the
Attention view update when a request is approved, denied, cancelled, or made
stale.

### Render consent in the terminal workspace

The terminal workspace currently renders only members with runs. Extend it to
render a member with a pending launch request even though no run or terminal
endpoint exists. Add a dedicated `LaunchConsentPane`; do not impersonate a PTY
or reuse provider permission prompts.

The pane uses stable dimensions and includes:

* Monospace command display with safe wrapping
* Provider, working directory, credential mode, and permission summary
* Expandable environment-name and generated-access details
* `Cancel` and `Trust and start` controls
* Loading, stale, denied, and API-error states

After approval, retry start. Replace the consent pane with the existing terminal
starting state and then the live terminal without changing the selected member.

### Add Attention integration

Add a typed launch-consent attention item with high urgency and target path to
the member's terminal route. Approval can be completed from Attention or by
navigating to the terminal pane. Both surfaces use the same client method and
expected digest.

### Handle group starts

Extend the current start-all result panel with a consolidated list of pending
custom launchers. Allow review per request and one batch approval action that
still submits one exact digest per request. Retry `Start all` after successful
approval; do not restart members already running.

## Claude gateway migration

### Add the launcher script

Create `examples/multi-coding-agents/bin/claude-copilot` with these
responsibilities:

1. Resolve the example and product roots without depending on the caller's
   current directory.
2. Read `LITELLM_URL`, `LITELLM_KEY`, and `COPILOT_MODEL` with the current local
   defaults.
3. Check LiteLLM health without printing credentials.
4. Run `scripts/prepare-claude-gateway-state.mjs` from the product root.
5. Export the Anthropic gateway variables.
6. Execute `claude "$@"` so provider-generated arguments remain individual
   arguments.

Use the explicit example configuration:

```yaml
command: [sh, bin/claude-copilot]
launcher:
  providerArguments: append
```

Remove the `claude-copilot` recipe from the example Makefile. Keep LiteLLM
authentication, start, stop, logs, and status targets there because they are
operator commands rather than provider launch wrappers.

### Consent presentation

The first Engineer 2 start will show `sh bin/claude-copilot` and the append
strategy. Approval persists for later runs. Editing the script contents does
not change the command digest by itself, so include a repository-owned launcher
file digest in the consent subject when a command argument resolves to a regular
file beneath the configuration root. Reject symlinks and apply the same
ownership and containment checks used for instruction files.

This file-digest rule prevents an approved path from silently changing code
without renewed consent. Document that interpreters, shell `-c`, PATH lookups,
and scripts that load other files can still widen behavior; the consent screen
must describe custom launchers as repository code, not a sandbox.

## Implementation phases

### Phase 1: Contracts and stable consent subject

Status: Complete on 2026-09-02.

1. Add authored launcher schemas and command-origin normalization.
2. Add stable consent subject, request, decision, and start-result contracts.
3. Define canonical digest rules and launcher file hashing.
4. Generate updated configuration and protocol references.

Exit criteria:

* Omitted commands normalize to built-in origin.
* Explicit commands normalize to custom origin and a launcher strategy.
* Stable digests ignore run-specific values and change for every documented
  security-relevant field.

### Phase 2: Persistence and service layer

Status: Complete on 2026-09-02.

1. Add the launch-consent request migration and store methods.
2. Extend trust receipts with a subject kind.
3. Implement request reconciliation and stable decision lookup.
4. Implement approve, deny, cancel, and revoke operations.

Exit criteria:

* Pending requests survive daemon restart.
* Duplicate starts reuse one pending request.
* Stale approvals cannot authorize changed launch subjects.

### Phase 3: Gate every launch path

Status: Complete on 2026-09-02.

1. Gate single start before run creation.
2. Gate restart and automatic recovery.
3. Return typed approval outcomes from group start and restart.
4. Remove configured-command rejection from the provisioner.
5. Replace wrapper matching with declarative strategy application.

Exit criteria:

* No provider process, credential resolution, private overlay, or run
  generation is created before required consent.
* Built-in commands remain zero-click.
* Trusted custom commands launch through the declared strategy.
* Observed-process matching remains active after launch.

### Phase 4: Operator API and events

Status: Complete on 2026-09-02.

1. Add list, inspect, approve, deny, cancel, and revoke routes.
2. Add CLI commands for headless operators.
3. Emit pending and decision events without secret values.
4. Update OpenAPI, CLI, event, and error references.

Exit criteria:

* Only authenticated operators can make decisions.
* CLI and portal use the same contracts.
* Approval races return a stale result rather than launching changed code.

### Phase 5: Portal consent experience

Status: Complete on 2026-09-02.

1. Add consent methods to the portal client.
2. Add pending requests to snapshot or workspace state.
3. Render the in-place terminal consent pane.
4. Add launch-consent Attention items and notifications.
5. Add consolidated start-all review and retry behavior.
6. Verify keyboard, focus, screen-reader, narrow viewport, and error states.

Exit criteria:

* Consent is discoverable in Terminals and Attention.
* Approval transitions into terminal startup without losing context.
* Denied, cancelled, and stale requests have distinct accessible states.
* Long commands and environment-name lists do not overflow the pane.

### Phase 6: Remove configured-command allowlists

Status: Complete on 2026-09-02.

1. Remove configured matcher contracts and snapshot assets.
2. Remove matcher negotiation and evaluator authorization methods.
3. Retain and test observed-process matchers.
4. Remove the Claude Make-wrapper special case.
5. Update provider conformance baselines and generated references.

Exit criteria:

* No built-in snapshot contains configured-command tuples.
* Arbitrary structurally valid custom commands reach consent rather than
  `provider_command_unrecognized`.
* Provider status still rejects unrelated observed processes.

### Phase 7: Migrate the Claude example

Status: Complete on 2026-09-02.

1. Add the argument-forwarding script under the example `bin` directory.
2. Update the explicit command and launcher strategy in example configuration.
3. Remove the provider-launch Make target.
4. Update the example runbook, configuration guide, and walkthrough.
5. Confirm first launch requests consent and later launches reuse approval.

Exit criteria:

* Engineer 2 launches through `bin/claude-copilot`.
* The consent screen shows the command and hashed repository script.
* Claude receives prompt, MCP, model, settings, and reporter arguments.

### Phase 8: Validation and release safety

Status: Complete on 2026-09-02.

Run validation in this order:

1. Contract and configuration tests
2. Trust digest and persistence tests
3. Provisioner and provider conformance tests
4. Single start, restart, recovery, start-all, and stale-race tests
5. Portal API, terminal pane, Attention, and responsive interaction tests
6. Claude gateway example setup, doctor, consent, launch, and MCP smoke test
7. Generated references and documentation validation
8. Static checks, full test suite, package tests, and production build
9. Playwright desktop and mobile screenshots of consent states
10. `git diff --check` and tracked-secret review

## Required test matrix

| Scenario | Expected result |
|----------|-----------------|
| Omitted built-in command | Starts without consent |
| First explicit command | Pending request, no process or credentials |
| Approve unchanged request | Receipt stored and run starts |
| Repeat start with same subject | Starts without another prompt |
| Command argument changes | New consent required |
| Launcher file content changes | New consent required |
| Working directory changes | New consent required |
| Credential reference changes | New consent required |
| Adapter security version changes | New consent required |
| Alias or presentation changes | Existing consent remains valid |
| Request changes during approval | Stale response, no launch |
| Denied digest | Denied outcome until revisited or revoked |
| Cancelled request | No receipt; later start can ask again |
| Start all with mixed launchers | Built-ins start; custom launchers await consent |
| Daemon restart with pending request | Request remains actionable |
| Agent or MCP approval attempt | Rejected as unauthorized |
| Custom launcher with unsupported read-only floor | Launch blocked without approval bypass |
| Custom launcher starts unrelated process | Process authority does not recognize provider |

## Documentation changes

Update these user concepts together:

* `command` omission selects the built-in launch contract.
* `command` presence selects a custom launcher and requires consent.
* Consent approves an exact stable security subject, not all repository code.
* Approval is reused until that subject changes.
* Custom launch consent does not prove wrapper correctness or sandbox code.
* Read-only roles require independently enforceable provider controls.
* Headless and service starts leave unapproved launchers stopped for operator
  review.

Add troubleshooting guidance for pending, denied, stale, unsupported permission
floor, launcher file ownership, and observed-process mismatch states.

## Non-goals

* Treating repository write access as equivalent to operator credential access
* Allowing agents or peer MCP calls to approve launch commands
* Displaying or hashing secret values in consent APIs
* Approving every file a wrapper may transitively execute
* Removing observed-process validation
* Claiming custom wrappers preserve read-only enforcement without evidence
* Prompting for built-in commands derived from provider kind

## Planning log

* Optional authored commands and built-in default normalization are already
  implemented in the current working tree and are prerequisites for this plan.
* Existing repository trust persistence will be reused for durable decisions,
  but its manifest digest will remain separate from the new stable consent
  digest.
* Pending launch consent will be a first-class persisted resource, not an agent
  wait and not a synthetic terminal process.
* Configured-command authorization will be removed only after consent gates all
  start, restart, and recovery paths.
* The Claude gateway will use an argument-forwarding script so the example does
  not require a provider-specific Make-wrapper exception.
* Full contract, control-client, daemon, portal, and packaged CLI test suites
  passed after implementation.
* Browser verification used an isolated file-backed daemon and confirmed the
  first custom launch creates one Attention item without a run, exposes the
  exact command and launcher-file digest, and starts Claude only after approval.
* A repeated stop and start reused the stable approval without another prompt.
* Revoking approval exposed a stopped-run projection defect; the terminal
  workspace now lets unresolved consent supersede inactive historical runs.
* At a 360 by 800 viewport, the consent pane remained within the viewport with
  both actions visible and no horizontal overflow. Mobile approval transitioned
  to an idle connected Claude terminal and cleared Attention.