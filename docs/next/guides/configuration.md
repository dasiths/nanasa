# Configure Nanasa

Package users can define integrations, roles, groups, agents, prompts, messages,
terminal checkpoints, and extensions in `.nanasa/config.yaml`.

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

`repository.path` is relative to the discovered repository root and must remain
inside it. `checkout.kind: current` uses the current checkout. Managed-worktree
assignments can use a recorded checkout ID. See [Git worktrees](git-worktrees.md).

## Configure integrations

Each integration names a provider adapter and the direct command Nanasa starts.
`kind` is one of `copilot`, `claude-code`, `pi`, or `opencode`. `cwd` must remain
inside the repository. `environment` adds non-secret variables, but rejects
unsafe loader variables. Do not store tokens there.

`providerState` controls whether provider-owned authentication and sessions are
per agent, shared by an integration, or placed at a custom relative path.
`credentials` selects provider-managed login or a named private broker profile.
Read [Authentication](authentication.md) before changing either setting.

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
