# Documentation refactor plan

## Goal

Make Nanasa easy to understand, install, configure, and use from an npm package.
Keep contributor and protocol details available without putting them in the main
user path.

The public documentation will use simple language. It will use examples before
reference material and explain each Nanasa term when it first appears.

## What the research found

### The README does too much

The [README](../README.md) is 640 lines and about 4,000 words. It is both the npm
landing page and the main technical manual. It mixes:

* Package installation and first use
* Repository development commands
* Runtime architecture
* Terminal protocol details
* Agent status rules
* MCP details
* Portal behavior

A package user has to read through implementation details to find basic tasks.
The README should be a short product and installation page. Detailed guidance
should live in the documentation.

### The documentation pages are too small

There are 19 pages under [docs/next](next/index.md), but together they contain
fewer words than the README. Important user pages are especially short:

* [Installation](next/installation.md) has about 180 words
* [Configuration](next/configuration.md) has about 110 words
* [Providers](next/providers.md) has about 180 words
* [Concepts](next/concepts.md) has about 150 words

Most pages state rules but do not show a complete task. A new user cannot follow
them from installation to a working group of agents.

### The first-run path is incomplete

The generated [configuration template](../templates/config.yaml) enables four
provider integrations but defines no groups or agents. `nanasa doctor` checks
every configured provider command. The first-run guide must tell users to remove
providers they do not use.

The default provider state scope is `membership`. Authentication for this scope
needs a configured agent ID:

```bash
npx nanasa auth login copilot --agent agent_builder
```

Here, `agent_builder` is the map key under
`groups.<group-id>.agents`. It is not the nested `memberId` value. The current
CLI does not reject a typo, so the guide must reuse the exact map key from the
YAML example. Otherwise, a user can authenticate a provider home that no run
will use.

The current installation page does not explain this distinction or that the
agent must be added to configuration before login. The quickstart must put the
steps in the order that users perform them.

### Scoped prompts are not documented as a task

Nanasa supports instruction files at four user-defined scopes:

1. Global
2. Group
3. Role
4. Agent

The effective prompt uses that order after Nanasa's built-in coordination and
assignment text. The full example is in the README, while the configuration page
only links to the generated schema.

The new guide must explain:

* What each scope is for
* Which scope wins when guidance becomes more specific
* How to lay out instruction files in a repository
* How roles add both instructions and a permission policy
* Why one instruction file cannot be referenced more than once
* Why prompt changes require stopped agents
* The file and combined prompt size limits

### Scoped authentication needs its own guide

Nanasa has two separate forms of authentication:

* Portal authentication controls human access to the local web interface
* Provider authentication lets an agent CLI use its model provider

Provider state can use three scopes:

* `membership` gives each configured agent its own provider home
* `integration` shares one provider home across agents using an integration
* `custom` uses a repository-local path pattern

The current provider page describes these in one paragraph and gives no working
configuration. It also mentions named credential references without documenting
the broker file.

The credential broker reads
`$XDG_CONFIG_HOME/nanasa/credentials.json`, or
`~/.config/nanasa/credentials.json` when `XDG_CONFIG_HOME` is not set. This is a
private user file, not `.nanasa/credentials.json`. Documentation must use the
actual path and must not put secrets in repository configuration.

### The generated configuration schema describes the wrong shape for authors

The current generated JSON Schema comes from the normalized runtime model. That
model requires an `id` inside each integration. Authored YAML does not include
that field. The parser adds it from the integration map key after validation.

The current schema must not be presented as a validator for hand-written
`.nanasa/config.yaml` files. The refactor should first expose an authoring schema
that matches the raw YAML format. Until then, examples must be tested through
the same `parseNanasaConfigSource()` path used by Nanasa.

### User and contributor content is mixed

The current index gives installation, protocols, testing, contributing, and
release pages similar weight. It does not identify the main route for someone
who installed Nanasa from npm.

The documentation needs three clear paths:

* Use Nanasa
* Operate and troubleshoot Nanasa
* Develop Nanasa or integrate with its APIs

### Package documentation exists but is hard to find

