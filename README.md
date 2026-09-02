# Nanasa

Nanasa (නැනස) is a local-first orchestrator for running and observing multiple
coding-agent terminals. The name means "wisdom" or "intellect" in Sinhala.

Nanasa runs a team of coding-agent command-line tools in one Git repository.
It gives each agent a durable tmux terminal, a role, private provider state, and
a place to exchange messages. You operate the team from an accessible local web
portal.

Nanasa is prerelease software. Configuration and interfaces can change between
preview versions.

## Requirements

* Linux with glibc on x64 or arm64
* Node.js 22 or 24
* tmux 3.2 or later
* Git and OpenSSH
* At least one supported agent CLI: GitHub Copilot CLI, Claude Code, Pi, or
  OpenCode

Native macOS and Windows hosts are not supported. WSL2 support is in preview.

## Install and start

Install the current preview in the Git repository where the agents will work:

```bash
npm install --save-dev nanasa@next
```

Then follow this short path:

```bash
npx nanasa init
npx nanasa setup
npx nanasa auth login copilot --agent agent_builder
npx nanasa doctor
npx nanasa start
```

Before `setup`, edit `.nanasa/config.yaml`. Keep only integrations whose agent
CLIs are installed, and add the `agent_builder` agent shown in the
[quickstart](docs/next/getting-started/quickstart.md).
`doctor` checks every configured integration, including unused defaults.

`auth login` signs the provider CLI into Nanasa's private home for the configured
agent. The value after `--agent` is the agent map key in the YAML, not its
`memberId`. Provider login is separate from the one-use URL used to sign into
the portal.

When the daemon starts, it serves the portal at <http://127.0.0.1:3210>. In
another terminal, run `npx nanasa auth portal` and open the URL it prints.

![Nanasa portal showing groups, agent status, terminals, and messages](screenshot.png)

## Documentation

Run `npx nanasa docs` to print the packaged documentation index, even before
initializing a repository.

* [Install Nanasa](docs/next/getting-started/install.md)
* [Complete the quickstart](docs/next/getting-started/quickstart.md)
* [Configure teams and providers](docs/next/guides/configuration.md)
* [Solve common problems](docs/next/troubleshooting/index.md)
* [Contribute to Nanasa](docs/next/development/contributing.md)

## License

Nanasa is available under the [MIT License](LICENSE).
