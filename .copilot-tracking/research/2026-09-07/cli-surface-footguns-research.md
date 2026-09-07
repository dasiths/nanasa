---
title: CLI surface footgun research
description: Verified inconsistencies in Nanasa startup, service, command, environment, documentation, and completion behavior
ms.date: 2026-09-07
ms.topic: architecture
---

## Executive summary

Nanasa exposes one product through several overlapping control planes: bootstrap
commands in `bin/nanasa.js`, registry-backed control commands, daemon environment
variables, generated systemd configuration, package scripts, and authored YAML.
Those paths do not currently resolve to one startup contract.

The most consequential defect is the MCP default. Managed agents receive generated
MCP configuration and use Nanasa MCP tools for team communication, but the packaged
`nanasa start` command leaves MCP disabled unless the operator supplies `--mcp` or
`NANASA_MCP_ENABLED=true`. The repository-only `pnpm start` script enables MCP, so
development and installed-package behavior disagree.

The recommended contract is:

* Team communication and the portal are available after plain `nanasa start`
* Foreground and systemd startup share the same host, port, and MCP defaults
* Common startup settings have equivalent CLI flags and environment variables
* CLI flags override environment variables, which override product defaults
* Advanced daemon-only settings remain environment variables and are documented
* Control commands derive their default API URL from the same host and port settings
* Generated command references and shell completion come from the command registry

## Current command ownership

The executable has two parsers with different responsibilities.

| Surface | Owner | Configuration style |
|---------|-------|---------------------|
| Bootstrap and foreground lifecycle | `bin/nanasa.js` | Hand-written commands and start flags |
| Control API and local service commands | `apps/daemon/src/cli/control.ts` | Registry-backed commands with global options |
| Daemon startup | `apps/daemon/src/index.ts` | `NANASA_*` environment variables |
| Durable service | `SystemdUserService` and the systemd template | Generated `service.env` plus packaged CLI |
| Package development start | Root `package.json` | Script-specific environment prefix |
| Authored topology and providers | `.nanasa/config.yaml` | Validated YAML |

This split is not itself a defect. The footguns arise when two surfaces control the
same setting with different defaults or when one invocation mode cannot preserve the
settings accepted by another.

## Verified findings

### Critical: MCP is absent from the installed default start

`apps/daemon/src/index.ts` defaults `NANASA_MCP_ENABLED` to false. The packaged CLI
only changes that value when `--mcp` is present. In contrast, the root `pnpm start`
script injects `NANASA_MCP_ENABLED=true`.

Managed provider overlays only include the Nanasa MCP server when the endpoint is
enabled. A user can therefore initialize a team, start the product using the primary
documented command, launch agents successfully, and discover later that the team
communication tools are absent.

Direction: make authenticated loopback MCP part of the product default. Retain `--mcp`
as a compatibility no-op and add `--no-mcp` plus `NANASA_MCP_ENABLED=false` for the
explicit opt-out.

### High: service installation does not preserve startup parity

`SystemdUserService.install()` persists only `NANASA_REPO_ROOT` and a constructor port.
It does not persist host or MCP enablement. The constructor defaults its port to 3210
without consulting `NANASA_PORT`, so this workflow is surprising:

```bash
NANASA_PORT=4210 npx nanasa service install
```

The installed service still uses 3210. A foreground `nanasa start --port 4210` also has
no direct equivalent for service installation.

The service does execute `bin/nanasa.js`, so portal path, package root, product version,
build commit, and production mode are recomputed correctly. Those values do not need to
be copied into `service.env`.

Direction: accept the common startup options on `service install`, resolve the same
flag, environment, and default precedence, and persist the resolved host, port, and MCP
state in the owner-only environment file.

### High: control commands ignore the daemon host and port environment

`loadControlClient()` uses this precedence:

1. `--api-url`
2. `NANASA_API_URL`
3. `http://127.0.0.1:3210`

It does not derive the fallback from `NANASA_HOST` and `NANASA_PORT`. A daemon started
with `--port 4210` is therefore unreachable to a later control command unless the user
also discovers and sets `NANASA_API_URL` or repeats `--api-url` on every command.

Direction: derive the default control URL from `NANASA_HOST` and `NANASA_PORT`, while
keeping `--api-url` and `NANASA_API_URL` as explicit whole-URL overrides.

### High: registry declarations reject supported filters

The `status.list` route builder supports an optional group ID, but its declaration has
no positionals. The `wait.list` route builder supports an optional member ID, but its
declaration permits only the required group ID. Argument validation rejects both useful
forms before a request is sent.

Direction: declare `status list [<group-id>]` and
`wait list <group-id> [<member-id>]`, then regenerate `docs/reference/cli.json`.

### Medium: help advertises a nonexistent migration family