The package build copies [docs/next](next/index.md) into `dist/help`, and the
release gate checks that the help index is present. The npm package also ships
the root README. However:

* The CLI does not provide a command that opens or locates the packaged help
* The portal Help panel uses a separate hard-coded help source
* The README is the only obvious documentation on the npm package page
* Relative documentation and image links must work on both GitHub and npm

The README therefore needs to stand alone as an npm landing page and link to a
canonical online documentation location. Packaged help should either become
discoverable or stop being described as a user-facing feature.

### Frontmatter is enforced by repository code

Every public Markdown page currently starts with YAML frontmatter. The
[documentation validator](../scripts/validate-docs.mjs) requires it and forbids
an H1 heading.

The refactor will remove frontmatter from the README and public pages under
`docs/next`. Each page will instead start with one clear H1 heading. The
validator must be changed in the same pull request so the documentation checks
continue to pass.

Agent customization files, such as repository instructions, are outside this
public-documentation change. Their metadata should only be changed when the tool
that loads them no longer needs it.

## Primary audiences

### Package user

A developer who installs Nanasa in a Git repository and wants a working agent
pool. This is the primary audience.

### Operator

A person who manages a running Nanasa instance, provider authentication,
services, remote access, recovery, and security.

### Contributor or integration author

A person who develops Nanasa or uses its HTTP, event, terminal, or MCP
interfaces.

Every page should name its audience in the opening sentence instead of using
frontmatter tags.

## Proposed information architecture

Keep `docs/next` as the source for the prerelease channel during this refactor.
Changing the release-channel layout can be a separate decision. Organize pages
by user task:

```text
README.md
docs/next/
  index.md
  getting-started/
    install.md
    quickstart.md
    first-team.md
  guides/
    configuration.md
    prompts.md
    authentication.md
    providers.md
    portal.md
    messaging-and-mcp.md
    services.md
    remote-access.md
    git-worktrees.md
    extensions.md
  concepts/
    groups-agents-and-runs.md
    state-and-recovery.md
    security.md
    accessibility.md
  reference/
    index.md
    cli.md
    configuration.md
    protocols.md
    generated JSON files
  troubleshooting/
    index.md
    startup.md
    providers.md
    terminals-and-remote-access.md
  development/
    contributing.md
    testing.md
    release.md
    support-matrix.md
  examples/
    minimal/
    first-team/
    auth-scopes/
```

The first screen of [the documentation index](next/index.md) should contain:

1. A one-sentence description of Nanasa
2. A prominent quickstart link
3. A short route for existing users
4. Separate links for operators and contributors
5. A small glossary for agent, integration, role, group, run, and member ID

## Required page content

### README

Target 300 to 500 words. Keep it useful when rendered on npm.

Include:

* What Nanasa does
* Current prerelease status
* Supported operating systems and required software
* One npm installation command
* A five-command quick path
* A small screenshot or diagram with a package-safe URL
* Links to quickstart, configuration, troubleshooting, and contributing pages

Move architecture, protocol behavior, provider internals, portal details, and
repository development commands into the relevant pages.

### Install Nanasa

Explain:

* Stable and prerelease package names or npm distribution tags
* npm as the primary example, with short pnpm and Yarn alternatives if supported
* Supported Node.js, Linux, tmux, and Git versions
* OpenSSH as a current first-run requirement because `nanasa doctor` checks it
* A follow-up option to make the OpenSSH check conditional for local-only use
* What `init`, `setup`, `doctor`, and `start` do
* What files are safe to commit and which directories must remain private
* How to upgrade or remove the package

Use `npx nanasa` consistently in package-user examples. Explain once that users
may call the local binary through another package manager.

### Quickstart

Provide one complete path that has been tested from a clean Git repository:

1. Install the exact published prerelease or a verified `next` distribution tag
2. Run `npx nanasa init`
3. Keep one installed provider and remove unused integrations
4. Add one group and one agent with a stable agent ID
5. Run `npx nanasa setup`
6. Authenticate that agent's provider home
7. Run `npx nanasa doctor`
8. Start Nanasa
9. Open the one-use portal URL
10. Start the agent and send a message

