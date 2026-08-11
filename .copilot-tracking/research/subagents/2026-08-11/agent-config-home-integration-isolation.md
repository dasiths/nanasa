---
title: Agent configuration home and integration isolation research
description: Evidence and implementation guidance for scoped agent homes, generated integrations, Copilot isolation, and package CLI lifecycle commands
ms.date: 2026-08-11
ms.topic: concept
---

## Research scope

* Determine the minimal complete `agentType.agentConfigHome` YAML representation for agent-type, member, provider-default, and custom-path scopes.
* Locate configuration contracts, normalization, profile persistence, runtime provisioning, package CLI behavior, package build inputs, ignore policy, and relevant tests.
* Determine where Nanasa-generated hooks, extensions, configuration state, and membership MCP files should live under `.nanasa/integrations`.
* Determine the environment contract for Copilot isolation through `COPILOT_HOME` and `COPILOT_CACHE_HOME`.
* Define `nanasa setup`, `nanasa auth`, `nanasa doctor`, and `nanasa doctor --fix` behavior for exact legacy Copilot hook files.
* Identify migration and compatibility risks, harness-specific authentication constraints, and focused validation commands.
* Preserve the constraint that implementation must not change global settings.

## Findings

### Minimal schema and normalization

Use one strict discriminated union in `packages/contracts/src/index.ts` and the
same shape in the raw YAML schema in `apps/daemon/src/config.ts`:

```yaml
agentConfigHome:
  scope: agent-type
```

The accepted values are:

```text
{ scope: "agent-type" }
{ scope: "member" }
{ scope: "provider-default" }
{ scope: "custom", path: "<path>" }
```

`path` must be required only for `custom`. Reject unknown keys, NUL characters,
non-directory collisions, and symlinked generated roots. Resolve a relative
custom path against the repository root and persist the absolute normalized
path. Do not implement shell or `~` expansion implicitly.

The field must be copied through the transform in `AgentTypeConfigInputSchema`.
That transform currently removes accepted legacy adapter fields, so adding the
raw YAML key without changing the transform would silently lose it. It must
also be copied into `AgentProfileSchema`,
`InternalCreateAgentProfileCommandSchema`, and `NanasaStore.createAgentProfile`.
Profiles are immutable configuration snapshots; resolving from the live config
at launch would change existing memberships after a YAML edit.

Keep config `version: 1` only if omission preserves current behavior. The least
breaking compatibility default is kind-aware:

* `copilot` and `opencode`: `provider-default`
* `claude-code` and `pi`: `member`

Those defaults match `apps/daemon/src/agent-runtime-provisioner.ts` today.
Templates can opt Copilot into `agent-type` explicitly to deliver isolated
Copilot state without silently migrating existing repositories. A universal
new default would require a config version bump and an authentication migration.

### Path ownership and generated layout

Add `integrationsDirectory` to `NanasaPaths` in `apps/daemon/src/config.ts`:

```text
<repo>/.nanasa/integrations
```

Resolve scoped provider homes deterministically:

```text
agent-type: <integrations>/homes/agent-types/<agent-type-key>/<kind>
member:     <integrations>/homes/members/<membership-id>/<agent-type-key>/<kind>
default:    provider default, with no home environment override
custom:     normalized configured path
```

Use `GroupMembership.id`, not the display `memberId`. The persisted membership
ID is already traversal-safe and stable across reactivation; `memberId` is only
unique within a group and its contract currently permits unsafe path text.

Keep Nanasa-authored overlays and per-membership MCP files under the generated
root even when provider state uses `provider-default` or `custom`:

```text
.nanasa/integrations/assets/copilot/nanasa-status-plugin/
.nanasa/integrations/assets/claude/nanasa-status-hook.mjs
.nanasa/integrations/assets/pi/nanasa-status-extension.mjs
.nanasa/integrations/assets/opencode/plugins/nanasa-status.mjs
.nanasa/integrations/members/<membership-id>/<kind>/mcp-config.json
.nanasa/integrations/members/<membership-id>/<kind>/settings.json
```

The bearer capability remains only in `NANASA_MCP_TOKEN`; generated JSON keeps
the existing environment placeholder. Files remain mode `0600`, directories
mode `0700`, and atomic rename behavior remains. Never copy tokens or whole
provider trees.

Replace the current Copilot global hook write with the plugin form already
researched in
`.copilot-tracking/research/subagents/2026-08-11/status-reporters-code-map.md`.
Pass `--plugin-dir <integrations>/assets/copilot/nanasa-status-plugin` and keep
the membership MCP file selected with `--additional-mcp-config @<file>`. This
works with `provider-default` and does not modify `~/.copilot`.

Pi can continue to receive both extensions through repeatable `--extension`
flags. OpenCode can continue to receive `OPENCODE_CONFIG` and
`OPENCODE_CONFIG_DIR`, but both generated paths should move beneath
`.nanasa/integrations`. Provider data remains in its selected XDG home.

