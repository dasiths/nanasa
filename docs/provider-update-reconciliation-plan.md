---
title: Provider update reconciliation plan
description: Plan for restarting retained agent processes when their provider snapshot differs from the active built-in snapshot
---

## Goal

Treat a changed provider snapshot as an ordinary provider update. Nanasa should
not need to interpret an older provider snapshot to keep operating an agent.
When a retained run references a different snapshot from the active provider,
Nanasa should replace that process with a run created from the current snapshot
and tell the operator what happened.

Old provider packages, snapshots, bindings, and run records remain immutable for
history and audit. They are not loaded as current executable policy.

## User outcome

After updating and starting Nanasa:

1. Built-in providers register their current snapshots.
2. Nanasa compares each desired-running run with the current snapshot for its
   provider kind.
3. Matching runs use normal process and tmux recovery.
4. Mismatched runs move to `provider-update` recovery.
5. Nanasa stops the old owned pane and starts one replacement from the current
   provider snapshot.
6. The portal and CLI report whether the agent was retained, restarted, needs
   custom-launch consent, or failed.

The operator does not delete state, reset the repository, or understand provider
snapshot internals.

## Design principles

### Compare identities without parsing old policy

The provider run binding already stores the run's `providerId`, `snapshotDigest`,
and activation identity. The active provider index stores the current snapshot
digest for each provider.

Provider update detection needs only:

```text
run binding snapshot digest != active provider snapshot digest
```

Do not call `getResolvedSnapshot()` for the old digest before making this
decision. Do not require historical capability payloads to satisfy current
schemas.

### Preserve old records

Do not rewrite or delete historical provider packages, snapshots, activations,
run bindings, operation audits, or process incarnations. A replacement run gets
a new binding to the current snapshot. Existing foreign-key and immutable-record
guarantees remain unchanged.

### Keep package versions stable

Built-in package version and anti-rollback sequence remain `1.0.0` and `1` while
the project is in this compatibility stage. The immutable generation identity is
content-addressed from the package digest:

```text
nanasa.<provider>@1.0.0+builtin.<digest-prefix>
```

This is an internal immutable identity, not a user-facing version increment.
Identical built-in content reuses the same identity. Changed content cannot
collide with an older database record.

### Fence ownership before stopping

Nanasa may stop an old process only when its persisted terminal binding matches
the tmux pane's exact run ID and generation tags. Stopping a provider-update run
must not depend on parsing its old provider snapshot.

If pane ownership cannot be established, do not send input or kill an arbitrary
process. Mark the run `provider_update_ownership_uncertain` and require operator
recovery with an explicit force option.

### Replace once per update

Calculate the provider update plan after all current built-ins are registered.
Restart each affected run at most once for a given old/current digest pair.
Persist the transition so daemon restarts cannot create a restart loop.

## Runtime model

### Add provider-update recovery metadata

Extend run recovery metadata with a reason and outcome that can be projected
without opening historical snapshots:

```text
recoveryReason: provider_snapshot_changed
recoveryOutcome:
  provider-update-restarted
  provider-update-approval-required
  provider-update-failed
```

Store a bounded provider-update record containing:

* Run ID and generation
* Provider ID
* Previous snapshot digest
* Current snapshot digest
* Detection time
* Replacement run ID when created
* Outcome and safe error code

Do not store secrets, generated prompt text, or environment values.

### Reconciliation order

For every desired-running run:

1. Resolve its run binding metadata without resolving the historical snapshot.
2. Resolve the active provider index entry.
3. If digests match, continue normal runtime observation.
4. If digests differ, enter provider-update reconciliation.
5. Verify or classify the old pane:
   * Exact owned pane present: stop it gracefully, then replace it.
   * Exact owned pane missing or dead: replace it.
   * Observation unavailable but ownership tags are readable: replace it.
   * Ownership cannot be proven: stop automatic recovery and require operator
     action.
6. Evaluate current custom-launch consent using the current provider snapshot.
7. Start one replacement or publish `approval-required` or `failed`.

The replacement uses current configuration, current prompt composition, current
credentials policy, and the current provider snapshot.

### Built-in and custom commands

Built-in commands restart automatically.

Custom commands follow the existing consent rules:

* If the stable consent subject still matches, restart automatically.
* If the provider security identity or another consent field changed, create an
  approval request and leave the member stopped.
* After approval, retry provider-update recovery and create the replacement run.

Do not reuse an old consent decision by parsing the historical snapshot.

### Native session behavior

Apply the integration's configured native recovery policy to the replacement:

* `resume-or-restart`: resume when a confirmed native session is available;
  otherwise start fresh.
* `resume-only`: fail visibly when the old native session cannot be resumed.

Retain the old terminal history and run record even when the provider starts a
fresh native session.

## Service changes

### Add a provider update reconciler

Create a focused service between the provider runtime index and run coordinator.
Its responsibilities are:

* Compare run binding and active snapshot digests
* Build a deterministic provider-update plan
* Persist detection and outcome records
* Fence duplicate restarts
* Coordinate safe pane replacement
* Invoke current launch consent before replacement
* Return typed per-run results

