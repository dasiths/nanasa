# Fix provider login and launch

Package users can fix provider state selection, missing credentials, and failed
agent starts without copying secrets into repository files.

## Agent tools changed after an update

Preview recovery before changing a running agent:

```bash
npx nanasa run recover <group-id> --body '{"dryRun":true}'
```

Then recover the group or one configured agent:

```bash
npx nanasa run recover <group-id>
npx nanasa run recover <group-id> <agent-id>
```

Nanasa keeps healthy current agents running and restarts affected agents with
the latest setup. A restart can interrupt work in progress. The previous run and
terminal history remain available.

Recovery compares the run's persisted snapshot digest with the active provider
digest before loading executable provider policy. Historical snapshots remain
immutable raw audit records. Nanasa does not decode an unsupported historical
capability payload to restart an outdated run.

A custom launcher may require renewed approval when its launch settings change.
Review and approve the pending launch request, then run recovery again. Approval
is distinct from process recovery and is never implied by a force option.

If Nanasa reports that it could not safely identify the old process, inspect the
run and terminal before continuing. Retry the exact run only when stopping it is
appropriate:

```bash
npx nanasa run recover <group-id> <agent-id> --body '{"forceIndeterminate":true}'
```

Forced recovery remains fenced to the persisted run, generation, terminal
binding, and tmux ownership tags. If those identities changed or do not match,
Nanasa leaves the process alone. Do not delete state or manipulate tmux panes to
bypass this check.

## Login says `--agent` is required

This means the integration uses `membership` state or a custom path containing
`{agentId}` and Nanasa cannot choose an agent-specific home.

Run:

```bash
npx nanasa config show
```

Find the key directly beneath `groups.<group-id>.agents`, for example
`agent_builder`. Then run:

```bash
npx nanasa auth login copilot --agent agent_builder
```

The nested `memberId`, such as `copilot.builder`, is for communication and will
select no login home. Add the agent to configuration before login and reuse the
exact map key. Do not invent an ID at the command line. See
[Authentication](../guides/authentication.md).

## Login opens the wrong provider home

This means the integration key, agent map key, or `providerState` policy differs
from the run you intend to start.

Run:

```bash
npx nanasa state list
```

Compare the integration, membership binding, and storage reference. Stop the
agent before changing its integration or state policy. Run `setup`, authenticate
the corrected scope, and start a new run.

Do not copy credential files between membership homes. Choose integration scope
explicitly when state should be shared.

## A broker profile is unavailable

This means the profile is missing, provider or target variable is mismatched,
the source environment value is empty, the helper failed, or file permissions
are unsafe.

Run:

```bash
npx nanasa doctor
```

Check `~/.config/nanasa/credentials.json`, or the equivalent path under
`XDG_CONFIG_HOME`. It must be an owner-owned regular file with mode `0600`.
Confirm that the profile ID matches the YAML and that its provider matches the
integration kind. Set the placeholder source variable in the daemon's
environment or repair the helper.

Do not put the credential value in `.nanasa/config.yaml` or commit the broker
file. See [Credential broker profiles](../guides/authentication.md#use-a-credential-broker-profile).

## A custom provider waits for launch consent

An explicit integration command runs repository-selected code. Nanasa pauses
the first launch before creating a provider process, binding credentials, or
writing private launch state.

Open the selected member's terminal or the Attention workspace. Compare the
exact command, launcher strategy, working directory, environment variable
names, credential mode, permission floor, and repository launcher file digest.
Select **Trust and start** only after reviewing that code. Nanasa reuses the
approval until a security-relevant property or hashed launcher file changes.

If the request was denied, later starts remain denied for that exact digest.
Revisit or revoke the decision instead of editing unrelated configuration. If a
request is stale, start again and review the replacement request.

## The Claude example says LiteLLM is not ready

The multi-coding-agents Claude launcher checks LiteLLM before it prepares state
or starts Claude Code. From the repository root, run:

```bash
make -C examples/multi-coding-agents proxy-status
make -C examples/multi-coding-agents proxy-start
```

Authenticate with `auth-litellm` if startup requires it. Keep `LITELLM_KEY` in
the operator environment; do not add it to `.nanasa/config.yaml`, command
arguments, logs, or committed files.

## An agent starts and then fails

This usually means the native provider CLI rejected login, arguments, model,
managed configuration, or resume state.

Run:

```bash
npx nanasa status list
npx nanasa run list
```

Open the agent terminal and read the provider's error. Confirm the scoped login
using the same integration and agent map key, then start a new run. If resume
state is invalid, allow the configured recovery policy to start a fresh native
session.

Do not delete the whole provider home before preserving needed provider sessions
and inspecting Nanasa-owned health. See [Built-in providers](../guides/providers.md).
