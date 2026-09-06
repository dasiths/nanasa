---
title: Run the multi-coding-agents example
description: Operate Backend and Frontend teams in separate Git workspaces with one Nanasa daemon
---

This example runs six coding-agent processes in two teams under one Nanasa
daemon. Backend uses the current checkout and branch. Frontend uses a linked
worktree on a separate branch, assigned through the portal before starting its
agents. Configuration, commands, instructions, and private runtime state remain
under this example directory.

## Know what the example starts

| Team | Agent | Integration | Role | Permission policy |
|------|-------|-------------|------|-------------------|
| Backend | Project Manager | GitHub Copilot CLI | Project Manager | Inherit |
| Backend | Engineer 1 | Pi | Implementor | Inherit |
| Backend | Engineer 2 | Claude Code through LiteLLM | Implementor | Inherit |
| Backend | Reviewer | OpenCode | Reviewer | Read-only |
| Frontend | Frontend Engineer | Pi | Implementor | Inherit |
| Frontend | Frontend Reviewer | OpenCode | Reviewer | Read-only |

The existing Backend IDs and provider homes are unchanged. Frontend reuses the
Pi and OpenCode definitions with stable IDs `frontend-builder` and
`frontend-reviewer` in `team-frontend`. It does not have a project manager;
cross-team requirements and decisions go through the Human.

The configuration also declares a direct Claude Code integration so operators
can add or reassign an agent without rewriting the provider definition.
`doctor` checks every declared integration, including integrations without a
current agent.

Every integration selects the checked-in `autonomous` execution profile. The
provider adapters translate that profile into native continuation, question,
and approval controls. The reviewer remains read-only because its role denial
floor wins over autonomous grants.

Each provider kind also references a native JSON file beneath
`.nanasa/providers`. These files are intentionally empty starting points for
consumer MCP servers. Nanasa snapshots and composes them with its own generated
coordination MCP configuration.

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
| Backend group | `.nanasa/instructions/groups/agent-team.md` |
| Frontend group | `.nanasa/instructions/groups/frontend-team.md` |
| Project Manager role | `.nanasa/instructions/project-manager.md` |
| Implementor role | `.nanasa/instructions/implementor.md` |
| Reviewer role | `.nanasa/instructions/reviewer.md` |
| Agent | None |

