# Choose a built-in provider

Package users can connect each agent to GitHub Copilot CLI, Claude Code, Pi, or
OpenCode. Install the provider executable yourself before running `doctor`.

Each integration runs its command directly in a tmux pane. Nanasa adds a scoped
prompt, status reporting, optional Model Context Protocol (MCP) messaging, and a
provider-state home. It does not replace the provider's login or model service.
Choose state sharing in the [authentication guide](authentication.md).

## GitHub Copilot CLI

Use `kind: copilot` and the default command `[copilot]`. Authenticate with
`npx nanasa auth login <integration-key>`, adding `--agent <agent-map-key>` for
membership state. Nanasa sets isolated Copilot home and cache paths, creates a
custom agent for the effective prompt, and installs only its named status hook
and MCP entry.

The read-only role uses Copilot's supported permission controls as an adapter
denial floor. Native sessions can resume when preserved session evidence still
matches the agent run. Existing preferences, provider authentication, user
hooks, and unrelated MCP servers in the selected home remain provider-owned.

## Claude Code

Use `kind: claude-code` and the default command `[claude]`. Run the same provider
login command with the configured integration key and any required agent map
key. Nanasa selects an isolated `CLAUDE_CONFIG_DIR`, appends the effective prompt
file, and owns only its named MCP and reporter settings.

Claude Code can report lifecycle and permission waits. Read-only behavior uses
the adapter's closed launch strategy and should not be treated as
operating-system isolation. Resume is attempted only with validated native
session evidence; otherwise Nanasa starts a new native session.

## Pi

Use `kind: pi` and the default command `[pi]`. Nanasa selects an isolated
`PI_CODING_AGENT_DIR`, appends the effective prompt, and provisions its pinned
MCP adapter and lifecycle extension. A read-only role adds a Nanasa-owned Pi
extension that blocks shell, edit, and write tool calls.

Pi provider state keeps authentication and native sessions in the selected
scope. Resume falls back to a new process when the stored session cannot be
validated. Keep the packaged Pi MCP adapter version aligned with the Nanasa
release.

## OpenCode

Use `kind: opencode` and the default command `[opencode]`. Nanasa selects
isolated XDG configuration, data, state, and cache roots. It creates a primary
agent that references the effective prompt and adds its named remote MCP and
status integration.

OpenCode state and login remain provider-owned. Nanasa preserves unrelated
configuration in the selected home. Read-only support is limited to the closed
adapter policy supported by the current provider package. Resume requires a
matching provider-native session.

## Check provider readiness

Remove all unused integrations from `.nanasa/config.yaml`, then run:

```bash
npx nanasa setup
npx nanasa doctor
```

`doctor` checks every configured executable. An unused default integration with
a missing command fails the check. Provider authentication failures normally
appear only when the agent CLI starts, so run the scoped login first. For
symptom-based help, see [Provider troubleshooting](../troubleshooting/providers.md).
