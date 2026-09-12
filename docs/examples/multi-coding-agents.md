# Coordinate multiple coding-agent providers

A Nanasa group can combine provider CLIs while giving every runtime one stable
identity, role, prompt, terminal, provider home, and authenticated coordination
channel. The [runnable example](../../examples/multi-coding-agents/README.md)
configures six team agents and a separate repository Foreman:

| Scope | Agent | Provider | Responsibility |
|-------|-------|----------|----------------|
| Repository | Foreman | GitHub Copilot CLI | Supervise Human-approved team goals |
| Backend | Project Manager | GitHub Copilot CLI | Coordinate Backend work |
| Backend | Engineer 1 | Pi | Implement and validate changes |
| Backend | Engineer 2 | Claude Code | Implement through a local model gateway |
| Backend | Reviewer | OpenCode | Review without modifying files |
| Frontend | Frontend Engineer | Pi | Implement in the Frontend worktree |
| Frontend | Frontend Reviewer | OpenCode | Review Frontend work read-only |

The exact providers are replaceable. The important design is the separation of
integration, role, group, and agent identity.

Foreman is a repository runtime, not a `roles.foreman` entry or team member.
It reuses the built-in `copilot` integration but has a private home distinct
from Backend's Project Manager. Teams start independently; configuring Foreman
does not automatically start these processes or grant access to existing teams.

## Define integrations once

An integration tells Nanasa which provider adapter and command to launch. Keep
provider state membership-scoped so each configured agent receives a separate
provider home:

```yaml
integrations:
  copilot:
    name: GitHub Copilot
    kind: copilot
    cwd: .
    providerState: { scope: membership }
    credentials: { kind: provider-managed }
  pi:
    name: Pi
    kind: pi
    cwd: .
    providerState: { scope: membership }
    credentials: { kind: provider-managed }
  opencode:
    name: OpenCode
    kind: opencode
    cwd: .
    providerState: { scope: membership }
    credentials: { kind: provider-managed }
  claude-copilot:
    name: Claude Code via GitHub Copilot
    kind: claude-code
    command: [sh, bin/claude-copilot]
    launcher:
      providerArguments: append
    cwd: .
    providerState: { scope: membership }
    credentials: { kind: provider-managed }
```

When `command` is omitted, Nanasa derives the built-in executable from `kind`.
The explicit Claude command is a custom launcher. Nanasa appends generated
prompt, MCP, model, settings, and reporter arguments to the script command as
individual arguments.

The first start pauses before credentials or private launch state are created.
Review the command, append strategy, and repository script digest, then approve
it in the terminal consent pane or Attention workspace. Later starts reuse the
approval while the stable launch properties and script contents remain
unchanged. This consent trusts repository code; it does not sandbox an
interpreter, a PATH lookup, or other files loaded by the script.

## Define reusable roles

Roles keep responsibilities and permission policies independent from provider
selection:

```yaml
roles:
  project-manager:
    name: Project Manager
    description: Coordinates assignments, dependencies, and completion
    instructions: [.nanasa/instructions/project-manager.md]
    permissionPolicy: inherit
  implementor:
    name: Implementor
    description: Implements assigned changes and validates the result
    instructions: [.nanasa/instructions/implementor.md]
    permissionPolicy: inherit
  reviewer:
    name: Reviewer
    description: Reviews changes and reports prioritized findings
    instructions: [.nanasa/instructions/reviewer.md]
    permissionPolicy: read-only
```

The reviewer prompt describes expected behavior. The `read-only` policy asks
the provider adapter to enforce its write-denial floor. Prompt wording alone is
not a permission boundary.

## Add the GitHub Copilot Foreman

The checked-in example selects the existing Copilot CLI integration and sets
goal supervision limits. Teams and roles are discovered dynamically:

```yaml
foreman:
  id: repository-foreman
  name: Foreman
  integrationId: copilot
  enabled: true
  instructions: [.nanasa/instructions/foreman.md]
  supervision:
    reconcileIntervalSeconds: 30
    reviewIntervalSeconds: 300
    maxRecoveryAttempts: 3
    recoveryCooldownSeconds: 120
  autonomy:
    mode: supervised
    maxActiveGoals: 2
    maxTeamsPerGoal: 2
    maxConcurrentActions: 4
    maxGoalHours: 8
    maxForemanTurns: 100
```

This does not add a seventh member to either authored team. Goals delegate to
existing teams after Human approval of the owner and assigned checkout.
No Foreman model is pinned: select one in
Settings when needed. The example's Claude-gateway `COPILOT_MODEL` variable does
not select Foreman's model.

The existing autonomous provider execution profile controls native provider
behavior. It does not override the separate goal grant: exact operator approval
is still required for the goal and team delegation. Discretionary idle check-ins
and automatic worker restarts remain off by default. Native worker permission
prompts are never approved by Foreman. See [Foreman and goals](../guides/foreman.md).

## Compose shared and specific guidance

Reference global instructions at the top level and team instructions on the
group:

```yaml
instructions:
  - .nanasa/instructions/team.md
groups:
  backend-team:
    name: Backend Team
    instructions:
      - .nanasa/instructions/groups/agent-team.md
```

