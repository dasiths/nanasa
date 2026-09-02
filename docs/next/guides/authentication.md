# Authenticate the portal and providers

Package users can keep human portal access separate from the credentials used by
coding-agent providers.

## Know the two login types

Portal authentication signs a person into the local web interface. Provider
authentication signs a coding-agent CLI into its model provider. One does not
replace the other, and their credentials live in different private state.

Do not put tokens, passwords, or private keys in `.nanasa/config.yaml`.

## Sign into the portal

Start the daemon, then run this command in the repository from another terminal:

```bash
npx nanasa auth portal
```

Nanasa prints a short-lived, one-use URL. Open it in the browser that will use
the portal. The URL fragment is exchanged for an HttpOnly browser session. A
new URL does not revoke existing sessions. If a session expires, mint another
URL. Portal login does not authenticate any provider CLI.

## Use isolated membership state

Membership state is the default. Each configured agent gets its own provider
home and sessions:

See the [complete membership example](../examples/auth-scopes/membership.yaml).

```yaml
integrations:
  copilot:
    name: GitHub Copilot
    kind: copilot
    command: [copilot]
    cwd: .
    providerState: { scope: membership }
    credentials: { kind: provider-managed }
groups:
  group_product:
    name: Product
    agents:
      agent_builder:
        memberId: copilot.builder
        name: Builder
        integrationId: copilot
```

Authenticate after the agent exists in configuration:

```bash
npx nanasa setup
npx nanasa auth login copilot --agent agent_builder
```

`--agent` takes the configured map key under
`groups.<group-id>.agents`. Here it is `agent_builder`. It does not take the
nested `memberId`, `copilot.builder`. Nanasa uses the integration key and agent
map key to resolve the same private state directory during login and every run.

Use membership state when agents need separate provider sessions or settings.
No provider home is shared. Files remain private to the operating-system user,
but agents still run as that same user.

## Share integration state

Integration state gives all agents using an integration one provider home:

See the [complete integration example](../examples/auth-scopes/integration.yaml).

```yaml
integrations:
  copilot:
    name: Shared GitHub Copilot
    kind: copilot
    command: [copilot]
    cwd: .
    providerState: { scope: integration }
    credentials: { kind: provider-managed }
```

Authenticate once without `--agent`:

```bash
npx nanasa setup
npx nanasa auth login copilot
```

Use this scope when the provider supports shared state and every agent may share
its login, preferences, and provider-native sessions. It reduces repeated
login, but one agent can affect provider-owned state seen by another. Nanasa's
run identities and prompts remain separate; provider state does not.

## Choose a custom state path

Custom state uses a path relative to `.nanasa/integrations/`:

See the [complete custom-path example](../examples/auth-scopes/custom.yaml).

```yaml
integrations:
  copilot:
    name: Custom GitHub Copilot
    kind: copilot
    command: [copilot]
    cwd: .
    providerState:
      scope: custom
      path: homes/{integrationId}/{agentId}
    credentials: { kind: provider-managed }
```

Because this pattern contains `{agentId}`, authenticate with the configured
agent map key:

```bash
npx nanasa auth login copilot --agent agent_builder
```

A custom pattern without `{agentId}` is shared and omits `--agent`. Allowed
placeholders are `{integrationId}` and `{agentId}`. The path cannot be absolute,
traverse upward, or escape through symlinks. Use this advanced scope only when a
known directory layout is required. A shared pattern has the same state-sharing
risk as integration scope.

## Use a credential broker profile

Provider-managed login is preferred when the CLI supports it. For short-lived
environment credentials, configure a named profile in the private user file:

```text
$XDG_CONFIG_HOME/nanasa/credentials.json
```

When `XDG_CONFIG_HOME` is unset, the path is
`~/.config/nanasa/credentials.json`. This file is not
`.nanasa/credentials.json` and must not be committed. Create it as a regular
file owned by the current user with mode `0600`; its directory should use mode
`0700`.

An environment profile has this shape:

The [secret-free broker example](../examples/auth-scopes/credentials.example.json)
contains matching environment and helper profiles.

```json
{
  "version": 1,
  "profiles": {
    "copilot-from-environment": {
      "provider": "copilot",
      "source": "environment",
      "sourceEnvironment": "NANASA_EXAMPLE_GITHUB_TOKEN",
      "targetEnvironment": "GH_TOKEN"
    }
  }
}
```

A helper profile replaces `sourceEnvironment` with a bounded command:

```json
{
  "version": 1,
  "profiles": {
    "claude-from-helper": {
      "provider": "claude-code",
      "source": "helper",
      "targetEnvironment": "ANTHROPIC_API_KEY",
      "helperCommand": ["pass", "show", "nanasa/claude-code"]
    }
  }
}
```

Use only a target environment name allowed by the selected provider adapter.
Reference the profile without placing its secret in repository configuration:

```yaml
credentials:
  kind: broker-profile
  profileId: copilot-from-environment
```

The [credential profile configuration example](../examples/auth-scopes/credential-profiles.yaml)
references both profiles from a complete authored configuration.

The broker reads one value from the environment or helper output and injects it
only into the provider process. Missing, multiline, oversized, mismatched, or
unsupported credentials fail closed. The security of a helper is your
responsibility. Keep its executable and configuration private.