The service must not resolve historical provider snapshots.

### Separate normal recovery from update replacement

Normal recovery answers:

> Does the process represented by the current run binding still exist?

Provider update reconciliation answers:

> Does this run use the provider snapshot that is currently active?

Perform the update comparison first. Only matching snapshots enter the existing
process-recognition path. This removes the need for current code to understand
legacy capability payloads during startup.

### Trigger points

Run provider-update reconciliation:

* During daemon startup after all built-ins and extensions are activated
* After a provider extension activation or rollback
* From an explicit operator CLI/API recovery command

Do not wait for the periodic stale-reporter timer to discover a provider update.

## API and CLI contracts

### Provider update result

Add a typed result:

```text
providerId
previousSnapshotDigest
currentSnapshotDigest
runId
memberId
status:
  retained
  restarted
  approval-required
  ownership-uncertain
  failed
replacementRunId?
consentRequest?
safeError?
```

### Recovery API

Add operator-only routes:

```text
POST /api/v1/groups/:groupId/runs/recover
POST /api/v1/groups/:groupId/agents/:agentId/run/recover
```

Request options:

```text
dryRun: boolean = false
forceIndeterminate: boolean = false
```

The group route returns one outcome per active membership. Healthy current runs
are reported as `retained`, not restarted.

### Recovery CLI

Add:

```bash
nanasa run recover <group-id>
nanasa run recover <group-id> <agent-id>
nanasa run recover <group-id> --body '{"dryRun":true}'
nanasa run recover <group-id> --body '{"forceIndeterminate":true}'
```

The normal command is conservative. `forceIndeterminate` must be explicit and
must still target the exact persisted run and generation. It does not authorize
custom launch consent.

CLI output should summarize:

```text
Project Manager  retained
Engineer 1       restarted (provider snapshot changed)
Engineer 2       approval required
Reviewer         failed (provider update ownership uncertain)
```

Exit nonzero when any outcome is `failed` or `ownership-uncertain`. Return a
distinct documented exit status when approval is required but no hard failure
occurred.

## Portal UX

### Use plain language

Primary UI copy must avoid `snapshot`, `digest`, `generation`, `binding`,
`reconciliation`, `retained`, and `ownership`. Keep those terms in expandable
technical details, logs, API responses, and developer documentation.

Use this vocabulary in operator-facing surfaces:

| Technical concept | User-facing wording |
|-------------------|---------------------|
| Provider snapshot changed | Agent tools changed |
| Reconciliation | Recovery |
| Retained run | Kept running |
| Replacement run | Restarted agent |
| Consent subject changed | Launch settings changed |
| Ownership uncertain | Nanasa could not safely identify the old process |
| Indeterminate process | Process status could not be confirmed |
| Force replacement | Stop the old process and restart |
| Snapshot digest | Setup ID |

Every message should answer three questions in this order:

1. What happened?
2. What is Nanasa doing?
3. Does the operator need to act?

### During startup

An affected terminal pane moves through these states:

```text
Updating Engineer 1

Agent tools changed. Nanasa is restarting Engineer 1 with the latest setup.
```

The group header counts the agent as `starting`, not `live`, until the new pane
and process authority are ready.

Do not briefly render the old run as `Unknown` and live. If the old terminal is
still viewable during graceful shutdown, make it read-only and label it
`Updating`.

### Successful update

After replacement, show the connected terminal normally. Add a dismissible
informational notice:

```text
Engineer 1 restarted

The agent is using the latest setup. Its previous terminal remains in history.
```

This is an informational activity item, not a counted Attention item. It remains
available in the event timeline and run details.

### Approval required

For a custom launcher whose consent subject changed, show the existing in-place
launch consent pane:

```text
Review before restarting Engineer 2

The agent tools or launch settings changed. Confirm the command Nanasa will run.
```

Use `Not now` and `Approve and restart` for the primary actions. The operator is
approving one exact command, not granting general trust.

This is a counted Attention item. Approval starts the replacement using the
current provider snapshot. Denial leaves the old run in history and the member
stopped.

### Failure or uncertain ownership

Show a counted health item with a concrete action:

```text
Reviewer needs help

Nanasa cannot safely confirm which process belongs to this agent. It will not
stop anything automatically.
```

Actions:

* `View details`
* `Check again`
* `Stop the old process and restart` when the operator opens the detailed view

Never make `Stop the old process and restart` the primary action.

Its confirmation reads:

```text
Restart without verification?

Nanasa could not verify the old process. Continuing may stop the wrong process.

Cancel | Stop and restart
```

### Start all behavior

`Start all` first reconciles existing desired-running runs:

* Current healthy runs remain untouched.
* Outdated runs enter provider-update recovery.
* Stopped members start normally.
* Custom launchers can return approval requests.

The result banner uses plain summaries:

```text
Team recovery finished

2 agents kept running
1 agent restarted
1 agent needs your approval
0 agents failed
```

Technical details can show previous and current setup IDs, run IDs, generations,
and safe error codes.