Global guidance reaches every configured agent. Each team receives only its own
group guidance, then each agent receives its role instructions. Backend owns
`apps/daemon`; Frontend owns `apps/portal`. Coordinate shared contract changes
through the Human. Nanasa also injects the member ID, alias, role, MCP
coordination guidance, and authenticated MCP configuration at launch.

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
make -C examples/multi-coding-agents auth-frontend
```

The first three targets use `nanasa auth login` with the exact configured agent
ID. This writes provider-owned credentials to that agent's membership-scoped
home. The LiteLLM target authenticates the Docker-backed GitHub Copilot gateway
used by Engineer 2.

The Frontend target authenticates Pi and OpenCode for the two new agent IDs.
Their membership-scoped homes are separate from Backend's homes even though
they use the same integrations. Reuse a provider's supported login mechanism;
do not copy credentials or private homes into a worktree.

Use `make -C examples/multi-coding-agents auth` to run both teams' flows in order.
If Backend is already authenticated, only `auth-frontend` is needed for the new
agents. Do not commit anything created under `.nanasa/integrations`.

The `first-run` target stops after setup and diagnostics, then prints the three
commands required to authenticate providers, start the gateway, and start
Nanasa. It does not launch unauthenticated agents. Portal authentication is a
separate browser login and does not replace these provider flows.

## Start the example

Start the LiteLLM gateway first because Engineer 2 uses it:

```bash
make -C examples/multi-coding-agents proxy-start
make example-start
```

`example-start` builds the package and starts Nanasa with authenticated MCP
enabled. The example Makefile exports `NANASA_ALLOW_AUTONOMOUS=true` and
`NANASA_ALLOW_PROVIDER_FILES=true` as the operator-owned authorization for its
checked-in profile and files. Keep that terminal open. In another terminal,
mint and open a one-use portal URL:

```bash
make example-portal-auth
```

Select **Backend Team** in the portal and start the agents. Each runtime receives
a group-bound MCP credential and can use `nanasa.list_members` to discover its
peers. Messages, progress, direct requests, and status remain scoped to the
group represented by that credential.

## Assign the two workspaces

Use **All agents** for a read-only configuration overview before starting a team.
Group by team or provider and select an agent to inspect its workspace, mapped
starting folder, provider state scope, credential mode, execution profile, role
restrictions, model policy, and ordered prompt sources. Provider MCP files are
listed separately from prompt layers. These configured values do not certify
that authentication or runtime policy authorization is ready.

The selected agent has **Open team** and **Open terminal** actions. Open terminal
targets that agent's latest live terminal; it is disabled when none exists.
Open team remains available for starting agents or viewing their team.

Keep one daemon running from the primary example directory. Do not start a
second Nanasa daemon from the Frontend worktree.

On a fresh daemon, both teams initially fall back to the primary checkout.
Assign Frontend's separate worktree before starting its agents.

1. Open **Team workspaces**. Confirm Backend uses the primary checkout and the
	current branch. An existing local assignment is preserved, so review it
	rather than assuming configuration edits reset it.
2. Keep Frontend stopped. Click **Add workspace**, choose **Create new**, enter
	`feature/frontend`, and use `HEAD` as the starting revision. Select
	**Frontend Team** and check **Use for this team immediately** before creating.
3. Alternatively, use **Attach existing** for a worktree already created from
	this repository. It remains external and Nanasa cannot remove it as managed.
4. Verify Frontend's row shows the new branch and linked checkout, then start
	Frontend's agents. All members inherit the team's workspace.

New worktrees contain committed files from the base revision, not uncommitted
primary edits. Commit the sample files required by a launcher before creating a
worktree from them. Neither team should change the other's branch or checkout.

The **Start from** field accepts a branch, tag, commit ID, or Git revision such
as `HEAD~1`. `HEAD` means the source checkout's current commit. Autocomplete
offers up to 500 locally known branches, remote-tracking branches, and tags;
manual entry still works if suggestions are unavailable.

Use **Fetch updates** on Team workspaces to run `git fetch --all --prune` inside
the repository, then refresh checkout statuses. This updates remote-tracking
refs and future suggestions without merging, rebasing, or checking out files.
Remote authentication must already work in the daemon's environment; fetch
failures are displayed in the portal. The per-workspace refresh icon only
refreshes local status and does not contact remotes.

If agents are already active, change the workspace through the reviewed switch
dialog; creation alone does not restart a team.

Workspace assignments live in local SQLite state, not in this YAML. They survive
daemon restarts and config reconciliation. A linked checkout belongs to one
team; the primary checkout may be shared. Returning Frontend to primary and
stopping its runs releases the managed worktree for removal. Branch integration
and merging remain explicit Git operations outside Nanasa.

## Understand the working directories

The integrations keep `cwd: .`, relative to this nested configuration root.
Nanasa maps that same directory into each team's selected checkout:

```text
Backend:  <primary>/examples/multi-coding-agents
Frontend: <frontend-worktree>/examples/multi-coding-agents
```

Agents find their own checkout root with `git rev-parse --show-toplevel` and
resolve paths such as `apps/portal` from there. They must not hardcode the
primary path or assume the starting directory is the Git root.

Managed worktrees are created beside the Git checkout in `.nanasa-worktrees`,
not beside the nested configuration directory. In the development container,
that is `/workspaces/.nanasa-worktrees/nanasa/<branch-slug>`, backed by the host
sibling mount. Git administrative links are relative. Previously created
worktrees are not moved automatically.

The two checkouts can evolve independently, but MCP communication remains
team-scoped. Use an operator-agreed API contract and relay cross-team handoffs
through the Human. A worktree contains the whole repository and is not a sandbox.

## Review changes before restarting

After changing the example configuration or one of its provider MCP files, the
portal warns that active agents may need a restart. Choose **Stop all**, confirm
that their terminal panes can close, and start the team again.

Engineer 2 uses repository launcher code, so its first start pauses for custom
launch consent. Review `sh bin/claude-copilot`, the `append` strategy, and the
displayed script digest, then select **Trust and start**. Nanasa reuses that
approval on later launches while the consent subject and script contents remain
unchanged.

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

The configured `bin/claude-copilot` script checks gateway health, prepares the
isolated Claude home, exports the Anthropic gateway variables, and executes
Claude Code. Its `append` launcher strategy preserves generated prompt, MCP,
model, settings, and reporter arguments as separate command arguments.

The script resolves the example and product roots from its own location, so it
does not depend on the provider's current directory. Nanasa hashes this checked-in
script as part of the consent subject. Editing it requires another approval.
Consent approves repository code; it does not sandbox the script or every file,
interpreter, or executable that the script can load.

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