# CLI reference

Package users and integration authors can call local lifecycle commands before
the daemon starts and control commands after it is ready.

## Command behavior

Use the repository-local executable in package-user commands:

```bash
npx nanasa --help
npx nanasa --version
```

Control commands print compact JSON by default. Exit code 0 means success, 1
means an operational failure, and 2 means invalid command usage. `run recover`
prints a plain summary by default and uses exit code 3 when approval is required
but no recovery failed. Commands that mutate through the control API may require
`--body <json>` with fields from the [generated CLI registry](cli.json).

Every failure writes one compact JSON object to standard error with `message`,
`details`, and `code` fields. The message is suitable for people, the code is a
stable machine-readable identifier, and details contain optional diagnostics.
Usage failures use the same shape and retain exit code 2.

Shared control options include:

* `--body <json>` for request payloads on commands that accept or require a body
* `--api-url <url>` or `NANASA_API_URL` for an explicit loopback control endpoint
* `--operator-token-file <path>` for an alternate owner-only operator credential
* `--idempotency-key <key>` for mutating routes that permit idempotency
* `--request-id <id>` for request correlation
* `--output json|text` and the `--json` shorthand for output selection
* `--timeout <milliseconds>` for a value from 1 through 300000

`auth login` additionally accepts `--agent <agent-map-key>`. Remote operations use
`--repo <absolute-path>`. Commands reject unknown options, bodies on body-free routes,
and idempotency keys on routes that forbid them.

## Bootstrap and local lifecycle

```text
npx nanasa init
npx nanasa setup
npx nanasa doctor
npx nanasa auth login <integration-key> [--agent <agent-map-key>]
npx nanasa auth portal
npx nanasa docs
npx nanasa start [--host <host>] [--port <port>] [--mcp | --no-mcp]
npx nanasa stop [--timeout <milliseconds>] [--output json|text]
npx nanasa service install [--host <host>] [--port <port>] [--mcp | --no-mcp]
npx nanasa reset --from-alpha --confirm <repository-root>
```

`init` creates configuration when absent. `setup` prepares private provider
homes. `doctor` validates all configured integrations. Provider login may run
before the daemon. Portal login requires a running daemon. `docs` prints the
absolute path to the packaged help index and works outside a repository.

Running `npx nanasa` with no command is the same as `start`. The default address
is `127.0.0.1:3210`. Authenticated MCP is enabled by default because managed teams
use it for coordination, and it requires a loopback listener. Use `--no-mcp` only
for a deliberate diagnostic or single-agent session without coordination tools.

For startup settings, command-line options override their `NANASA_*` environment
equivalents, which override product defaults. `service install` persists the resolved
host, port, and MCP state in the owner-only service environment file.

### Stop a running daemon

Run `npx nanasa stop` from the repository or a nested directory. The equivalent
command is `npx nanasa daemon stop`. This is useful when a second `start` reports
that another daemon already holds mutable authority.

Stop verifies the repository's owner-only lock and process start identity before
sending SIGTERM, then waits up to 30 seconds for that process to exit. Use
`--timeout <milliseconds>` to change that limit. It does not force-kill a process
on timeout or signal a reused PID. No running daemon is a successful no-op.

The command preserves configuration, credentials, database state, and managed
tmux agent sessions. It prints a short status by default; `--json` or
`--output json` returns a structured result. No HTTP port or operator token is
needed, even if startup used a different port or `NANASA_RUNTIME_PATH`.
For a systemd-managed installation, `npx nanasa service stop` remains available
to stop the repository's user service through systemd.

### Reset alpha state

The alpha reset is destructive. It creates a verified backup, reports a redacted
inventory, removes owned runtime state, and initializes the current schema. Use
it only when a schema mismatch cannot be migrated and current state may be lost.

## Control families

The CLI covers these families:

* Metadata, API, configuration, authentication, state, and trust
* Extensions, groups, roles, agents, checkouts, and worktrees
* Runs, status, messages, actions, waits, terminals, and consoles
* Events, daemon diagnostics, services, remote access, and completion