Nanasa builds each team member's effective prompt in this order:

```text
Built-in coordination guidance
Built-in member and role assignment
Global instructions
Group instructions
Role instructions
Agent instructions
```

One file can appear only once in the configuration. Put stable cross-provider
rules at global scope, the team's shared purpose at group scope, reusable
responsibility at role scope, and exceptional work for one identity at agent
scope.

Foreman's prompt instead consists of built-in Foreman guidance and identity,
the shared project guidance, and `.nanasa/instructions/foreman.md`. It never inherits
group or member-role instructions. Nanasa's built-in layer supplies MCP scope,
reply routing, goal delegation and supervision rules without any user-authored
instruction files. The short Foreman file adds project priorities only.
Choosing a team context changes neither this
prompt layering nor Foreman's working directory.

## Assign providers and roles independently

Agents connect one integration to one optional role:

```yaml
groups:
  backend-team:
    name: Backend Team
    instructions: [.nanasa/instructions/groups/agent-team.md]
    agents:
      agent_manager:
        memberId: copilot.manager
        name: Project Manager
        integrationId: copilot
        roleId: project-manager
      agent_engineer:
        memberId: pi.engineer
        name: Engineer
        integrationId: pi
        roleId: implementor
      agent_reviewer:
        memberId: opencode.reviewer
        name: Reviewer
        integrationId: opencode
        roleId: reviewer
```

The configured agent key, such as `agent_engineer`, is used by topology and
provider-login commands. The nested member ID, such as `pi.engineer`, is used
for messages, status, and peer discovery.

## Prepare and authenticate each home

Create private state and authenticate each membership-scoped provider home:

```bash
npx nanasa setup
npx nanasa auth login copilot --foreman
npx nanasa auth login copilot --agent agent_manager
npx nanasa auth login pi --agent agent_engineer
npx nanasa auth login opencode --agent agent_reviewer
npx nanasa doctor
```

Each login launches the provider with the same isolated home that its later run
will use. Do not replace the configured agent key with the member ID. Stop
Foreman before its login and do not combine `--foreman` with `--agent`. Its private
home is not populated by the Project Manager's Copilot login.

For the runnable example, use its targets instead of the illustrative agent IDs
above:

```bash
make -C examples/multi-coding-agents auth-foreman
make -C examples/multi-coding-agents auth
```

The first target authenticates only Foreman. The second includes Foreman and
both teams in order; use one or the other according to which homes need login.
Foreman's login does not populate member homes. Resolve authentication for the
selected team's members; do not copy credentials from Foreman or another worktree.

## Start authenticated coordination

Start Nanasa. Authenticated coordination MCP is enabled by default:

```bash
npx nanasa start
```

At launch, Nanasa writes a private provider-specific prompt overlay, registers
the `nanasa` MCP server, and injects a bearer credential bound to the agent's
group, member, run, and generation. The agent can call `nanasa.list_members` to
discover peers and their roles instead of relying on a duplicated roster in its
prompt.

Group credentials cannot select another group. Agents can send direct,
multicast, or group messages, report progress, inspect status, and request
correlated peer work through the MCP tools. Human portal messages remain
operator direction and take precedence over conflicting peer requests.

## Delegate a supervised goal

1. Authenticate Foreman, start the example daemon with MCP, and open a one-use
  portal session using `make example-portal-auth` from the repository root.
2. Choose **Coordination > Foreman**, review Settings, and choose **Start**.
  Channel provides durable instructions and replies; Terminal directly controls
  the same native Copilot run.
3. Use **Ask Foreman about Backend Team** or the Frontend equivalent for context.
  **Back to team** returns to that team's messages. Context is not authorization
  to control or adopt an existing team or its checkout.
4. Give Foreman a high-level objective or use **Goals > New goal**. Approve the
  goal, then review the proposed accountable member and team under **Decisions**.
5. The team researches, plans, implements and independently reviews the outcome.
  Follow reports and decisions in Goals; pause or cancel the goal when needed.

Backend and Frontend remain Human-managed until their exact delegation is
approved. Their agents start at `examples/multi-coding-agents` inside the assigned
checkout. Foreman does not create a second task graph or micromanage each phase.

Completion requires validation evidence and independent review of the same clean
committed candidate, not a message or a provider's assertion. Missing credentials,
uncertain input, and unsupported approval states remain blocked for inspection.
This example does not certify real-provider overnight reliability.

## Adapt the topology

Provider and role are separate choices. You can add another implementor using a
different CLI, move an existing agent to a reviewer role, or define another
group without duplicating global guidance.

Stop affected agents before changing integrations, roles, models, or instruction
paths. Select one workspace for the whole team through **Team workspaces**; that
binding remains local and is not written into this shared configuration. Run
`setup` and `doctor` after configuration edits, then start new runs so Nanasa can
generate immutable launch overlays from the new configuration.

Continue with [Configure Nanasa](../guides/configuration.md),
[Add scoped prompts](../guides/prompts.md), and
[Foreman and goals](../guides/foreman.md).