Show the expected result after each important step. End with links to add another
agent, add scoped prompts, enable MCP, and install a user service.

The YAML and login command must use the same configured agent map key. Label the
nested `memberId` separately so users do not pass it to `--agent`.

### First team

Build a useful two-agent example:

* One implementor
* One read-only reviewer
* One shared group instruction
* One role instruction for each role
* Separate agent IDs and provider homes
* One provider login for each configured agent map key
* Start all agents from the portal
* Send a task to the implementor
* Ask the reviewer to check the result

The example should work with one provider integration so a user does not need
multiple provider accounts. With membership-scoped state, the tutorial must run
the login command once for the implementor and once for the reviewer. Tests must
confirm that both login homes match the homes used when those agents start.

### Configuration

Start with a minimal valid file, then a complete annotated example. Explain each
top-level section in the order a user needs it:

1. Repository
2. Integrations
3. Roles
4. Groups and agents
5. Instructions
6. Messages
7. Terminal checkpoints
8. Extensions

Keep generated schema details in reference material. Link each field group to the
human-readable reference. Do not recommend the current
[generated configuration schema](next/reference/config.schema.json) for authored
YAML until it is generated from the authoring input model instead of the
normalized runtime model.

### Scoped prompts

Show a repository layout and matching YAML for all four scopes. Include the
resolved order:

```text
Nanasa built-in guidance
Global instructions
Group instructions
Role instructions
Agent instructions
```

Explain that later scopes are more specific, but they do not erase earlier
text. Give short examples of what belongs in each scope. Show how the
`read-only` role policy differs from prompt wording.

### Authentication and provider state

Separate the guide into:

* Portal login with `npx nanasa auth portal`
* Provider-managed login
* Isolated per-agent state with `membership`
* Shared state with `integration`
* Advanced custom state paths
* Advanced credential broker profiles

For each provider state scope, include:

* A YAML example
* The matching authentication command
* When to use it
* What is shared
* What remains private
* The security trade-off

State clearly that `--agent` takes the agent map key under
`groups.<group-id>.agents`, not `memberId`. Test that the authentication command
and runtime provisioning resolve the same provider state directory.

Do not place real tokens in examples. Document owner-only permissions for the
credential broker file and show environment variable names as placeholders.

### Providers

Give each built-in provider a short section with:

* Required executable
* Integration `kind`
* Default command
* How Nanasa keeps provider state separate
* Authentication link or command
* Prompt and read-only support notes
* Resume behavior and known limits

Do not repeat the full authentication scope guide here.

### Portal and everyday use

Use the labels shown in the product. Cover:

* Create and rename a group
* Add, edit, move, and remove agents
* Choose an integration and role
* Start, stop, interrupt, and restart agents
* Use terminal tabs and grid view
* Read status and attention indicators
* Send and review messages
* Understand delivery versus task completion

Add current screenshots only after the layout has settled. Each screenshot needs
alt text and a short explanation of what to look for.

### Messaging and MCP

Start with tasks, not protocol versions:

* Send a human message from the portal
* Send a direct agent-to-agent message
* Send to several agents
* Broadcast to a group
* Report progress and completion
* Wait for a reply

Then explain MCP enablement, credentials, limits, and the generated tool
reference. Keep HTTP and terminal protocol details in the reference section.

### Troubleshooting

Use symptom-based titles and give each entry this order:

1. What the symptom means
2. The first command to run
3. How to read the result
4. Safe recovery steps
5. Actions to avoid
6. A link to deeper reference material

Include first-run failures caused by unused provider integrations, missing agent
IDs during membership-scoped login, an expired portal login, service readiness,
terminal lease changes, and lost SSH tunnels.

## Migration map

