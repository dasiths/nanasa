# Install Nanasa

Package users can use this page to prepare a supported Linux host and add Nanasa
to a Git repository.

## Check the host

Nanasa supports Linux with glibc on x64 and arm64. The tested distributions are
Ubuntu 22.04, Ubuntu 24.04, and Debian 12. You need:

* Node.js 22 LTS or 24 LTS
* tmux 3.2 or later
* Git
* OpenSSH
* A current Chromium, Firefox, or WebKit-based browser
* At least one supported coding-agent CLI

OpenSSH is currently required even for local use because `doctor` checks for
the `ssh` executable. Native macOS and Windows hosts are unsupported. WSL2 is
in preview.

## Choose a package version

Preview releases use the npm `next` distribution tag. Stable releases use the
`latest` tag. Check which version a registry provides before installing:

```bash
npm view nanasa@next version
```

Install the preview and commit your package lockfile. The lockfile records the
exact version used by your repository:

```bash
npm install --save-dev nanasa@next
```

If your repository already uses another package manager, the equivalent forms
are `pnpm add --save-dev nanasa@next` and
`yarn add --dev nanasa@next`. The rest of this documentation uses
`npx nanasa` to call the repository-local binary. Use your package manager's
local-executable command if it has a different convention.

## Initialize the repository

Run this command from the Git repository:

```bash
npx nanasa init
```

`init` creates `.nanasa/config.yaml` only when that file is absent. It also
creates `.nanasa/.gitignore` entries for private runtime directories. It does
not overwrite existing configuration.

Edit the configuration before continuing. The template contains four provider
integrations. **Remove every integration whose executable you do not use.**
`doctor` checks every configured command, so an unused default causes a failure.
Then add at least one group and agent as shown in the
[quickstart](quickstart.md).

```bash
npx nanasa setup
npx nanasa doctor
npx nanasa start
```

`setup` validates the configuration and prepares private provider homes.
`doctor` checks the host, configured commands, and directory ownership.
`start` runs the daemon and portal in the foreground.

Run `npx nanasa docs` from any directory to print the absolute path to the
packaged documentation index.

## Know what the package contains

The npm package contains the CLI, daemon bundle, portal assets, packaged help,
systemd template, build identity, SPDX software bill of materials, license,
notices, README, and configuration template. It excludes tests, source maps,
credentials, provider state, databases, terminal data, and private registry
configuration.

## Commit only shared configuration

Commit `.nanasa/config.yaml`, `.nanasa/.gitignore`, and instruction Markdown
files that the team should share. Keep these generated and private directories
out of Git:

* `.nanasa/integrations/` for provider credentials, sessions, and managed files
* `.nanasa/runtime/` for live runtime files
* `.nanasa/state/` for the database, operator credential, and MCP signing secret

Do not put provider tokens or private keys in `.nanasa/config.yaml`.

## Upgrade or remove Nanasa

Stop Nanasa before changing the package:

```bash
npm install --save-dev nanasa@next
```

For a systemd user service, use the verified upgrade and rollback flow in
[Services](../guides/services.md). To remove Nanasa, stop and remove its service,
remove the package dependency, and keep or archive `.nanasa/state/` and
`.nanasa/integrations/` until you are sure you no longer need run history or
provider sessions.
