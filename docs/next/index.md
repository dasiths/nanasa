# Nanasa documentation

Nanasa runs and coordinates a local team of coding-agent terminals in one Git
repository.

New package users should start with the [quickstart](getting-started/quickstart.md).
It takes you from installation to a running agent and a portal message.

## Start using Nanasa

1. [Install Nanasa and its host tools](getting-started/install.md)
2. [Start one agent](getting-started/quickstart.md)
3. [Build a two-agent team](getting-started/first-team.md)

Existing users can go directly to [configuration](guides/configuration.md),
[provider authentication](guides/authentication.md), or
[everyday portal use](guides/portal.md).

Explore the [examples catalog](examples/index.md) for minimal, multi-agent, and
provider-state configurations.

## Configure and use a team

* [Configuration](guides/configuration.md)
* [Scoped prompts](guides/prompts.md)
* [Portal and provider authentication](guides/authentication.md)
* [Built-in providers](guides/providers.md)
* [Portal and everyday use](guides/portal.md)
* [Messaging and Model Context Protocol](guides/messaging-and-mcp.md)
* [Git worktrees](guides/git-worktrees.md)
* [Provider extensions](guides/extensions.md)

## Operate Nanasa

* [Run a user service](guides/services.md)
* [Connect from another computer](guides/remote-access.md)
* [Understand state and recovery](concepts/state-and-recovery.md)
* [Review security boundaries](concepts/security.md)
* [Troubleshoot by symptom](troubleshooting/index.md)

## Develop or integrate

* [CLI reference](reference/cli.md)
* [Configuration reference](reference/configuration.md)
* [HTTP, events, terminal, and MCP protocols](reference/protocols.md)
* [Contributing](development/contributing.md)
* [Testing](development/testing.md)
* [Release and rollback](development/release.md)
* [Support matrix](development/support-matrix.md)

## Small glossary

* An **agent** is one configured identity that runs a coding-agent CLI.
* An **integration** tells Nanasa which CLI to run and where its provider state
  belongs.
* A **role** adds a responsibility, prompt instructions, permissions, and portal
  presentation.
* A **group** is an ordered set of agents with shared instructions and messages.
* A **run** is one process generation for an agent.
* A **member ID** is the agent's stable communication identity, such as
  `copilot.builder`. It is not the configured agent map key used by `--agent`.
