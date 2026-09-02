# Examples

Use these examples to choose a starting topology, provider-state policy, and
prompt layout. Every configuration fragment follows the same authored version 2
schema used by `.nanasa/config.yaml`.

## Start with one agent

The [minimal configuration](minimal/config.yaml) defines one integration and
one agent. Use it when learning the configuration IDs and first-run flow.

Follow [Start one agent](../getting-started/quickstart.md) for setup,
authentication, startup, and the first portal message.

## Build a two-agent team

The [first-team configuration](first-team/config.yaml) adds implementor and
reviewer roles, global and group guidance, role prompts, agent prompts, and a
read-only permission policy.

Follow [Build your first team](../getting-started/first-team.md) for the complete
task and authentication sequence.

## Run several coding-agent providers

The [multi-coding-agents walkthrough](multi-coding-agents.md) explains a
four-agent team that combines GitHub Copilot CLI, Pi, Claude Code, OpenCode,
scoped prompts, and authenticated MCP coordination.

Use this example when evaluating provider interoperability or designing a team
with separate project-manager, implementor, and reviewer responsibilities.

## Compare provider-state scopes

The authentication examples isolate the provider-state decision:

* [Membership scope](auth-scopes/membership.yaml) gives each agent a private home
* [Integration scope](auth-scopes/integration.yaml) shares one provider home
* [Custom scope](auth-scopes/custom.yaml) uses an explicit relative path pattern
* [Credential broker profiles](auth-scopes/credentials.example.json) show
  secret-free environment and helper references

Read [Authenticate the portal and providers](../guides/authentication.md) before
sharing provider state or configuring a credential broker.

## Continue to configuration

Read [Configure Nanasa](../guides/configuration.md) for path resolution,
identifiers, defaults, prompt composition, permissions, and safe configuration
changes. Use the [configuration reference](../reference/configuration.md) for
field-level constraints.