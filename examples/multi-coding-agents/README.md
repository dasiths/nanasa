# Run the multi-coding-agents example

This example runs four coding-agent processes as one Nanasa-managed team. It is
the repository's dogfooding configuration, but its configuration, commands,
instructions, and private runtime state are isolated beneath this directory.

## Know what the example starts

| Agent | Integration | Role | Permission policy |
|-------|-------------|------|-------------------|
| Project Manager | GitHub Copilot CLI | Project Manager | Inherit |
| Engineer 1 | Pi | Implementor | Inherit |
| Engineer 2 | Claude Code through LiteLLM | Implementor | Inherit |
| Reviewer | OpenCode | Reviewer | Read-only |

The configuration also declares a direct Claude Code integration so operators
can add or reassign an agent without rewriting the provider definition.
`doctor` checks every declared integration, including integrations without a
current agent.

## Install the prerequisites

Use the repository development container or install the host requirements from
the main [installation guide](../../docs/next/getting-started/install.md). This
example expects GitHub Copilot CLI, Pi, OpenCode, Claude Code, tmux, Docker, and
the repository's Node.js and pnpm toolchain.

Run product dependency installation from the repository root:

```bash
make install
```

## Understand the prompt scopes

The example composes every agent prompt from the built-in Nanasa sections and
these checked-in files:

| Scope | Files |
|-------|-------|
| Global | `.nanasa/instructions/nanasa-mcp.md`, `.nanasa/instructions/team.md` |
| Group | `.nanasa/instructions/groups/agent-team.md` |
| Project Manager role | `.nanasa/instructions/project-manager.md` |
| Implementor role | `.nanasa/instructions/implementor.md` |
| Reviewer role | `.nanasa/instructions/reviewer.md` |
| Agent | None |

Global guidance reaches every configured agent. Group guidance reaches the
Backend Team. Each agent then receives the instruction file for its assigned
role. Nanasa also injects the member ID, alias, role, MCP coordination guidance,
and an authenticated MCP server configuration at launch.

See [Configure Nanasa](../../docs/next/guides/configuration.md) for the complete
configuration model and [Add scoped prompts](../../docs/next/guides/prompts.md)
for composition rules and limits.

## Prepare private state

From the repository root, run:

```bash
make example-setup
make example-doctor
```

The setup target builds the local Nanasa package and creates private provider
homes under `examples/multi-coding-agents/.nanasa/integrations`. The doctor
target validates the nested configuration, instruction files, ownership, and
all five provider commands.

The example starts with clean private state. Provider homes from an older root
`.nanasa` directory are deliberately not copied into this directory.

## Authenticate providers

Authentication is interactive. Run the targets separately when you want to
control each provider's login flow:

```bash
make -C examples/multi-coding-agents auth-copilot
make -C examples/multi-coding-agents auth-pi
make -C examples/multi-coding-agents auth-opencode
make -C examples/multi-coding-agents auth-litellm
```

The first three targets use `nanasa auth login` with the exact configured agent
ID. This writes provider-owned credentials to that agent's membership-scoped
home. The LiteLLM target authenticates the Docker-backed GitHub Copilot gateway
used by Engineer 2.

Use `make -C examples/multi-coding-agents auth` to run all four flows in order.
Do not commit anything created under `.nanasa/integrations`.

## Start the example

Start the LiteLLM gateway first because Engineer 2 uses it:

```bash
make -C examples/multi-coding-agents proxy-start
make example-start
```

`example-start` builds the package and starts Nanasa with authenticated MCP
enabled. Keep that terminal open. In another terminal, mint and open a one-use
portal URL:

```bash
make example-portal-auth
```

Select **Backend Team** in the portal and start the agents. Each runtime receives
a group-bound MCP credential and can use `nanasa.list_members` to discover its
peers. Messages, progress, direct requests, and status remain scoped to the
group represented by that credential.

## Run source development mode

Use this target while changing the daemon or portal:

```bash
make example-dev
```

It runs the root daemon and portal watchers with `NANASA_REPO_ROOT` set to this
example directory and MCP enabled. The development portal defaults to
<http://127.0.0.1:5173>.

## Operate the Claude gateway

The example owns these gateway targets:

```bash
make -C examples/multi-coding-agents proxy-status
make -C examples/multi-coding-agents proxy-logs
make -C examples/multi-coding-agents proxy-stop
```

The Claude Code adapter recognizes the `make claude-copilot` wrapper and passes
its generated arguments through the `CLAUDE_ARGS` Make variable. The target
prepares the isolated Claude home and starts Claude Code against the LiteLLM
endpoint.

## Keep local state private

The nested `.nanasa/.gitignore` excludes `integrations`, `runtime`, and `state`.
These directories contain provider credentials, generated overlays, sessions,
database state, operator authentication, and MCP signing material.

The `reset-alpha` target is destructive. It backs up recognized alpha state and
replaces the example configuration with the package template. Use it only for
an intentional alpha-state migration, not as routine cleanup.

The example is inside the outer Nanasa Git checkout. Starting an agent in this
directory is not filesystem sandboxing. Use provider permission controls,
separate worktrees, containers, or operating-system isolation when the task
requires a stronger boundary.