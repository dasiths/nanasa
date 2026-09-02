# Fix provider login and launch

Package users can fix provider state selection, missing credentials, and failed
agent starts without copying secrets into repository files.

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
