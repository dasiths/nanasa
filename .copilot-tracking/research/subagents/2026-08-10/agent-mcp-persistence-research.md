<!-- markdownlint-disable-file -->
---
title: Authenticated agent MCP persistence research
description: Research on exposing the Nanasa HTTP MCP server to supported terminal CLIs with per-agent persistent state
ms.date: 2026-08-10
ms.topic: reference
---

## Research scope

Investigate how Nanasa should expose its authenticated HTTP MCP server to GitHub Copilot CLI 1.0.79-9, Claude Code 2.1.220, Pi 0.83.0, and OpenCode 1.18.15 while persisting agent-specific configuration and state under `/workspaces/nanasa/.nanasa/agents/<stable-member-id>/`.

Questions include exact configuration files, CLI flags, environment variables, HTTP MCP JSON formats, header environment-variable expansion, preservation of existing user authentication, Pi extension or package requirements, and repository changes implied by the current launch/runtime, schema, tests, ignore rules, and MCP implementation.

## Local repository findings

### Current launch and persistence model

* `.nanasa/config.yaml` defines an agent type as an exact command array, optional
  repository-contained working directory, and static environment map.
* `apps/daemon/src/store.ts` turns an agent type into an immutable agent profile.
  A group membership has a stable `memberId`; each restart creates a new run and
  increments its generation.
* `apps/daemon/src/tmux-runtime.ts` creates an owner pane with tmux `-e` arguments.
  It merges profile environment with runtime environment and executes the exact
  command array. The launch command is shell-quoted, but environment values are
  not shell-expanded.
* `apps/daemon/src/server.ts` currently adds only `NANASA_MCP_URL` and
  `NANASA_MCP_TOKEN` to each MCP-enabled run. The token is never added to the
  stored profile.
* `.nanasa/state/nanasa.sqlite` and `.nanasa/state/mcp-secret` survive daemon
  restarts. Owner panes also survive a graceful daemon restart. The signing
  secret is mode `0600` and its directory is forced to `0700`.
* `.nanasa/runtime/` contains disposable ttyd/runtime state. `.gitignore` ignores
  `.nanasa/state/` and `.nanasa/runtime/`, but it does not yet ignore
  `.nanasa/agents/`.
* The package CLI enables MCP only with `--mcp` or `NANASA_MCP_ENABLED=true`.
  The current development `pnpm start` command does not add `--mcp`; MCP must be
  enabled through the environment for that command.

### Current HTTP MCP behavior

* `apps/daemon/src/mcp-server.ts` uses the official MCP 2.0 server and Node
  packages with `responseMode: "json"` and `legacy: "stateless"`.
* The endpoint is POST-only. GET and DELETE return `405`, which is intentional
  for this stateless JSON-response server.
* Every request requires `Authorization: Bearer <token>`. Query-string tokens
  are not supported.
* Agent capabilities bind `groupId`, `memberId`, `runId`, and generation. A
  stopped or replaced run, changed desired state, or removed membership revokes
  the old capability on the next request.
* The three tools are `nanasa.send_dm`, `nanasa.send_multicast`, and
  `nanasa.broadcast_group`. Agent identity and group come from the capability,
  not caller-supplied tool arguments.
* Host and Origin checks run before bearer authentication. Each principal is
  limited to 30 MCP requests per minute.
* `apps/daemon/test/mcp-server.test.ts` verifies modern 2026-07-28 and legacy
  requests, authentication, tools, generation revocation, host/origin checks,
  and rate limiting.
* `apps/daemon/test/terminal-delivery.test.ts` verifies that the URL and token
  are injected into the direct CLI process and not persisted in the profile.

### Stable directory key warning

`memberId` is unique only within a group (`UNIQUE (group_id, member_id)`) and its
schema accepts any trimmed string up to 128 characters. It may therefore contain
path separators or `..`, and the same value may occur in two groups. It must not
be passed directly to `join()`.

Use a canonical, traversal-safe membership key. The least disruptive choice is
the persisted `GroupMembership.id`, which is generated as `membership_<uuid>`
and reused when a removed membership is reactivated. If the product requires the
visible `memberId` in the path, first tighten it to a filesystem-safe,
globally-unique schema and define migration behavior. A hash of
`groupId + NUL + memberId` is safe but does not literally expose the member ID.