Claude is the compatibility edge. Direct `claude` supports `--settings` and
`--mcp-config`, but the configured `make claude-copilot` command launches
`claude` internally and cannot accept appended Claude flags. The smallest
compatible behavior is to keep `CLAUDE_CONFIG_DIR` for `member` and
`agent-type` homes. Full `provider-default` or custom-home support while all
Nanasa files remain under integrations requires a process-local `claude` shim
on `PATH` that invokes the resolved real binary with the generated flags. Do not
write or merge `~/.claude/settings.json`. If a shim is out of scope, reject
those scope and wrapped-command combinations during config validation rather
than launching without MCP or hooks.

### Copilot isolation

For Copilot `agent-type`, `member`, and `custom` homes, inject both:

```text
COPILOT_HOME=<resolved-home>
COPILOT_CACHE_HOME=<resolved-home>/cache
```

For `provider-default`, leave both unset so inherited provider behavior is
preserved. Provisioned environment is merged after profile environment in
`apps/daemon/src/tmux-runtime.ts`, so the resolved scope remains authoritative.

Copilot CLI 1.0.79 documents `COPILOT_HOME` as the complete configuration and
state root. Its installed help does not document `COPILOT_CACHE_HOME`; local
cached Copilot code references it for downloadable artifacts. Treat cache-home
support as version-gated and test it, but set it as requested so large artifacts
do not leak across isolated homes.

Copilot OAuth credentials normally use the OS credential store and only fall
back to plaintext under `COPILOT_HOME`. Home isolation therefore isolates
configuration, sessions, logs, and fallback credentials, but not necessarily
keyring credentials. `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, and `GITHUB_TOKEN`, in
that order, are the documented process-scoped authentication override.

### Package CLI lifecycle

`bin/nanasa.js` currently supports only `init` and `start`. Add commands without
changing user or system settings:

* `nanasa setup` discovers and strictly validates `.nanasa/config.yaml`, creates
  private integration roots, materializes Nanasa-owned assets, installs the
  repository-local ignore file, and reports auth work still required. It is
  idempotent and never edits provider defaults.
* `nanasa auth` authenticates each distinct resolved configured home, with an
  agent-type selector and a membership selector for `member` scope. It launches
  the provider command with the same resolved environment that runtime uses.
  It must not copy credentials between homes.
* `nanasa doctor` is non-destructive. It checks config normalization,
  executables, `ttyd`, integration ownership/modes/symlinks, generated asset
  versions, selected home writability, auth status where supported, and the two
  exact legacy Copilot files.
* `nanasa doctor --fix` may repair Nanasa-owned integration files, permissions,
  and ignore entries. It may remove recognized Nanasa legacy files only. It
  must not invoke login, rewrite YAML, edit provider settings, or touch unrelated
  hooks.

The exact legacy paths created by current runtime code are:

```text
${COPILOT_HOME:-$HOME/.copilot}/hooks/nanasa-status-v1.json
${COPILOT_HOME:-$HOME/.copilot}/hooks/nanasa-status-hook-v1.mjs
```

For `--fix`, use `lstat`, require a current-user-owned regular file, reject
symlinks, and verify the manifest shape or a known reporter content hash before
unlinking. Leave an edited or unrecognized same-name file in place with a manual
remediation warning. Remove the `hooks` directory only if Nanasa made it and it
is empty. Do not edit `~/.copilot/config.json`, `settings.json`, MCP config,
permissions, plugins, or any global Git configuration.

Build the reusable setup/doctor logic as a bundled CLI support entry rather than
duplicating the strict YAML parser in `bin/nanasa.js`. `scripts/build-package.mjs`
currently emits only `dist/daemon/index.js`; a small `dist/cli/admin.js` entry can
reuse config and integration modules while preserving the terminal-only daemon
bundle. Keep `bin/nanasa.js` as the package entry and dynamically import the
admin bundle for these commands.

### Authentication constraints

* Copilot 1.0.79: `copilot login` supports web and device-code OAuth. Tokens may
  live in the OS credential store instead of the selected home. Classic `ghp_`
  PATs are unsupported; fine-grained PATs require Copilot Requests permission.
  No standalone auth-status command is exposed.
* Claude Code 2.1.221: run `claude auth login` under the resolved
  `CLAUDE_CONFIG_DIR`; `claude auth status --json` is suitable for doctor.
  `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, and third-party provider
  credentials can bypass stored Claude OAuth. The repository's
  `make claude-copilot` uses a local LiteLLM token in process environment.
* Pi 0.83.0: login is interactive through `/login` in the TUI. `pi auth` only
  prints already configured API or bearer tokens for external clients and must
  not be used by Nanasa because it would expose secrets on stdout. Pi credentials
  live at `<PI_CODING_AGENT_DIR>/auth.json`; doctor can report file presence and
  safety but cannot verify an account non-interactively.
* OpenCode 1.18.16: use `opencode providers login` under selected XDG roots;
  `opencode providers list` can report configured providers. Provider auth lives
  below `XDG_DATA_HOME`, while config, state, and cache require their respective
  XDG variables for actual isolation. `OPENCODE_CONFIG_DIR` alone is only an
  overlay directory.