## Removing legacy snapshot dependence

After provider-update reconciliation is complete and tested:

1. Stop resolving old snapshots for desired-running runs whose digest differs
   from the active provider digest.
2. Remove the temporary legacy configured-command compatibility fields from the
   current snapshot parser if no history or audit API needs to deserialize full
   historical payloads.
3. If history APIs still expose old snapshots, parse them through a separate
   versioned archival decoder rather than the current executable-policy schema.
4. Keep raw canonical bytes and digests available for audit regardless of
   decoder support.

## Implementation phases

### Phase 1: Detection and contracts

Status: Complete on 2026-09-03.

1. Add provider-update plan and outcome contracts.
2. Add binding-versus-active digest comparison without historical snapshot
   resolution.
3. Add content-addressed built-in generation tests.
4. Add tests proving changed built-in content coexists with old bound snapshots.

### Phase 2: Persisted update state

Status: Complete on 2026-09-03.

1. Add provider-update transition persistence and duplicate fencing.
2. Record previous/current digests and replacement run identity.
3. Project update state through run and status read models.
4. Preserve all historical run and provider records.

### Phase 3: Automatic reconciliation

Status: Complete on 2026-09-03.

1. Run update planning after provider activation during startup.
2. Safely stop exact owned panes without loading old executable policy.
3. Replace built-in launches automatically.
4. Route custom launches through current consent.
5. Apply native recovery policy and bounded retries.

### Phase 4: CLI and API recovery

Status: Complete on 2026-09-03.

1. Add group and single-agent recovery routes.
2. Add `run recover` CLI forms and dry-run output.
3. Add force fencing for ownership-uncertain runs.
4. Add approval-required and partial-failure exit behavior.

### Phase 5: Portal projection

Status: Complete on 2026-09-03.

1. Add `Updating` member and terminal states.
2. Add informational successful-restart notices.
3. Reuse launch consent for custom provider updates.
4. Add health Attention items for failed or uncertain replacement.
5. Expand Start-all summaries.

### Phase 6: Remove active legacy decoding

Status: Complete on 2026-09-03.

1. Prove mismatched runs never resolve historical executable policy.
2. Separate archival decoding from current snapshot validation when required.
3. Remove temporary compatibility parsing from the active runtime path.
4. Keep immutable canonical records and exact run provenance.

## Validation matrix

| Scenario | Expected result |
|----------|-----------------|
| Run and active digests match | Existing runtime recovery applies |
| Built-in snapshot changes, pane present | One safe restart using current snapshot |
| Built-in snapshot changes, pane missing | One replacement using current snapshot |
| Custom snapshot changes, consent still valid | One automatic replacement |
| Custom consent subject changes | Approval-required, no replacement process |
| Exact old pane ownership cannot be proven | Ownership-uncertain, no automatic kill |
| Daemon restarts during update | Persisted transition resumes without duplicate run |
| Replacement launch fails | Failed outcome with bounded retry |
| Native session confirms | Replacement resumes native session |
| Resume-only cannot confirm | Visible failure, no fresh fallback |
| Group recovery dry run | Reports actions without changing runs or panes |
| Group recovery mixed state | Healthy retained, outdated replaced, custom paused |
| Historical package has unsupported payload | Update replacement succeeds without parsing it |
| Historical run details requested | Raw identity and digest remain available |

## Documentation changes

Document:

* Provider updates restart affected agents instead of requiring state deletion.
* Old runs and terminal history remain available.
* Custom launchers may require renewed approval.
* Automatic replacement can interrupt in-progress provider work.
* `run recover --dry-run` previews operator-visible actions.
* `forceIndeterminate` is for ownership failures, not ordinary updates.

Add troubleshooting steps that begin with `nanasa run recover`, not database or
tmux manipulation.

## Non-goals

* Mutating or deleting historical provider records
* Parsing old snapshots as current executable policy
* Silently retaining a process on an outdated provider snapshot
* Restarting healthy current runs during group recovery
* Bypassing custom-launch consent
* Killing a process without exact run and generation ownership
* Hiding provider-update restarts from the operator

## Planning decisions

* Provider update detection precedes process recognition.
* Built-in provider updates restart automatically and generate an informational
  operator event.
* Custom launcher updates reuse the existing consent workflow.
* Historical snapshots remain immutable provenance, not live policy.
* Content-addressed generation identity allows all declared package versions and
  anti-rollback sequences to remain at `1` without identity collisions.
* Live browser verification used four retained agents on older provider
   snapshots. Three built-in agents restarted automatically and displayed plain
   success notices. The custom Claude launcher displayed `Needs approval`, the
   exact command, `Not now`, and `Approve and restart`.
* After approval, all four agents reached `Idle` with connected terminals. A
   portal `Check tools` dry run reported four agents kept running, zero restarted,
   zero needing approval, and zero failed.
* The CLI dry run reported the same mixed pre-approval state in plain language.
* Full contract, control-client, daemon, portal, and packaged CLI test suites
   passed after implementation.