| Current page | New destination |
|--------------|-----------------|
| `README.md` | Short npm landing page; move details into guides and development pages |
| `installation.md` | `getting-started/install.md` and `getting-started/quickstart.md` |
| `concepts.md` | `concepts/groups-agents-and-runs.md` |
| `configuration.md` | `guides/configuration.md`, `guides/prompts.md`, and reference configuration |
| `providers.md` | `guides/providers.md` and `guides/authentication.md` |
| `continuity.md` | `concepts/state-and-recovery.md` and service operations |
| `state-and-models.md` | Agent lifecycle content in concepts; model fields in provider guides |
| `cli.md` | `reference/cli.md` with links from task guides |
| `api-events-terminal-mcp.md` | `guides/messaging-and-mcp.md` and `reference/protocols.md` |
| `git-worktrees.md` | `guides/git-worktrees.md` |
| `extensions.md` | `guides/extensions.md` |
| `remote.md` | `guides/remote-access.md` |
| `security.md` | `concepts/security.md` with task-specific warnings repeated where needed |
| `troubleshooting.md` | Split into the troubleshooting section |
| `accessibility.md` | `concepts/accessibility.md`, linked from the portal guide |
| `testing.md` | `development/testing.md` |
| `support.md` | `development/support-matrix.md`, with host support summarized in install |
| `contributing.md` | `development/contributing.md` |
| `release.md` | `development/release.md` |

## Example strategy

Create tested examples rather than copying large YAML blocks between pages.
Suggested examples:

```text
docs/next/examples/
  minimal/
    config.yaml
  first-team/
    config.yaml
    instructions/
      team.md
      implementor.md
      reviewer.md
  auth-scopes/
    membership.yaml
    integration.yaml
    custom.yaml
    credentials.example.json
```

Documentation can include these files or selected regions from them. Validation
should parse every example through `parseNanasaConfigSource()` in a temporary
Git repository. This checks the authored YAML shape, repository paths, and
instruction files. Prompt examples should include the instruction files they
reference.

After an authoring JSON Schema exists, validate examples against both that
schema and the runtime parser. Do not use the current normalized runtime schema
as a substitute.

Load the secret-free credential broker example through `UserCredentialBroker`
from an owner-only temporary file. Its profile ID must match the profile ID in a
parser-validated YAML example. Test both environment and helper profile shapes
without executing a real secret helper.

The examples must use fake IDs and placeholder environment variable names. They
must never include credentials or local provider state.

## Plain-language rules

Apply these rules to all user pages:

* Use short sentences and common words
* Address the reader as "you"
* Put the action before the explanation
* Explain one task per section
* Define a Nanasa term the first time it appears
* Expand an acronym the first time it appears
* Prefer a working example over an abstract rule
* State expected output or visible results
* Put implementation details in reference pages
* Use "user" or "person running Nanasa" instead of "operator" unless authority is the topic
* Avoid claims such as "easy", "simple", "robust", and "seamless"

A page should open with what the user can achieve, not with storage or protocol
internals.

## Frontmatter removal

Make the following changes together:

1. Remove YAML frontmatter from `README.md` and public pages under `docs/next`
2. Add one H1 title to each page
3. Change `scripts/validate-docs.mjs` to reject public frontmatter
4. Require exactly one H1 per public page
5. Replace its hard-coded flat required-page list with the new page tree or a
  navigation manifest
6. Keep duplicate-heading and local-link checks
7. Include the README in documentation validation
8. Update any Markdown lint rules that still require frontmatter

Do not mix frontmatter removal with unrelated code changes.

## Distribution and discoverability

### npm landing page

Treat the root README as the npm product page. Test its links and images against
the packed artifact, not only the source checkout.

Use one canonical online documentation base URL when one is available. Until
then, use absolute GitHub links for npm-facing navigation where relative links
are not reliable.

### Packaged help

Choose one of these paths before release:

1. Add a `nanasa docs` command that prints or opens the packaged help index
2. Link the portal Help area to the packaged documentation
3. Stop shipping `dist/help` and remove the claim that offline help is available

The recommended path is to keep packaged help and add a discoverable command.
The build already copies the pages, so the missing part is a supported entry
point. `nanasa docs` must work before `init`, outside a Git repository, and
without a running daemon. Add a packed-install test for that behavior.

Examples must remain under `docs/next` so the current package copy includes
them. Package validation must check links recursively inside `dist/help`, not
only links in the source tree.

