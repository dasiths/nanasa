# Build your first team

Package users can build a two-agent team with one implementor and one read-only
reviewer. Both agents use one Copilot integration, but membership-scoped state
gives each configured agent a separate provider home.

## Create instruction files

Create these repository files before loading the configuration:

```text
.nanasa/
  config.yaml
  instructions/
    global.md
    team.md
    implementor.md
    reviewer.md
    builder.md
    review-agent.md
```

Put repository-wide rules in `.nanasa/instructions/global.md` and shared team
rules in `.nanasa/instructions/team.md`. Tell the implementor to make and
validate focused changes in `implementor.md`. Tell the reviewer to report
prioritized findings without modifying files in `reviewer.md`. Use `builder.md`
and `review-agent.md` for instructions that apply to only one configured agent.

## Configure the roles and agents

Use this structure in `.nanasa/config.yaml`:

```yaml
version: 2
repository:
  path: .
  checkout: { kind: current }
instructions:
  - .nanasa/instructions/global.md
integrations:
  copilot:
    name: GitHub Copilot
    kind: copilot
    cwd: .
    providerState: { scope: membership }
    credentials: { kind: provider-managed }
roles:
  implementor:
    name: Implementor
    instructions: [.nanasa/instructions/implementor.md]
    permissionPolicy: inherit
  reviewer:
    name: Reviewer
    instructions: [.nanasa/instructions/reviewer.md]
    permissionPolicy: read-only
groups:
  first-team:
    name: First team
    instructions: [.nanasa/instructions/team.md]
    agents:
      agent_builder:
        memberId: copilot.builder
        name: Builder
        integrationId: copilot
        roleId: implementor
        instructions: [.nanasa/instructions/builder.md]
        order: 0
      agent_reviewer:
        memberId: copilot.reviewer
        name: Reviewer
        integrationId: copilot
        roleId: reviewer
        instructions: [.nanasa/instructions/review-agent.md]
        order: 1
messages:
  retentionPerGroup: 1000
```

The [complete first-team example](../examples/first-team/config.yaml) includes
the matching instruction files. Copy its configuration and instruction content
into the repository's `.nanasa` directory if you prefer not to type the example.

The role prompt tells the reviewer what to do. The `read-only` permission policy
also asks the provider adapter to enforce a write-denial floor. Prompt wording
alone is not a permission boundary.

## Authenticate both private homes

Prepare the directories, then log in once for each configured agent map key:

```bash
npx nanasa setup
npx nanasa auth login copilot --agent agent_builder
npx nanasa auth login copilot --agent agent_reviewer
npx nanasa doctor
```

Do not use `copilot.builder` or `copilot.reviewer` after `--agent`. Those are
member IDs. The two login commands and the later runs resolve the same two
private homes under `.nanasa/integrations/`.

## Start and use the team

Start Nanasa, run `npx nanasa auth portal` in another terminal, and open the
one-use URL. Select **First team**, then choose **Start all**. Both agents should
gain their own terminal and status.

Open **Messages** and send the implementation task directly to Builder.
After the implementation settles, send Reviewer a request to inspect the same
working tree and report findings. Delivery confirms terminal input, not task
completion. Use the status and attention indicators, message replies, and
terminal output to decide when the work is complete.

For fuller prompt layering, continue to [Scoped prompts](../guides/prompts.md).
