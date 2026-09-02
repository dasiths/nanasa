# Configure Nanasa

Package users can define integrations, roles, groups, agents, prompts, messages,
terminal checkpoints, and extensions in `.nanasa/config.yaml`.

## Understand the configuration root

Nanasa searches the current directory and then each parent directory for the
nearest `.nanasa/config.yaml`. The directory that contains `.nanasa` becomes the
configuration root. Nanasa keeps configuration-owned files beneath that root:

```text
your-project/
  .nanasa/
    config.yaml
    extensions.lock.yaml
    instructions/
    integrations/   # private provider homes and generated launch overlays
    runtime/        # live process and authentication files
    state/          # database, checkpoints, and signing material
```

Commit `config.yaml`, `extensions.lock.yaml`, and shared instruction files. Do
not commit `integrations`, `runtime`, or `state`. Running `npx nanasa init`
creates a `.nanasa/.gitignore` for those private directories.

Paths have two different bases:

* `repository.path` is relative to the configuration root
* Integration `cwd` is relative to `repository.path`
* Instruction paths are relative to the configuration root
* Custom provider-state paths are relative to `.nanasa/integrations`

All configured paths must remain beneath their applicable root. For example, a
configuration at `examples/demo/.nanasa/config.yaml` can manage
`examples/demo`, but it cannot set `repository.path: ../..` to manage the outer
directory. Start lifecycle commands from `examples/demo` so Nanasa selects the
nested configuration rather than another one higher in the tree.

## Start with a minimal file

A valid file needs `version: 2`, at least one integration, and the repository
information needed for a useful team:

```yaml
version: 2
repository:
  path: .
  checkout: { kind: current }
integrations:
  copilot:
    name: GitHub Copilot
    kind: copilot
    command: [copilot]
    cwd: .
    providerState: { scope: membership }
groups:
  group_product:
    name: Product
    agents:
      agent_builder:
        memberId: copilot.builder
        name: Builder
        integrationId: copilot
```

Map keys are stable configuration IDs. In this example, `copilot` is the
integration key, `group_product` is the group key, and `agent_builder` is the
configured agent key. The nested `memberId`, `copilot.builder`, is a separate
communication identity. Provider login with `--agent` takes `agent_builder`, not
`copilot.builder`.

## Keep the identifiers distinct

Several IDs describe different parts of one running agent:

| Value | Example | Used for |
|-------|---------|----------|
| Integration ID | `copilot` | Provider selection and `auth login` |
| Role ID | `reviewer` | Reusable instructions and permission policy |
| Group ID | `group_product` | Topology, messages, and control commands |
| Configured agent ID | `agent_reviewer` | Topology commands and `--agent` |
| Member ID | `copilot.reviewer` | MCP messages, status, and peer discovery |
| Display name | `Reviewer` | Human-readable portal and terminal labels |

Map keys are IDs even though the YAML does not repeat an `id` field inside each
object. Keep IDs stable when changing display names. Changing a configured
agent ID or member ID changes identity rather than presentation.

## Read a complete configuration

This example shows every top-level section. Referenced instruction files must
exist before Nanasa loads the file.

```yaml
version: 2
repository:
  path: .
  checkout: { kind: current }
terminal:
  checkpoints:
    enabled: false
    maxLines: 5000
    maxBytes: 1048576
    retentionSeconds: 86400
    sensitivity: repository-private
instructions:
  - .nanasa/instructions/global.md
integrations:
  copilot:
    name: GitHub Copilot
    kind: copilot
    command: [copilot]
    cwd: .
    providerState: { scope: membership }
    credentials: { kind: provider-managed }
    model: { resumePolicy: preserve-session }
    nativeRecovery:
      mode: resume-or-restart
      confirmationTimeoutSeconds: 30
    extensions: []
    environment: {}
extensions: {}
roles:
  reviewer:
    name: Reviewer
    description: Reviews changes and reports findings
    instructions: [.nanasa/instructions/reviewer.md]
    permissionPolicy: read-only
    presentation:
      icon: shield-check
      color: amber
      shortName: Review
groups:
  group_product:
    name: Product
    order: 0
    instructions: [.nanasa/instructions/product.md]
    agents:
      agent_reviewer:
        memberId: copilot.reviewer
        name: Reviewer
        integrationId: copilot
        roleId: reviewer
        instructions: [.nanasa/instructions/reviewer-product.md]
        order: 0
messages:
  retentionPerGroup: 1000
```

## Set the repository

`repository.path` is relative to the configuration root and must remain inside
it. `checkout.kind: current` uses the current checkout. Managed-worktree
assignments can use a recorded checkout ID. See [Git worktrees](git-worktrees.md).

Nanasa asks Git to discover the checkout that contains `repository.path`. The
path can therefore be a subdirectory of a Git checkout. Integration `cwd`
selects the directory where the provider process starts and must remain inside
`repository.path`. When an agent is assigned a managed worktree, Nanasa maps
that relative working directory into the assigned checkout.

## Configure integrations

Each integration names a provider adapter and the direct command Nanasa starts.
`kind` is one of `copilot`, `claude-code`, `pi`, or `opencode`. `cwd` must remain
inside the repository. `environment` adds non-secret variables, but rejects
unsafe loader variables. Do not store tokens there.

`providerState` controls whether provider-owned authentication and sessions are
per agent, shared by an integration, or placed at a custom relative path.
`credentials` selects provider-managed login or a named private broker profile.
Read [Authentication](authentication.md) before changing either setting.

Use `providerState: { scope: membership }` unless agents intentionally share a
provider login and native session history. Membership scope gives every
configured agent its own directory under `.nanasa/integrations`. Integration
scope shares one directory among all agents using that integration. Custom
scope is for a deliberate provider-state layout and supports the
`{integrationId}` and `{agentId}` placeholders.