Bootstrap help and `docs/reference/cli.md` list migrations among operational families.
No migration command exists in `CLI_COMMAND_REGISTRY`. Database migration is internal
startup behavior, not a user CLI family.

Direction: remove the family from help and documentation until a real operator command
is introduced.

### Medium: start help and examples teach an avoidable option

MCP guides and the multi-agent example use `nanasa start --mcp`, while introductory
guides use `nanasa start`. This teaches two startup recipes for a capability that teams
need by default.

Direction: show plain `nanasa start` in normal and team workflows. Document `--no-mcp`
only as a deliberate single-agent or diagnostic opt-out.

### Medium: generic CLI options are hard to discover

Control parsing supports `--body`, `--api-url`, `--operator-token-file`,
`--idempotency-key`, `--request-id`, `--output`, `--json`, `--timeout`, `--agent`, and
`--repo`. The top-level help does not summarize these options, and the generated command
inventory contains command names and positionals but not accepted options.

Direction: document shared control options now. A later registry revision should attach
accepted options to each command so parsing, help, completion, and generated references
cannot drift.

### Medium: shell completion stops at command families

Completion output contains only family names. It does not complete second-level commands,
positionals, or options even though the registry contains enough command metadata to
complete family and command pairs.

Direction: add subcommand completion for Bash, Zsh, Fish, and PowerShell from the registry.
Keep positional value completion out of scope until stable value providers exist.

### Low: bootstrap help formatting and command classification drift

The reset usage line is over-indented. `open-url` is listed as a bootstrap command but is
not represented in the generated inventory. This is defensible because it is a managed
agent helper rather than a control API command, but the documentation should label it as
such and test its argument validation.

## Control-plane policy

Settings should be assigned by lifecycle and audience rather than historical accident.

| Setting class | Primary interface | Environment equivalent | Authored YAML |
|---------------|-------------------|------------------------|---------------|
| Listener host and port | `start` and `service install` flags | Yes | No |
| MCP enable or disable | `start` and `service install` flags | Yes | No |
| Explicit control API URL | Control command flag | Yes | No |
| Paths, tmux server, portal assets | Environment | Yes | No |
| Security policy gates | Environment | Yes | No |
| Teams, providers, roles, prompts | No | No | Yes |
| Per-request control payload | Positionals and `--body` | No | No |

CLI flags are ergonomic for an operator at a terminal. Environment variables support
automation, direct daemon execution, and systemd. Authored YAML remains repository-owned
product configuration and must not contain process credentials or machine-local secrets.

## Precedence and defaults

The immediate implementation should establish this table.

| Setting | CLI | Environment | Default |
|---------|-----|-------------|---------|
| Host | `--host` | `NANASA_HOST` | `127.0.0.1` |
| Port | `--port` | `NANASA_PORT` | `3210` |
| MCP | `--mcp`, `--no-mcp` | `NANASA_MCP_ENABLED` | Enabled |
| MCP path | None | `NANASA_MCP_PATH` | `/mcp` |
| Control API | `--api-url` | `NANASA_API_URL` | Derived from host and port |

For each row, the leftmost supplied value wins. Invalid environment values fail with the
same bounded validation used for their CLI counterparts.

## Rejected audit claims

The following hypotheses were checked and are not implementation findings:

* Systemd does not bypass the packaged CLI. It invokes `bin/nanasa.js start`, so portal
  serving and packaged asset metadata are supplied.
* Service behavior is not untested. `release-and-activation.test.ts` covers install,
  lifecycle operations, removal failure safety, and upgrade or rollback interactions.
  Startup setting parity remains untested.
* The status reporter endpoint is an internal daemon callback, not an advertised external
  collector. Adding an external URL control plane would enlarge the security model and is
  not required to fix CLI consistency.
* Provider-injected variables such as `NANASA_MCP_TOKEN` and reporter identity fields are
  internal run contracts. They should be documented in provider integration references,
  not presented as operator startup variables.

## Validation requirements

The fixes need executable coverage for:

* Plain start and direct daemon startup enabling MCP by default
* Explicit MCP disablement through both flag and environment variable
* Service installation persistence for host, port, and MCP state
* CLI-over-environment precedence for startup settings
* Control URL derivation from host and port
* Optional status and wait filters reaching the intended paths
* Help, generated references, normal guides, and examples using one startup contract
* Completion output for all four supported shells

## Deferred work

The current global option parser accepts shared options for commands that do not consume
them. Correcting that requires command-level option declarations and generated option
metadata. It should follow the immediate default and parity fixes rather than block them.

Persisting arbitrary advanced environment variables into `service.env` is also deferred.
The service should first persist the small public startup contract. Secret persistence,
environment-file escaping, update semantics, and configuration inspection need a separate
security review before the whitelist expands.
