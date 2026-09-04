---
title: Portal and agent continuity plan
description: Plan for restart notices, terminal status presentation, provider authentication, and Copilot custom-agent validation
---

## Goal

Make agent restarts understandable and quiet. The portal should show each state
once, avoid duplicate indicators, and preserve useful feedback across a browser
refresh. Provider restarts should reuse the same private state, while setup and
diagnostics should clearly distinguish provider authentication from portal
authentication.

## Confirmed behavior

### Restart notices

The daemon keeps the completed provider-update result in its snapshot. The
portal derives the restart notice from that result, but stores dismissal only
in component memory. Refreshing the page resets the dismissal and displays the
same completed update again.

The notice is absolutely positioned at the bottom of each terminal pane. The
quick-message launcher is fixed at the bottom-right with a higher stacking
level, so the two controls overlap by design.

### Provider authentication

Nanasa preserved the same membership-scoped provider directories across the
observed agent replacements. Each replacement launch also received the expected
provider home environment variables. Confirmed pane loss did not delete those
directories.

The current private state was created on September 2, 2026, shortly before the
recorded agent runs. It is not authenticated:

* Copilot reports `Logged out` in both recorded process logs.
* Pi has an `auth.json` file whose provider map is empty.
* OpenCode has no saved provider authentication in its isolated XDG data home.
* Claude Code through LiteLLM uses the gateway's separate authentication flow.

This means tmux loss exposed missing authentication when fresh provider
processes started. It did not erase credentials from the current homes. An
earlier successful login must have used different state, such as a provider's
global home or private state that was replaced before the current homes were
created.

The example's `first-run` target installs, initializes, prepares, diagnoses, and
starts Nanasa. It does not run the separate interactive provider-authentication
targets. The `portal-auth` target signs the browser into Nanasa only. Neither
operation signs the coding-agent providers into their model services.

Nanasa can preserve the directory selected for a provider, but each provider
owns its credential format, refresh behavior, and validity. Directory existence
alone is not proof that the provider is authenticated.

### Provider preferences and models

The retained provider home also preserves provider-owned preferences, history,
and session files. Whether a provider reads a particular preference after a
fresh launch remains provider behavior.

Nanasa records the requested and effective model for run status and audit. That
record does not automatically become a model argument for a later fresh run.
The current example configures `resumePolicy: preserve-session` but no model ID:

* A confirmed native session resume keeps the model selected by that session.
* A fresh replacement starts without a Nanasa model argument and uses the
   provider's persisted preference or default.
* A configured integration `model.model` is passed to every fresh launch.
* An agent `desiredModel` overrides the integration model.
* `enforce-configured` also reapplies the configured model during native resume.

Configure a model ID when model continuity must be guaranteed. Keep
`preserve-session` when a resumed conversation should retain its own model, or
use `enforce-configured` when configuration must win on every launch and resume.

### Copilot custom agent

Both recorded Project Manager generations contain the correct absolute
`--plugin-dir`, MCP configuration, custom-agent argument, and isolated
`COPILOT_HOME`. The generated plugin manifest and agent file also match the
requested custom-agent identifier.

Copilot's own plugin command discovers `nanasa-status-reporter` from that
directory. A direct invocation selecting the generated agent passes discovery
and stops at the missing-authentication check. The generated agent is therefore
valid in the current state.

The visible `Custom agent not found` message should be reproduced after scoped
Copilot authentication. Do not change agent generation or recovery from the
unauthenticated result alone.

### Terminal and team status

The first bulb next to an agent alias shows semantic agent state, such as
working, idle, starting, blocked, or failed. The second bulb shows browser to
terminal transport state.

The terminal header already renders that same transport state as text next to
`Control mode` or `Observe mode`. For example, it displays `reconnecting` or
`connected`. The second bulb duplicates this text without a tooltip or an
accessible label.

The team summary currently displays configured agents, live terminals,
starting agents, and working agents. Live and working are intentionally
different: an idle agent can have a live terminal without actively working.
Starting is transient and does not need a permanent zero-value slot.

## Product decisions

1. Position restart notices at the top of the terminal content, below the
   terminal header.
2. Remember dismissal for the exact provider-update identifier so a refresh
   does not show the same notice again.
3. Keep the semantic agent-status bulb beside the alias.
4. Remove the terminal-connection bulb because the adjacent header text already
   reports the same transport state.
5. Keep the explicit `Control mode` or `Observe mode` label and its connection
   text. This surface communicates both terminal ownership and connectivity.
6. Reduce the normal team summary to agents, live terminals, and working agents.
7. Show starting or recovery activity only while its count is nonzero, using a
   compact icon and count with an accessible label and tooltip.
8. Validate Copilot custom-agent behavior only after completing authentication
   in the exact membership-scoped home.

## Phase 1: Restart notice lifecycle

Extend portal preferences with a bounded collection of dismissed
provider-update identifiers. Scope the collection to the current repository in
the same way as other portal preferences.

When a completed replacement is projected:

1. Read its stable provider-update identifier.
2. Hide the notice when that identifier has already been dismissed.
3. Record the identifier when the operator closes the notice.
4. Retain only a bounded recent set so local storage cannot grow indefinitely.

Move the notice below the 34-pixel terminal header and anchor it to the top of
the terminal content. Keep it inside its terminal pane so multi-terminal layouts
retain clear ownership. Confirm that the quick-message launcher cannot cover
the notice at desktop or mobile widths.

Use browser-local persistence for this informational acknowledgement. It does
not change daemon state, agent recovery, or what another operator sees.

## Phase 2: Terminal status presentation

Remove the connection bulb from the terminal identity fragment. Retain the
semantic status bulb, its status-derived color, tooltip, and accessible name.

Keep the lease banner's text state because it answers two operator questions:

* Whether this browser controls or observes the terminal.
* Whether its terminal transport is connected, reconnecting, connecting, or
  closed.

Use styling or a familiar connection icon to emphasize abnormal transport
states without adding a second state value. The text remains the accessible
source of truth.

## Phase 3: Team summary

Render three stable measures in the group header:

* Configured agent count
* Live terminal count
* Working agent count

Use familiar icons with visible counts, tooltips, and screen-reader labels. Do
not rely on color alone. Add a transient starting or recovery measure only when
its count is greater than zero.

Preserve the existing definitions of live and working. This phase changes
presentation, not status calculation.

## Phase 4: Authentication workflow and continuity

Keep membership-scoped homes as the default. They provide predictable isolation
and are already reused correctly by replacement generations.

Clarify the example workflow so an operator cannot mistake portal login, setup,
or doctor checks for provider authentication. Use the second behavior for
`first-run`:

1. Run all interactive provider-authentication targets before starting the
   gateway and daemon.
2. Stop after setup and doctor, then print the exact authentication and start
   commands instead of launching unauthenticated agents.

Interactive authentication may require
different browsers, device-code flows, and Docker access, so an automatic chain
can be difficult to resume after one provider is cancelled.

Add a fixture-based recovery test that writes a non-secret marker into a
membership-scoped provider home, replaces the pane, and verifies that the next
generation receives the same path and marker. This validates Nanasa's
continuity guarantee without pretending to validate third-party tokens.

Do not make `doctor` claim that a provider is authenticated unless the provider
offers a stable, noninteractive status command. A missing or empty known auth
artifact may produce a warning, but file presence must not be treated as proof
of valid credentials.

## Phase 5: Copilot validation

Authenticate the Project Manager through the scoped example target. Confirm
that the command opens the same `COPILOT_HOME` recorded in the run binding.

After successful authentication:

1. Start a fresh Project Manager generation.
2. Confirm that Copilot selects the generated Nanasa agent.
3. Confirm that the status hook and MCP server initialize.
4. Replace or recover the pane and repeat the checks.
5. Capture Copilot's process log if the registry again reports no agents.

If the error reproduces while authenticated, compare Copilot's discovered
external plugins and available custom agents during the failing process. Fix
Nanasa only if the recorded command differs from the spawned command or the
generated plugin is unavailable to that process.

## Validation

### Portal tests

* A dismissed restart notice stays dismissed after component remount and page
  reload simulation.
* A different provider-update identifier displays a new notice.
* The notice is top-aligned below the terminal header.
* The quick-message launcher does not overlap the notice on desktop or mobile.
* The semantic status bulb remains labelled.
* No separate connection bulb is rendered.
* Control and observe modes continue to announce transport state.
* The team summary omits zero starting state and displays nonzero recovery state.

### Runtime tests

* Fresh and replacement generations resolve the same membership-scoped provider
  home.
* Recovery preserves a non-secret fixture marker in that home.
* Copilot launch bindings retain the plugin directory and custom-agent arguments
  for fresh and resumed launches.

### Manual checks

* Refresh the portal after dismissing a restart notice.
* Inspect two-column and four-column terminal layouts.
* Check narrow mobile layout and keyboard focus order.
* Complete each example authentication target, restart the provider process,
  and confirm the provider remains signed in.
* Reproduce Copilot custom-agent selection after scoped authentication.

## Completion criteria

The work is complete when restart notices appear once per browser for each
provider update, no bottom-right control obscures them, and terminal headers do
not repeat connection state. The team summary must remain understandable with
icons, text alternatives, and transient recovery feedback.

Provider replacement must continue using the same private state directory. The
example workflow must prevent setup or portal login from being mistaken for
provider login. Copilot custom-agent changes require an authenticated
reproduction or direct evidence that Nanasa launched a command different from
its persisted binding.

## Attention bulk actions

Completion alert preferences control transient in-app and desktop delivery.
They do not remove durable completion review items. Attention provides an
`Acknowledge all completions` action for the current scope and a browser-local
`Dismiss all updates` action for informational provider restart entries.

All rendered review, update, and progress items also support browser-local
per-item and category dismissal. Dismissal does not mutate daemon state. New
source identities, including later completion revisions and incidents,
resurface normally.