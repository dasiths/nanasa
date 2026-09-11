# Run repository missions with Foreman

Foreman is a repository-owned coding-agent process. It has a private provider
home, its own MCP principal, and a durable channel outside every team. Team
broadcasts do not include it. Channel and Terminal address the same native run.

## Configure and authenticate

Use configuration version 2. Choose an existing integration and role-defined
team templates. Foreman inherits repository-global and Foreman-specific
instruction files, not a selected team's instructions.

```yaml
version: 2
integrations:
  copilot:
    name: GitHub Copilot
    kind: copilot
roles:
  engineer:
    name: Engineer
  reviewer:
    name: Reviewer
    permissionPolicy: read-only
teamTemplates:
  feature:
    members:
      engineer:
        integrationId: copilot
        roleId: engineer
      reviewer:
        integrationId: copilot
        roleId: reviewer
foreman:
  integrationId: copilot
  enabled: true
  instructions: []
  supervision:
    reconcileIntervalSeconds: 30
    reviewIntervalSeconds: 300
    maxRecoveryAttempts: 3
    recoveryCooldownSeconds: 120
  autonomy:
    mode: supervised
    permittedTeamTemplates: [feature]
    maxActiveMissions: 1
    maxTeamsPerMission: 3
    maxConcurrentTasks: 4
    maxMissionHours: 24
    maxForemanTurns: 200
groups: {}
```

Run setup, then authenticate the selected integration in Foreman's private home:

```bash
nanasa setup
nanasa auth login copilot --foreman
nanasa doctor
nanasa start --mcp
```

Stop Foreman before logging in or changing its settings. Do not combine
`--foreman` with `--agent`. Integration-shared authentication does not populate
Foreman's private home. Nanasa does not copy provider credentials between homes.

Open an authenticated portal session and choose **Coordination > Foreman**.
Settings select the provider, model, instruction paths, approved templates, and
mission limits. Save settings while stopped, then choose **Start**. Custom
Foreman launchers currently block with `foreman_launch_consent_required`; use
the integration's built-in command. No operator token is given to Foreman.

## Use Channel and Terminal

Channel stores operator instructions and Foreman replies with stable sequence
numbers. Retrying the same request ID and content does not duplicate a message.
Team context is provenance only: it grants no permissions and changes no cwd.

Input remains queued until Foreman has a current, verified, idle reporter and no
human terminal controller. Submitted means terminal input completed, not that
the provider accepted or completed the work. A Foreman MCP reply settles its
channel instruction. Only one unresolved input is dispatched at a time.

Terminal uses the normal native terminal controller and observer leases. There
is no separate CLI command composer. Switch to observe mode, or leave Terminal,
to allow automatic input after the provider becomes idle again.

If a write is interrupted, Nanasa records it as ambiguous and does not replay
it. Inspect Terminal and the transcript, then use **Mark inspected input handled**
or **Close without replay**. These controls resolve the inbox record; they do
not stop provider work that may already have started.

## Create a mission

Open **Missions > New mission** and supply a title, objective, acceptance criteria,
approved templates, and verification commands. Each acceptance line is retained
as a separate criterion. Verification commands are JSON argument arrays, such as:

```json
[["node", "--test", "test/feature.test.mjs"]]
```

Commands are executed without an implicit shell in the mission checkout. They
are operator-authorized code execution, not a sandbox. Only approve commands
appropriate for the repository. Output is bounded and retained as a digest,
not copied into the mission response. The portal applies each entered command
to all acceptance criteria; the API supports per-recipe criterion indexes.

The objective, criteria, recipes, limits, and approved template digests are
immutable for the mission. Editing an approved template blocks the old grant.
Create a new mission to change its authority or acceptance requirements.

**Start mission** enables periodic reviews. In supervised mode, provisioning,
task execution, and verification need exact operator decisions under
**Decisions**. In bounded mode, those operations can proceed within the grant.
Permission and plan approvals remain human-only in both modes.

## Follow execution and evidence

Foreman plans tasks with roles, dependencies, and criterion references. Nanasa
creates teams from approved templates in new managed worktrees, using pinned
base commits. Runtime teams are stored in daemon state, not written to authored
YAML. One active task owns a team's checkout at a time. Busy or unverified
workers do not receive queued task input.

Task dispatch creates one exact run-bound action. An interrupted action is not
silently reassigned or retried. Confirmed completed actions move to verification.
Each task requires passing operator-approved recipes at its exact clean commit.
Foreman then integrates verified commits from the common pinned base into a
separate managed candidate worktree and runs the integration checks again.

**Accept verified result** is available only after candidate verification.
Acceptance rechecks candidate and task commit identity and cleanliness. Nanasa
does not deploy, publish, or merge the candidate into the human's branch.
Model statements and delivered messages alone cannot complete a mission.

## Pause, recover, and inspect

Pause and revoke change the grant revision immediately. New action and input
writes recheck that revision. Already submitted provider work is not falsely
reported as stopped. Revoke cancels undispatched tasks; retained worktrees,
branches, and evidence remain available for inspection.

Worker restarts require an explicit mission recovery grant, exact owned
checkout, no human controller, cumulative retry budgets, and cooldowns. Missing
and dead processes use the existing runtime recovery path. Indeterminate process
ownership does not trigger a restart. Foreman itself has a separate persistent
recovery limit and resumes recorded native state only after provider confirmation.

Idle prompting and routine typed wait replies are opt-in. They require fresh
bounded observations, exact run/reporter/process identity, and a reviewed provider
reply codec. Arbitrary TUI keys, permission approvals, and plan approvals are not
advertised Foreman capabilities. Unsupported states require human inspection.

Interrupted worktree creation, candidate integration, and verification remain
blocked or ambiguous rather than being replayed. Inspect the retained resources
and create a corrective mission when the existing operation cannot be resumed
without uncertainty. Automated destructive cleanup is not performed.

## Use the CLI

The CLI uses the same authenticated daemon services and JSON contracts:

```bash
nanasa foreman status
nanasa foreman history
nanasa foreman send --body '{"requestId":"instruction-1","text":"Review current missions"}'
nanasa missions list
nanasa missions get MISSION_ID
nanasa missions control MISSION_ID --body '{"expectedRevision":1,"action":"pause"}'
```

Configuration, start, stop, and approval commands require the exact revision or
run identity shown by the current response. See the generated
[CLI reference](../reference/cli.json) and [protocol reference](../reference/protocols.md).

## Development and certification limits

This early-stage change keeps config version 2, database version 16, and existing
protocol/package identifiers. Database layouts changed directly. Old development
databases are not automatically converted; back up required state before using a
fresh development database. Never remove provider credentials or user worktrees
as a substitute for a database reset.

Deterministic tests cover persistence, grants, process fencing, no-replay input,
managed worktrees, verification, and browser workflows with synthetic providers.
They do not certify real model judgment, arbitrary native approval screens, or
overnight reliability. Run real-provider trials in disposable repositories with
finite budgets before relying on unattended work. MCP scope and read-only roles
are application safeguards, not isolation from hostile code running as your OS user.