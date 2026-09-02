# Multi-coding-agents example extraction plan

## Goal

Separate Nanasa product development from the repository's runnable multi-agent
example. Move the example configuration into
`examples/multi-coding-agents/.nanasa`, give the example its own lifecycle
commands and documentation, and keep product build and validation commands at
the repository root.

The extracted example must preserve the current team topology, provider
integrations, scoped prompts, MCP coordination, and read-only reviewer policy.
It must not move or commit local credentials, sessions, databases, runtime
files, or backups.

## Decisions

### Treat the nested directory as the configuration root

Nanasa discovers the nearest `.nanasa/config.yaml` by walking upward from the
current directory. The directory that contains `.nanasa` is the configuration
root. The example will therefore be operated from
`examples/multi-coding-agents` and will keep:

```yaml
repository:
  path: .
  checkout: { kind: current }
```

Git can still discover the outer Nanasa checkout from this subdirectory. Agent
processes will start inside the example directory because configuration paths
cannot traverse to the outer repository root. Supporting a configuration root
outside the managed working directory would require a separate product design
and security review; it is not part of this extraction.

### Move shared files but start with clean private state

Move these tracked files into the example:

* `.nanasa/config.yaml`
* `.nanasa/extensions.lock.yaml`
* `.nanasa/.gitignore`
* `.nanasa/instructions/`

Do not move `.nanasa/agents`, `.nanasa/backups`, `.nanasa/integrations`,
`.nanasa/runtime`, or `.nanasa/state`. Those directories contain ignored local
history, provider state, credentials, or active runtime data. The example will
run `setup` and provider authentication against new private directories.

### Keep product and example commands distinct

The root Makefile will retain product development commands:

* Dependency installation
* Builds and package assembly
* Static checks and tests
* Documentation generation and validation
* Release and certification commands

The example Makefile will own commands that operate the extracted
configuration:

* Initialization, setup, diagnostics, and reset
* Foreground and development startup
* Portal authentication and launch helpers
* Coding-agent provider authentication
* The LiteLLM-backed Claude Code integration used by this example

The example Makefile will delegate product builds to the root Makefile. Root
convenience targets will use an `example-` prefix so `make start` no longer
silently means one repository example.

### Keep example documentation close to the example

`examples/multi-coding-agents/README.md` will be the exact runbook for the
checked-in example. Public package documentation will gain an examples catalog
and a conceptual multi-agent walkthrough under `docs/next/examples`.

Only `docs/next` is copied into packaged help. Public documentation must not
depend on top-level example files unless package assembly also begins shipping
the `examples` directory. This phase will keep the packaged walkthrough
self-contained and link to repository files only where the source context is
explicit.

## Implementation phases

### Phase 1: Preserve the corrected prompt scopes

Status: complete before extraction.

The authored configuration references both global instruction files, the group
instruction file, and the matching role file for every configured agent. Direct
prompt resolution and `doctor` must continue to pass after the move.

### Phase 2: Move the tracked example

Status: complete.

1. Create `examples/multi-coding-agents`.
2. Move only the tracked `.nanasa` configuration, lock, ignore, and instruction
   files.
3. Leave existing ignored root runtime directories untouched.
4. Confirm instruction references still resolve relative to the new
   configuration root.

Exit criteria:

* No tracked `.nanasa` files remain at the repository root.
* The nested configuration loads without changing its IDs or prompt paths.
* Private runtime directories are absent from the tracked diff.

### Phase 3: Split Make targets

Status: complete.

1. Add an example Makefile with an explicit `PRODUCT_ROOT`.
2. Move configuration lifecycle, portal, provider login, proxy, and
   `claude-copilot` targets into it.
3. Keep product build, test, documentation, and certification targets in the
   root Makefile.
4. Add a small set of root `example-*` delegation targets.
5. Ensure the `claude-copilot` integration resolves its Make target from the
   example directory.
6. Make example development startup set `NANASA_REPO_ROOT` explicitly.

Exit criteria:

* Root help distinguishes product commands from example delegates.
* Example help documents every runnable-example command.
* Product build and static-check targets do not require a root `.nanasa` file.

### Phase 4: Add example documentation

Status: complete.

1. Add the example README with prerequisites, team topology, prompt scopes,
   setup, authentication, startup, MCP behavior, and cleanup.
2. Add a public examples catalog under `docs/next/examples`.
3. Add a packaged multi-agent walkthrough under `docs/next/examples`.
4. Link the examples catalog from the documentation index and root README.
5. Keep the comprehensive configuration guide as the canonical explanation of
   the YAML model.

Exit criteria:

* A contributor can run the checked-in example from its README alone.
* A package user can understand the example without source-only links.
* Documentation validation reports no broken links or duplicate headings.

### Phase 5: Add regression coverage

Status: complete.

1. Load the real nested example through the production configuration loader.
2. Assert the global, group, and role prompt source order for every configured
   agent.
3. Assert the reviewer retains the read-only permission policy.
4. Check that tracked example files do not include private state directories.
5. Preserve existing temporary-repository tests for general `.nanasa`
   behavior.

Exit criteria:

* The nested example is executable documentation rather than an untested
  fixture.
* A missing or incorrectly scoped prompt fails a focused test.

### Phase 6: Validate the extraction

Status: complete.

Run validation in this order:

1. Example `setup` and `doctor`
2. Focused nested-example and documentation-example tests
3. Full documentation generation and link validation
4. Root static checks
5. Root package build
6. `git diff --check` and tracked-file review

Provider login and interactive agent startup require the operator's existing
credentials and will not be automated by tests. The final report must identify
those manual checks separately.

## Risks and mitigations

### Nearest-config selection

Running lifecycle commands from the repository root will no longer find the
example configuration. Root `example-*` targets must delegate with `make -C`
so discovery begins in the example directory.

### Development startup

The root `pnpm dev` command starts the daemon from the repository root. The
example `dev` target must provide an absolute `NANASA_REPO_ROOT` while invoking
the root workspace command.

### Provider state migration

Membership-scoped state paths move with the configuration root. Copying old
state risks carrying credentials or stale generated overlays into the example.
The supported path is clean setup and reauthentication.

### Packaged documentation

The npm package currently ships `dist`, templates, and root community files,
but not top-level examples. Packaged pages must remain useful without assuming
the source example exists beside them.

### Shared Git checkout

The nested example remains inside the Nanasa Git checkout. Provider processes
start in the example directory but are not an operating-system sandbox. Prompt
and permission policies do not replace filesystem isolation.

## Change log

* Plan created before structural migration.
* Prompt-scope correction completed and validated in the original location.
* Comprehensive configuration guide completed and validated.
* Tracked example configuration moved without copying private runtime data.
* Root and example Make targets separated; explicit root delegates added.
* Claude gateway moved into the example Makefile while retaining the adapter's
   recognized `make claude-copilot` wrapper contract.
* Source example runbook, packaged catalog, and multi-provider walkthrough added.
* Nested configuration, prompt ordering, reviewer policy, launcher command, and
   tracked private paths covered by a focused regression test.
* Example setup and doctor, focused Vitest coverage, generated documentation,
   formatting, lint, TypeScript checks, package assembly, shell syntax, and diff
   hygiene completed successfully.
* Interactive provider login and live multi-agent startup remain operator
   checks because they require external credentials and long-running processes.