### Persistence and migration risks

Add an `agent_config_home_json` column to `agent_profiles` and bump the SQLite
schema version from 2 to 3 in `apps/daemon/src/store.ts`. Hydrate legacy rows
with the kind-aware compatibility defaults above. Tests must cover both a
version-2 database and the existing no-version legacy table fixture. Exposing
the field through `AgentProfileSchema` also changes portal snapshot payloads;
`apps/portal/src/api.ts` parses that schema, so portal fixtures need updates even
if the UI does not display the field.

Other risks:

* Strict raw and canonical schemas reject the new key until both are updated.
* Changing omission defaults can strand existing credentials and sessions.
* `agent-type` homes intentionally share provider sessions across memberships;
  `member` homes isolate them. This is a user-visible privacy choice.
* Custom paths can be outside the repository and cannot be protected by Git
  ignore rules. Setup and doctor must report this explicitly.
* Existing `.nanasa/agents` data should not be auto-deleted. New runs can use
  integrations; doctor should report the legacy directory for optional manual
  cleanup after active panes are gone.
* Exact generated filenames and asset versions need stable constants shared by
  runtime and doctor, otherwise `--fix` can drift from provisioner behavior.

### Exact implementation surfaces

Modify:

* `packages/contracts/src/index.ts`
* `packages/contracts/test/contracts.test.ts`
* `apps/daemon/src/config.ts`
* `apps/daemon/test/config.test.ts`
* `apps/daemon/src/store.ts`
* `apps/daemon/test/store.test.ts`
* `apps/daemon/src/agent-runtime-provisioner.ts`
* `apps/daemon/test/agent-runtime-provisioner.test.ts`
* `apps/daemon/src/server.ts`
* `apps/daemon/src/tmux-runtime.ts` only if environment unsetting or a Claude
  process-local shim needs explicit support
* `bin/nanasa.js`
* `scripts/build-package.mjs`
* `test/package-cli.test.mjs`
* `templates/config.yaml`
* `.gitignore`
* `.nanasa/.gitignore`
* `README.md`

Likely new focused modules:

* `apps/daemon/src/agent-config-home.ts` for schema-independent path resolution
* `apps/daemon/src/integration-assets.ts` for names, versions, and safe writes
* `apps/daemon/src/cli-admin.ts` for setup, auth, and doctor orchestration

Do not edit generated `dist/` or `packages/contracts/dist/` by hand. The package
build regenerates them.

## Recommended implementation phases

1. Add the union contract, strict raw parsing, kind-aware defaults, path
   normalization, profile persistence, and schema-version-3 migration.
2. Introduce integration path and asset modules, move provisioner output from
   `.nanasa/agents` and global Copilot hooks, and add Copilot home/cache
   environment injection.
3. Add the local Copilot plugin and provider overlays. Resolve or explicitly
   reject the wrapped-Claude scope edge before calling the feature complete.
4. Add `setup`, scoped `auth`, `doctor`, and conservative `doctor --fix` through
   a bundled CLI admin entry.
5. Add initialization ignore coverage, template examples, migration guidance,
   package contents checks, and focused acceptance tests for no global changes.

## Focused validation

No package-manager command was run during this research. Recommended checks:

```bash
./node_modules/.bin/tsc -p packages/contracts/tsconfig.json --noEmit
./node_modules/.bin/vitest run packages/contracts/test/contracts.test.ts
./node_modules/.bin/tsc -p apps/daemon/tsconfig.json --noEmit
./node_modules/.bin/vitest run apps/daemon/test/config.test.ts apps/daemon/test/store.test.ts apps/daemon/test/agent-runtime-provisioner.test.ts
node scripts/build-package.mjs
node --test test/package-cli.test.mjs
git check-ignore -v .nanasa/integrations/probe
git status --short -- "$HOME/.copilot" "$HOME/.claude" "$HOME/.pi" "$HOME/.config/opencode" "$HOME/.local/share/opencode"
```

Add package CLI tests that use disposable `HOME`, `XDG_*`,
`COPILOT_HOME`, and `COPILOT_CACHE_HOME` roots. Assert `setup`, `doctor`, and
`doctor --fix` never modify files outside the temporary repository except the
two seeded, recognized legacy Copilot paths. Cover symlink and edited-file
refusal. The packed-package test must assert the CLI admin bundle and generated
asset templates are published.

If the full workspace suite is run through pnpm later, first load
`.devcontainer/.env` exactly as required by `AGENTS.md`; do not override its
registry variables.

## Clarifying questions

* Does `provider-default` mean no provider home redirection, or only reuse of
  provider authentication while Nanasa redirects configuration and state? The
  distinction controls Claude wrapped-command support and the guarantees of
  state isolation.
* Should `custom.path` permit locations outside the repository? The recommendation
  permits them intentionally, normalizes them to absolute paths, and warns that
  repository ignore rules cannot protect them.