## CLI integration findings

### GitHub Copilot CLI 1.0.79-9

* `COPILOT_HOME` overrides the complete config and state directory. Its default
  is `$HOME/.copilot`.
* Persistent MCP configuration is `<COPILOT_HOME>/mcp-config.json`.
* `--additional-mcp-config @<file>` adds a session-only config and has highest
  MCP source priority. It is not needed when each member has its own
  `COPILOT_HOME`.
* `copilot mcp add --transport http` generates the `mcpServers` form below.
* Remote `headers` support generic `$VAR`, `${VAR}`, and `${VAR:-default}`
  expansion. `${env:VAR}` is VS Code syntax and must not be used here. The CLI
  accepts it as literal text, which can conceal the mistake until connection.
* The add command requires a syntactically valid literal URL. Generate the
  non-secret endpoint into the config rather than relying on URL interpolation.
* Copilot authentication is stored in the system credential store. If no
  credential store exists, it falls back to plaintext under `COPILOT_HOME`.
  It also accepts `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, then `GITHUB_TOKEN`.

Exact generated config:

```json
{
  "mcpServers": {
    "nanasa": {
      "type": "http",
      "url": "http://127.0.0.1:3210/mcp",
      "headers": {
        "Authorization": "Bearer ${NANASA_MCP_TOKEN}"
      },
      "tools": ["*"]
    }
  }
}
```

Recommended launch environment:

```text
COPILOT_HOME=/workspaces/nanasa/.nanasa/agents/<safe-membership-id>/copilot
NANASA_MCP_URL=<run endpoint>
NANASA_MCP_TOKEN=<generation capability>
```

Do not use `--additional-mcp-config` as the sole persistence mechanism because
Copilot session state would still be shared in the default home.

### Claude Code 2.1.220

* `CLAUDE_CONFIG_DIR` overrides the whole default `~/.claude` configuration
  root. Official documentation states that all settings, session history,
  plugins, and Linux/Windows credentials live under this path.
* With `CLAUDE_CONFIG_DIR=/path/member/claude`, user MCP configuration is stored
  at `/path/member/claude/.claude.json`. This was verified with
  `claude mcp add-json --scope user` against a disposable directory.
* `--mcp-config <file-or-json>` can supply explicit session configuration;
  `--strict-mcp-config` ignores every other MCP source. Per-member user config is
  preferable because it also works through the repository's
  `make claude-copilot` target without changing target arguments.
* HTTP uses `type: "http"`; `streamable-http` is accepted as an alias.
* `${VAR}` and `${VAR:-default}` expansion works in HTTP `url` and `headers`.
  A missing variable without a default leaves the literal placeholder and emits
  a warning, so launch-time validation should fail before starting the CLI.
* On Linux, Claude credentials normally use
  `<CLAUDE_CONFIG_DIR>/.credentials.json`. The current workspace has no such
  file and no inherited Anthropic authentication variable. The
  `claude-copilot` Make target authenticates through the local LiteLLM proxy by
  setting `ANTHROPIC_AUTH_TOKEN` for the child process.

Exact user config entry:

```json
{
  "mcpServers": {
    "nanasa": {
      "type": "http",
      "url": "http://127.0.0.1:3210/mcp",
      "headers": {
        "Authorization": "Bearer ${NANASA_MCP_TOKEN}"
      }
    }
  }
}
```

Recommended launch environment:

```text
CLAUDE_CONFIG_DIR=/workspaces/nanasa/.nanasa/agents/<safe-membership-id>/claude
NANASA_MCP_URL=<run endpoint>
NANASA_MCP_TOKEN=<generation capability>
```

### Pi 0.83.0

* Pi intentionally has no built-in MCP client. Its installed README says to use
  an extension or package.
* `PI_CODING_AGENT_DIR` overrides the complete default `~/.pi/agent` root.
  `PI_CODING_AGENT_SESSION_DIR` or `--session-dir` can override sessions
  separately, but this is unnecessary when the whole agent directory is
  isolated.
* Pi model credentials live in `<PI_CODING_AGENT_DIR>/auth.json`.
* The leading candidate is `pi-mcp-adapter` (MIT, 1.2k stars, 49 releases, 53
  contributors at research time). It supports Streamable HTTP, custom headers,
  `${VAR}` and `$env:VAR` interpolation, Pi-owned config at
  `<PI_CODING_AGENT_DIR>/mcp.json`, and MCP 2026 protocol probing.
* Pi 0.83.0 is older than the adapter's current 0.84.1 development fixture. The
  package declares no hard Pi peer dependency, but latest compatibility is not
  proven. Version 2.21.0 was tested by the adapter project against Pi 0.79.10 and
  contains the required Streamable HTTP, interpolation, and protocol negotiation
  features. Pin `pi-mcp-adapter@2.21.0` until an integration test confirms a
  newer release with Pi 0.83.0.
* Avoid a runtime `pi install` for every member. Add the pinned adapter as a
  Nanasa runtime dependency and pass its resolved `index.ts` with Pi's
  repeatable `--extension` flag. This makes installation deterministic and
  keeps package-manager access in Nanasa's normal install/build flow, where
  `AGENTS.md` registry rules apply.

Exact adapter config at `<PI_CODING_AGENT_DIR>/mcp.json`:

```json
{
  "settings": {
    "directTools": true,
    "hostConfigDiscovery": "off"
  },
  "mcpServers": {
    "nanasa": {
      "url": "http://127.0.0.1:3210/mcp",
      "headers": {
        "Authorization": "Bearer ${NANASA_MCP_TOKEN}"
      },
      "protocolVersion": "auto",
      "lifecycle": "eager"
    }
  }
}
```

`protocolVersion: "auto"` is important because the adapter specifically
recommends it for MCP SDK 2 stateless servers. Nanasa also supports the legacy
handshake, so conservative fallback remains available.

Recommended launch additions:

```text
PI_CODING_AGENT_DIR=/workspaces/nanasa/.nanasa/agents/<safe-membership-id>/pi
NANASA_MCP_URL=<run endpoint>
NANASA_MCP_TOKEN=<generation capability>
pi --extension <resolved-pi-mcp-adapter-index>
```

### OpenCode 1.18.15

* OpenCode uses XDG roots. The installed `opencode debug paths` reports config
  at `~/.config/opencode`, data at `~/.local/share/opencode`, state at
  `~/.local/state/opencode`, and cache at `~/.cache/opencode`.
* `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_STATE_HOME`, and `XDG_CACHE_HOME` all
  moved the corresponding roots in a disposable probe.
* `OPENCODE_CONFIG` selects an additional config file. `OPENCODE_CONFIG_DIR` is
  an additional agents/commands/plugins directory; it did not change the main
  config root and must not be treated as a state-home override.
* Global config is `<XDG_CONFIG_HOME>/opencode/opencode.json` and accepts JSON or
  JSONC.
* Remote MCP uses `type: "remote"`. `{env:VAR}` expansion applies to all config
  strings, including headers. A disposable `opencode debug config` probe
  confirmed expansion inside `Authorization`.
* Set `oauth: false` because Nanasa uses an injected bearer capability, not an
  OAuth discovery flow. This also prevents an expired generation token from
  triggering an irrelevant browser flow.
* Provider credentials normally live at
  `<XDG_DATA_HOME>/opencode/auth.json`; remote MCP OAuth tokens use
  `<XDG_DATA_HOME>/opencode/mcp-auth.json`.

Exact config:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "nanasa": {
      "type": "remote",
      "url": "http://127.0.0.1:3210/mcp",
      "headers": {
        "Authorization": "Bearer {env:NANASA_MCP_TOKEN}"
      },
      "oauth": false,
      "enabled": true
    }
  }
}
```