Examples:

```bash
npx nanasa group list
npx nanasa agent list group_product
npx nanasa checkout assign group_product --body <json>
npx nanasa checkout refresh <checkout-id>
npx nanasa run start group_product agent_builder
npx nanasa status list
npx nanasa status list group_product
npx nanasa wait list group_product copilot.builder
npx nanasa message list group_product
npx nanasa terminal status <run-id>
npx nanasa events watch
```

Use agent map keys for topology and run commands. Status and messaging responses
also expose stable member IDs for communication.

## Recover runs after agent tools change

Recover all active runs in a group or one configured agent:

```bash
npx nanasa run recover <group-id>
npx nanasa run recover <group-id> <agent-id>
npx nanasa run recover <group-id> --body '{"dryRun":true}'
npx nanasa run recover <group-id> --body '{"forceIndeterminate":true}'
```

A dry run checks current provider metadata, launch approval, and process
ownership without changing run records, creating approval requests, stopping a
pane, or starting an agent. Current healthy agents are reported as kept running.
Affected agents are reported as agents that would restart.

Normal recovery does not stop a process that Nanasa cannot safely identify.
Use `forceIndeterminate` only after an ordinary recovery reports that condition.
Nanasa still requires the same run, generation, terminal binding, and tmux
ownership tags before stopping the process. This option does not approve a
custom launcher.

Use `--json` or `--output json` to receive the full typed response with technical
identifiers. Recovery exits with 1 when any agent failed or could not be safely
identified, 3 when approval is required without a hard failure, and 0 otherwise.
Hard failures take precedence over approval when a group has mixed outcomes.

## Services and remote access

Service commands are `install`, `status`, `start`, `stop`, `restart`, `remove`,
`logs`, `wait-ready`, `upgrade`, and `rollback`. They operate on the exact
repository-local systemd user unit. `service install` accepts `--host`, `--port`,
`--mcp`, and `--no-mcp`; the other service commands reject startup options.

Remote commands describe identity, start or restart the remote service, and open
an OpenSSH loopback tunnel. OpenSSH remains the authentication authority.

## Shell completion

Generate completion for a supported shell with the completion family, for
example. Generated scripts complete both command families and their subcommands:

```bash
npx nanasa completion bash
npx nanasa completion zsh
npx nanasa completion fish
npx nanasa completion powershell
```

The [generated command inventory](cli.json) comes from the declarations used for
parsing, help, and completion and is the exact reference for this package
version.

## Runtime environment

The installed command sets repository and package paths automatically. Advanced
service or integration environments can use:

* `NANASA_HOST`, default `127.0.0.1`; the control plane requires loopback
* `NANASA_PORT`, default `3210`
* `NANASA_API_URL`, otherwise derived from `NANASA_HOST` and `NANASA_PORT`
* `NANASA_REPO_ROOT`, otherwise discovered from the current directory
* `NANASA_DATA_PATH`, default `.nanasa/state/nanasa.sqlite`
* `NANASA_RUNTIME_PATH`, default `.nanasa/runtime`
* `NANASA_TMUX_SERVER`, default `nanasa`
* `NANASA_SERVE_PORTAL` and `NANASA_PORTAL_PATH` for portal asset serving
* `NANASA_MCP_ENABLED`, default `true`, and `NANASA_MCP_PATH`, default `/mcp`
* `NANASA_MCP_URL`, derived from the listener unless set to an external HTTPS URL
* `NANASA_MCP_OPERATOR_TOKEN`, required for operator or external MCP access and
  at least 32 characters
* `NANASA_ALLOW_AUTONOMOUS`, default `false`, authorizes expanded execution profiles
* `NANASA_ALLOW_PROVIDER_FILES`, default `false`, authorizes repository provider files

Do not bind the daemon to a non-loopback host when MCP is enabled. Do not store
operator or provider credentials in repository configuration.
