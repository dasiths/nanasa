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

## Bootstrap and local lifecycle

```text
npx nanasa init
npx nanasa setup
npx nanasa doctor
npx nanasa auth login <integration-key> [--agent <agent-map-key>]
npx nanasa auth portal
npx nanasa docs
npx nanasa start [--host <host>] [--port <port>] [--mcp]
npx nanasa reset --from-alpha --confirm <repository-root>
```

`init` creates configuration when absent. `setup` prepares private provider
homes. `doctor` validates all configured integrations. Provider login may run
before the daemon. Portal login requires a running daemon. `docs` prints the
absolute path to the packaged help index and works outside a repository.

Running `npx nanasa` with no command is the same as `start`. The default address
is `127.0.0.1:3210`. MCP requires a loopback listener.

The alpha reset is destructive. It creates a verified backup, reports a redacted
inventory, removes owned runtime state, and initializes the current schema. Use
it only when a schema mismatch cannot be migrated and current state may be lost.

## Control families

The CLI covers these families:

* Metadata, API, configuration, authentication, state, and trust
* Extensions, groups, roles, agents, checkouts, and worktrees
* Runs, status, messages, actions, waits, terminals, and consoles
* Events, daemon diagnostics, services, migrations, remote access, and completion

Examples:

```bash
npx nanasa group list
npx nanasa agent list group_product
npx nanasa checkout assign group_product --body <json>
npx nanasa checkout refresh <checkout-id>
npx nanasa run start group_product agent_builder
npx nanasa status list
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
repository-local systemd user unit.

Remote commands describe identity, start or restart the remote service, and open
an OpenSSH loopback tunnel. OpenSSH remains the authentication authority.

## Shell completion

Generate completion for a supported shell with the completion family, for
example:

```bash
npx nanasa completion bash
```

The [generated command inventory](cli.json) comes from the declarations used for
parsing, help, and completion and is the exact reference for this package
version.

## Runtime environment

The installed command sets repository and package paths automatically. Advanced
service or integration environments can use:

* `NANASA_HOST`, default `127.0.0.1`; MCP requires loopback
* `NANASA_PORT`, default `3210`
* `NANASA_REPO_ROOT`, otherwise discovered from the current directory
* `NANASA_DATA_PATH`, default `.nanasa/state/nanasa.sqlite`
* `NANASA_RUNTIME_PATH`, default `.nanasa/runtime`
* `NANASA_TMUX_SERVER`, default `nanasa`
* `NANASA_SERVE_PORTAL` and `NANASA_PORTAL_PATH` for portal asset serving
* `NANASA_MCP_ENABLED`, default `false`, and `NANASA_MCP_PATH`, default `/mcp`
* `NANASA_MCP_URL`, derived from the listener unless set to an external HTTPS URL
* `NANASA_MCP_OPERATOR_TOKEN`, required for operator or external MCP access and
	at least 32 characters

Do not bind the daemon to a non-loopback host when MCP is enabled. Do not store
operator or provider credentials in repository configuration.
