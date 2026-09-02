# Contribute to Nanasa

Contributors can change Nanasa while preserving its runtime ownership and safety
boundaries.

## Plan the change

Open an issue before a large change while interfaces are still evolving. Keep
one daemon authority per repository, SQLite durable facts, tmux process and
terminal ownership, portal-owned presentation, provider-neutral services, and
data-only provider extensions.

Do not add a second control plane, arbitrary plugin execution, compatibility
readers without an explicit migration plan, or terminal delivery as semantic
work acknowledgement.

## Set up the repository

Package development uses pnpm 10. Before every `npm`, `npx`, `pnpm`, or Corepack
operation, load `.devcontainer/.env` when it exists. Its registry values are
authoritative. Do not print, replace, regenerate, or commit that file.

```bash
set -a
source .devcontainer/.env
set +a
pnpm install
pnpm build
```

Run `pnpm dev` for the daemon watcher and Vite portal. The development portal is
normally at <http://127.0.0.1:5173> and proxies API and WebSocket traffic to the
daemon at <http://127.0.0.1:3210>.

## Write user documentation

Use short sentences and common words. Address the reader as "you." Put the
action before implementation detail. Define a Nanasa term on first use and
expand acronyms. Give a working example and expected result before linking to a
reference.

Each public page under `docs/next` starts with one H1 and has no YAML
frontmatter. Keep user workflows separate from contributor, protocol, and
release details. Use `npx nanasa` for package-user commands.

## Validate the change

Run the checks in [Testing](testing.md). Update generated references with the
documentation generator and commit deliberate fixture changes with their digest
manifest. Keep fault injection deterministic and process cleanup exact.

Review package artifacts for source maps, tests, credentials, databases,
terminal data, provider state, and private registry information before release.