Recommended launch environment:

```text
XDG_CONFIG_HOME=/workspaces/nanasa/.nanasa/agents/<safe-membership-id>/opencode/config
XDG_DATA_HOME=/workspaces/nanasa/.nanasa/agents/<safe-membership-id>/opencode/data
XDG_STATE_HOME=/workspaces/nanasa/.nanasa/agents/<safe-membership-id>/opencode/state
XDG_CACHE_HOME=/workspaces/nanasa/.nanasa/agents/<safe-membership-id>/opencode/cache
NANASA_MCP_URL=<run endpoint>
NANASA_MCP_TOKEN=<generation capability>
```

## Recommended integration

### Provisioning lifecycle

1. Resolve the active membership and derive a traversal-safe stable directory
   key. Do this before tmux launch, not in tracked `.nanasa/config.yaml`.
2. Create `.nanasa/agents/<safe-membership-id>/` and all CLI subdirectories with
   mode `0700`. Reject symlinks and verify current-user ownership, following the
   existing MCP secret hardening pattern.
3. Generate CLI config atomically with a literal `NANASA_MCP_URL` and the
   CLI-specific environment placeholder for `NANASA_MCP_TOKEN`. Generated config
   may be mode `0600` even though it contains no token.
4. Inject the CLI home variables plus the existing run-scoped URL and token into
   the direct owner pane. Runtime values must override static profile values so a
   checked-in config cannot redirect agent state or replace its capability.