The integration `model.model` field sets a provider model for its agents. An
agent can override it with `desiredModel`. Use the exact model ID accepted by
that provider CLI. Nanasa passes the value to the provider and does not keep a
list of available models.

Model resume policy and native recovery policy control new launches and attempts
to resume a provider session. Extension IDs must exist in the top-level
`extensions` map. Remove unused integrations from the generated template before
running `doctor`. This command validates every configured executable, even when
no agent uses that integration.

## Define roles

A role is reusable work guidance. `instructions` adds role prompt files.
`permissionPolicy` is `inherit` or `read-only`. A read-only policy is an adapter
enforcement request, while prompt text describes expected behavior.

Optional presentation uses a supported icon and one of `amber`, `blue`, `cyan`,
`rose`, `slate`, `teal`, or `violet`. `shortName` can contain up to 24 characters.

## Add groups and agents

A group owns ordered agents, shared instructions, and messages. Each agent has a
repository-wide unique map key, a group-local unique `memberId`, an editable
name, and an `integrationId`. It may also select a role, model, checkout,
instruction files, and zero-based display order.

Stop an agent before changing its integration, role, checkout, or instructions.
Names and presentation can change without replacing a running prompt. The portal
writes topology changes atomically and keeps display order dense.

## Layer instructions

Top-level `instructions` apply globally. Group, role, and agent instruction
lists become more specific. Every path must be a unique repository-relative
UTF-8 Markdown file. See [Scoped prompts](prompts.md) for order and limits.

Nanasa composes each agent's effective prompt in this order:

```text
Built-in Nanasa coordination guidance
Built-in member ID, alias, role, and role-purpose assignment
Global instructions
Group instructions
Role instructions
Agent instructions
```

The built-in coordination section tells the provider that it is part of a
Nanasa-managed group and names the Nanasa MCP coordination tools. The assignment
section tells that runtime which member and role it represents. At launch,
Nanasa writes the composed prompt into a private provider overlay and registers
the authenticated `nanasa` MCP server when MCP is enabled. The MCP credential is
bound to the agent's group, member, run, and generation. An agent uses
`nanasa.list_members` to discover its current peers; peer identities do not need
to be duplicated in Markdown.

Provider-native repository instructions remain the provider's responsibility.
For example, Nanasa does not merge `AGENTS.md`, `CLAUDE.md`, or
`.github/copilot-instructions.md` into its own prompt. A provider may load those
files independently. Put cross-provider rules that every managed agent must
receive in a Nanasa global instruction file.

Later sections add specificity but do not erase earlier sections. Instruction
wording guides behavior; it does not grant permissions. Use role
`permissionPolicy`, provider controls, repository trust, and operating-system
boundaries for enforcement.

## Retain messages

`messages.retentionPerGroup` keeps the newest messages for each group. The
default is 1,000 and the allowed range is 1 to 100,000. Clearing history from
the portal removes the group's stored messages and delivery outcomes.

## Choose terminal checkpoints

Terminal checkpoints are disabled by default. When enabled, they retain bounded
previous output for recovery and assistive access. `repository-private` stores
private local content. Use `encrypted` only when your deployment provides the
required encryption handling. A checkpoint is not live terminal state and is
never replayed into a terminal.

## Configure provider extensions

The top-level `extensions` map pins provider extension versions. Integrations
opt into those IDs through their own `extensions` lists. Extensions are data and
reviewed assets, not arbitrary executable plugins. See
[Provider extensions](extensions.md).

## Know the defaults

Nanasa fills omitted optional values before storing the effective
configuration. Important defaults include:

| Field | Default |
|-------|---------|
| `repository.path` | `.` |
| `repository.checkout` | `{ kind: current }` |
| Instruction lists | `[]` |
| `providerState` | `{ scope: membership }` |
| `credentials` | `{ kind: provider-managed }` |
| `model.resumePolicy` | `preserve-session` |
| `nativeRecovery.mode` | `resume-or-restart` |
| Role `permissionPolicy` | `inherit` |
| `messages.retentionPerGroup` | `1000` |
| Terminal checkpoints | Disabled |

Defaults keep the YAML shorter, but explicit values are useful in examples and
shared configurations when the intended boundary should be visible during
review.

## Change a running configuration

Configuration changes are not all equivalent. Names, ordering, and
presentation affect the portal. Integrations, roles, checkouts, instruction
paths, and models affect how an agent launches. Stop affected agents before
changing launch-affecting fields. Global prompt changes affect every agent;
group prompt changes affect every agent in that group.

Nanasa stores a revision of the authored YAML and a separate revision of each
composed prompt. New runs receive newly generated provider overlays. Existing
runs keep the launch contract they started with rather than changing prompts in
place.

## Validate changes

Start with local checks:

```bash
npx nanasa setup
npx nanasa doctor
```

The generated [configuration schema](../reference/config.schema.json) describes
the authored YAML shape. Nanasa's configuration loader also checks file paths,
ownership, repository boundaries, provider state paths, and cross-references.
Run `npx nanasa setup` or `npx nanasa doctor` after every change. See the
[configuration reference](../reference/configuration.md) for field limits.

Use this sequence for a new or substantially changed configuration:

1. Stop agents affected by the change.
2. Edit `config.yaml` and create every referenced instruction file.
3. Run `npx nanasa setup` to validate and prepare provider homes.
4. Authenticate each required provider-state scope.
5. Run `npx nanasa doctor` to check commands, paths, and ownership.
6. Start Nanasa and launch the affected agents again.

Common failures are an unused integration whose executable is unavailable, an
instruction path that does not exist, the same instruction file referenced at
two scopes, a `cwd` outside `repository.path`, or an agent that names a missing
integration or role.
