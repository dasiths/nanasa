# Coordinate multiple coding-agent providers

A Nanasa group can combine provider CLIs while giving every runtime one stable
identity, role, prompt, terminal, provider home, and authenticated coordination
channel. This example uses four active agents:

| Agent | Provider | Responsibility |
|-------|----------|----------------|
| Project Manager | GitHub Copilot CLI | Assign and coordinate work |
| Engineer 1 | Pi | Implement and validate changes |
| Engineer 2 | Claude Code | Implement through a local model gateway |
| Reviewer | OpenCode | Review without modifying files |

The exact providers are replaceable. The important design is the separation of
integration, role, group, and agent identity.

## Define integrations once

An integration tells Nanasa which provider adapter and command to launch. Keep
provider state membership-scoped so each configured agent receives a separate
provider home:

```yaml
integrations:
  copilot:
    name: GitHub Copilot
    kind: copilot
    command: [copilot]
    cwd: .
    providerState: { scope: membership }
    credentials: { kind: provider-managed }
  pi:
    name: Pi
    kind: pi
    command: [pi]
    cwd: .
    providerState: { scope: membership }
    credentials: { kind: provider-managed }
  opencode:
    name: OpenCode
    kind: opencode
    command: [opencode]
    cwd: .
    providerState: { scope: membership }
    credentials: { kind: provider-managed }
```

Claude Code can use its direct command or Nanasa's recognized
`make claude-copilot` wrapper. The adapter passes generated Claude arguments
through the wrapper's `CLAUDE_ARGS` Make variable.

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

## Compose shared and specific guidance

Reference global instructions at the top level and team instructions on the
group:

```yaml
instructions:
  - .nanasa/instructions/nanasa-mcp.md
  - .nanasa/instructions/team.md
groups:
  backend-team:
    name: Backend Team
    instructions:
      - .nanasa/instructions/groups/agent-team.md
```

Nanasa builds each effective prompt in this order:

```text
Built-in coordination guidance
Built-in member and role assignment
Global instructions
Group instructions
Role instructions
Agent instructions
```

One file can appear only once in the configuration. Put stable cross-provider
rules at global scope, the team's shared mission at group scope, reusable
responsibility at role scope, and exceptional work for one identity at agent
scope.

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
npx nanasa auth login copilot --agent agent_manager
npx nanasa auth login pi --agent agent_engineer
npx nanasa auth login opencode --agent agent_reviewer
npx nanasa doctor
```

Each login launches the provider with the same isolated home that its later run
will use. Do not replace the configured agent key with the member ID.

## Start authenticated coordination

Start Nanasa with MCP enabled:

```bash
npx nanasa start --mcp
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

## Adapt the topology

Provider and role are separate choices. You can add another implementor using a
different CLI, move an existing agent to a reviewer role, or define another
group without duplicating global guidance.

Stop affected agents before changing integrations, roles, checkouts, models, or
instruction paths. Run `setup` and `doctor` after edits, then start new runs so
Nanasa can generate immutable launch overlays from the new configuration.

Continue with [Configure Nanasa](../guides/configuration.md),
[Add scoped prompts](../guides/prompts.md), and
[Send messages through MCP](../guides/messaging-and-mcp.md).