5. Reuse the same per-member directory for recovery and later run generations.
   Generate a fresh token only in the process environment; never rewrite a token
   into config or state.
6. Keep CLI-specific config generation in a typed provisioner keyed by
   `AgentKind`, not in YAML templates or shell wrappers. This covers direct
   `claude` and `make claude-copilot` consistently.

### Preserve existing user authentication

The isolated roots hide file-based credentials by design. Preserve only the
credential file, not the entire original config/state directory:

* Copilot: rely on the system credential store or inherited
  `COPILOT_GITHUB_TOKEN`/`GH_TOKEN`/`GITHUB_TOKEN`. If the platform is using
  Copilot's plaintext fallback under the old home, require one login per isolated
  root or add a narrowly scoped credential-file link after identifying the
  version-specific file. Do not link all of `~/.copilot` because that would merge
  sessions and settings.
* Claude: on Linux/Windows, conditionally create
  `<member>/claude/.credentials.json` as a symlink to the existing
  `~/.claude/.credentials.json`, or inherit provider authentication variables.
  On macOS the system Keychain remains shared automatically.
* Pi: conditionally symlink `<member>/pi/auth.json` to the existing
  `~/.pi/agent/auth.json`. Pi refreshes OAuth credentials by replacing/updating
  this file, so the implementation must test symlink behavior and fail closed if
  the source becomes unavailable.
* OpenCode: conditionally symlink
  `<member>/opencode/data/opencode/auth.json` to the existing
  `~/.local/share/opencode/auth.json`; do the same for `mcp-auth.json` only if
  existing user MCP OAuth state must be shared. Nanasa itself does not need that
  OAuth file.

Credential links and isolated roots are runtime data and must be ignored by Git.
Never copy credential content into `.nanasa/config.yaml`, generated MCP JSON,
the SQLite database, logs, tests, or tracked fixtures. Never print credential
values during diagnostics. Prefer reporting only source presence, ownership,
mode, and link target.

## Risks and unresolved questions

* Pi 0.83.0 plus `pi-mcp-adapter@2.21.0` still needs an executable integration
  test. The adapter has no hard peer constraint, but its newest test fixture has
  moved to Pi 0.84.1.
* Copilot's secure credential store is platform-dependent. A machine without a
  keyring may have plaintext fallback credentials inside the original
  `COPILOT_HOME`; the filename is not specified by public documentation.
* Credential symlinks share one user's login and refresh state across members.
  Concurrent refresh/write behavior needs a test for Pi, Claude, and OpenCode.
  A per-member login is cleaner when separate identities are acceptable.
* All agents run as the same Unix user. A process can inspect its own injected
  token and may inspect same-user process environments or credential symlink
  targets. Per-member directories isolate accidental state collision, not a
  malicious agent. Strong isolation requires separate OS/container identities.
* Some clients may cache expanded MCP metadata. No inspected client documents
  persisting expanded header values, but this should be checked with a synthetic
  token and filesystem scan after connect. Token generation fencing limits the
  impact of accidental caching.
* Nanasa's endpoint rejects GET/DELETE and returns JSON rather than SSE. The
  supported client versions advertise Streamable HTTP, but end-to-end tests must
  cover initialize, tools/list, and one tool call for each exact version.
