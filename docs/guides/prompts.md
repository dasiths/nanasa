# Add scoped prompts

Package users can add repository guidance at global, group, role, and agent
scope without replacing the provider's own instructions.

## Plan the scopes

Nanasa builds the effective prompt in this order:

```text
Nanasa built-in coordination and assignment guidance
Global instructions
Group instructions
Role instructions
Agent instructions
```

Later scopes are more specific, but they do not erase earlier text. Put rules
that apply everywhere at global scope. Put team conventions at group scope.
Describe one responsibility at role scope. Reserve agent scope for one stable
agent's special assignment.

## Lay out the files

A repository can use this layout:

```text
.nanasa/
  config.yaml
  instructions/
    global.md
    groups/
      product.md
    roles/
      implementor.md
    agents/
      api-builder.md
```

Each path must be repository-relative, end in `.md`, stay inside the repository,
and point to a regular UTF-8 file owned by the current user. Symlinks and NUL
characters are rejected.

## Connect every scope

```yaml
instructions:
  - .nanasa/instructions/global.md
roles:
  implementor:
    name: Implementor
    instructions:
      - .nanasa/instructions/roles/implementor.md
    permissionPolicy: inherit
groups:
  group_product:
    name: Product
    instructions:
      - .nanasa/instructions/groups/product.md
    agents:
      agent_api_builder:
        memberId: copilot.api-builder
        name: API Builder
        integrationId: copilot
        roleId: implementor
        instructions:
          - .nanasa/instructions/agents/api-builder.md
```

Possible content includes:

* Global: required validation, security rules, and repository-wide style
* Group: owned folders, shared vocabulary, and coordination expectations
* Role: implementation or review procedure
* Agent: a narrow component assignment or stable tool preference

One instruction file may appear only once anywhere in the configuration. This
rule makes the source and order of every prompt section clear. Split shared
ideas into separate files instead of referencing one file at two scopes.

## Separate wording from permission

A role combines instructions with a permission policy:

```yaml
roles:
  reviewer:
    name: Reviewer
    instructions: [.nanasa/instructions/roles/reviewer.md]
    permissionPolicy: read-only
```

The Markdown tells the reviewer to inspect and report. `permissionPolicy:
read-only` asks the provider adapter to enforce a write-denial floor. Wording is
not a security boundary. Provider support differs, so review the
[provider notes](providers.md).

## Respect prompt limits

Each scope can list at most 32 paths. Each instruction file can contain at most
64 KiB. The complete built-in and user prompt can contain at most 256 KiB.
Configuration itself also has a 256 KiB limit.

Nanasa writes a private composed prompt and manifest under the selected provider
home when an agent launches. Provider defaults, repository instructions,
managed policy, preferences, and unrelated settings remain active.

## Apply a prompt change

Stop affected agents before changing global, group, role, or agent instructions.
Global changes affect every agent. Group changes require every agent in that
group to be stopped. Nanasa rejects prompt-affecting live edits rather than
silently changing a running agent's contract.

After editing, run `npx nanasa setup` to validate paths and sizes, then start the
agents again. Inspect the portal status and terminal to confirm a new run starts.