### Generated reference

Keep JSON reference files generated from source. Add a human-readable reference
index that explains when to use each file. Task guides should link to reference
files only after showing the common path.

Generate the configuration JSON Schema from the raw authoring model. Keep any
normalized runtime schema internal or label it clearly so users do not add
runtime-only fields to YAML.

## Delivery phases

### Phase 1: Set the foundation

* Agree on the three audiences and the proposed page tree
* Set the README word target
* Decide the canonical online documentation URL
* Decide how users open packaged help
* Decide whether prereleases use an exact version or a maintained `next` tag
* Verify the selected npm tag against the public registry before publishing it
* Record the plain-language rules in the contributor guide

Exit condition: every current page has one destination and there are no unnamed
content owners.

### Phase 2: Fix first use

* Rewrite the README for npm users
* Write install and quickstart pages
* Add and test the minimal configuration example
* Document how to remove unused provider integrations
* Document the correct membership-scoped authentication order
* Distinguish the configured agent map key from `memberId`
* Add expected output and success checks

Exit condition: a new user can install Nanasa and start one agent by following
only the quickstart.

### Phase 3: Document the main workflows

* Write the first-team tutorial
* Write configuration and scoped prompt guides
* Write authentication and provider guides
* Write portal and messaging guides
* Add tested prompt and authentication examples
* Test the credential broker JSON example and its matching YAML reference

Exit condition: users can set up global, group, role, and agent instructions and
can choose an authentication scope without reading source code.

### Phase 4: Separate operations and development

* Move service, remote, worktree, extension, security, and recovery content into
  the operator route
* Split troubleshooting by symptom
* Move testing, contributing, release, and support details into the development
  route
* Split user-level MCP tasks from protocol reference

Exit condition: the main user route contains no repository build or release
steps.

### Phase 5: Remove frontmatter and strengthen checks

* Remove public frontmatter and add H1 titles
* Update documentation validation
* Replace the validator's old required-page list with the new navigation tree
* Validate example configuration files through the runtime authoring parser
* Generate a public JSON Schema from the authoring input model
* Check internal links and heading anchors
* Check the packed README and all links inside packaged help
* Add a package-help discovery path if selected in Phase 1

Exit condition: `pnpm docs:check` and package tests pass without public
frontmatter, and every published example is schema-valid.

### Phase 6: Plain-language review

* Review each page as a package user
* Replace jargon or define it
* Break long paragraphs into steps
* Remove duplicate explanations
* Check commands against CLI help and tests
* Check provider paths and authentication scopes against runtime code
* Run an accessibility review for headings, links, code blocks, and images

Exit condition: each page has one clear purpose, one audience, and a next step.

## Acceptance criteria

The refactor is complete when:

* The README is a short npm landing page
* Public documentation has no YAML frontmatter
* Every public page has one H1 title
* A clean quickstart works from package installation to a running agent
* The quickstart tells users to remove provider integrations they do not use
* Scoped prompts have a tested global, group, role, and agent example
* Scoped authentication has tested membership, integration, and custom examples
* `--agent` is documented and tested as the configured agent map key
* The credential broker path and permissions match runtime behavior
* Portal authentication and provider authentication are clearly separate
* User guides do not require knowledge of SQLite, PTYs, fencing, or idempotency
* Contributor and release details are outside the main user route
* All YAML examples pass the same authoring parser used by Nanasa
* The public configuration schema matches authored YAML
* CLI commands match generated help
* README links and images work from the npm package page
* The documented prerelease version or distribution tag exists before release
* Packaged help is discoverable or no longer advertised
* Documentation checks pass in continuous integration

## Recommended first pull request

Keep the first pull request narrow:

1. Rewrite the README
2. Add install and quickstart pages
3. Add one tested minimal configuration example
4. Replace the documentation index with audience-based navigation
5. Remove public frontmatter and update the validator
6. Leave deep protocol pages in place, but move them under an Advanced or
   Reference link

This first change gives npm users a clear path without waiting for every
advanced page to be rewritten.