* The MCP URL may be externally advertised while Nanasa still binds loopback.
  Agent-local clients should use a reachable URL; do not blindly write an
  external reverse-proxy URL if local DNS/TLS is unavailable.
* `NANASA_MCP_TOKEN` currently appears in tmux's pane environment. Directory
  persistence does not alter this existing exposure.
* Decide whether state belongs to a membership or a logical `memberId` reused
  across groups. The database currently makes membership identity group-scoped,
  while the requested directory shape names only a stable member ID.

## Likely edit surface

* `apps/daemon/src/config.ts`: add an `agentsDirectory` path beneath `.nanasa/`
* `packages/contracts/src/index.ts`: optionally tighten or formalize the stable
  member directory key contract
* `apps/daemon/src/tmux-runtime.ts`: invoke a per-run provisioner before launch,
  inject protected CLI home variables, and append Pi's explicit extension path
* `apps/daemon/src/server.ts`: construct and wire the provisioner with the MCP
  endpoint and credential issuer
* New `apps/daemon/src/agent-runtime-provisioner.ts`: safe directory creation,
  atomic config generation, credential-link policy, and per-kind environment
* `package.json` and `pnpm-lock.yaml`: add a pinned Pi MCP adapter dependency;
  any package-manager operation must first source `.devcontainer/.env` per
  `AGENTS.md`
* `.gitignore`: add `.nanasa/agents/`
* `templates/config.yaml` and `.nanasa/config.yaml`: likely no CLI flags are
  needed if runtime provisioning owns all config; document that runtime-owned
  variables override profile environment
* `apps/daemon/test/config.test.ts`: verify the agents path
* `apps/daemon/test/terminal-delivery.test.ts`: verify stable root reuse across
  generations, kind-specific environment, config placeholders, and no persisted
  token
* New focused provisioner tests: traversal/symlink rejection, ownership/modes,
  atomic replacement, URL changes, credential links, all four JSON formats
* `apps/daemon/test/mcp-server.test.ts`: retain protocol/auth tests and add client
  compatibility fixtures only if practical
* `test/package-cli.test.mjs`: verify `.nanasa/agents/` is not created by init and
  the packaged Pi adapter resolves after installation
* Acceptance tests under `test/acceptance/`: launch each exact CLI with synthetic
  or stub model authentication and verify MCP initialize/list/call plus state
  reuse after run replacement and daemon restart
* `README.md`: document per-member state roots, auth-link behavior, Pi adapter
  pin, header placeholder syntaxes, and cleanup/re-authentication behavior

## Evidence and references

Local evidence:

* `apps/daemon/src/config.ts`
* `apps/daemon/src/index.ts`
* `apps/daemon/src/server.ts`
* `apps/daemon/src/tmux-runtime.ts`
* `apps/daemon/src/mcp-auth.ts`
* `apps/daemon/src/mcp-server.ts`
* `apps/daemon/src/store.ts`
* `apps/daemon/test/config.test.ts`
* `apps/daemon/test/mcp-auth.test.ts`
* `apps/daemon/test/mcp-server.test.ts`
* `apps/daemon/test/terminal-delivery.test.ts`
* `packages/contracts/src/index.ts`
* `bin/nanasa.js`
* `test/package-cli.test.mjs`
* `.gitignore`
* `.nanasa/config.yaml`
* `templates/config.yaml`
* `Makefile`

External references:

* [GitHub Copilot CLI MCP setup](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers)
* [GitHub Copilot CLI command reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference)
* [Claude Code MCP](https://code.claude.com/docs/en/mcp)
* [Claude Code environment variables](https://code.claude.com/docs/en/env-vars)
* [Claude Code settings](https://code.claude.com/docs/en/settings)
* Pi installed README:
  `/usr/local/share/npm-global/lib/node_modules/@earendil-works/pi-coding-agent/README.md`
* [Pi MCP Adapter](https://github.com/nicobailon/pi-mcp-adapter)
* [OpenCode MCP servers](https://opencode.ai/docs/mcp-servers/)
* [OpenCode configuration](https://opencode.ai/docs/config/)
