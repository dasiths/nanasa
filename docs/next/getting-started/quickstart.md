# Start one agent

Package users can follow this path from a clean Git repository to one running
agent. The example uses GitHub Copilot CLI. Replace the integration with another
[built-in provider](../guides/providers.md) if needed.

## Install and initialize

Install the exact preview and create the Nanasa configuration:

```bash
npm install --save-dev nanasa@next
npx nanasa init
```

Expected result: `.nanasa/config.yaml` and `.nanasa/.gitignore` exist.

## Keep one integration and add one agent

Replace `.nanasa/config.yaml` with this minimal authored configuration:

You can also copy the [minimal example](../examples/minimal/config.yaml).

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
    credentials: { kind: provider-managed }
groups:
  starter-team:
    name: Starter team
    agents:
      agent_builder:
        memberId: copilot.builder
        name: Builder
        integrationId: copilot
        order: 0
```

The configured agent map key is `agent_builder`. It appears directly below
`agents:` and remains stable across runs. The nested `memberId` is
`copilot.builder`; Nanasa uses it for messages and status. Do not pass the
`memberId` to `--agent`.

The generated template also defines Pi, OpenCode, and Claude Code. They are not
needed in this example, so the YAML removes them. This matters because `doctor`
checks every configured integration command, even when no agent uses it.

## Prepare and authenticate the provider home

Create the private directories:

```bash
npx nanasa setup
```

Expected result: Nanasa prints the path to `.nanasa/integrations`.

Now authenticate the exact membership-scoped agent:

```bash
npx nanasa auth login copilot --agent agent_builder
```

The provider CLI controls its own login flow. The `copilot` argument is the
integration map key. The `agent_builder` argument is the configured agent map
key from the YAML. Nanasa uses the same pair to find this provider home when it
starts the agent.

## Check and start Nanasa

Run diagnostics after removing unused integrations:

```bash
npx nanasa doctor
```

Expected result: `Nanasa doctor passed for 1 integrations`.

Start the daemon and portal:

```bash
npx nanasa start
```

Keep that terminal open. Expected result: the daemon becomes ready at
<http://127.0.0.1:3210>.

## Open the portal and send a task

In another terminal, create a short-lived, one-use portal login URL:

```bash
npx nanasa auth portal
```

Open the printed URL. This signs your browser into the portal. Portal
authentication controls human access to the web interface. It is separate from
the provider login completed earlier.

Select **Starter team**, then select **Start** for **Builder**. The status should move
from starting to running. Open **Messages**, choose Builder as the recipient,
enter a small repository task, and send it. Message delivery means the text
reached the agent's terminal input. It does not mean the agent understood or
completed the task. Review agent status and terminal output for completion.

## Continue

* [Add an implementor and read-only reviewer](first-team.md)
* [Add global, group, role, and agent prompts](../guides/prompts.md)
* [Enable agent messaging through MCP](../guides/messaging-and-mcp.md)
* [Run Nanasa as a user service](../guides/services.md)
