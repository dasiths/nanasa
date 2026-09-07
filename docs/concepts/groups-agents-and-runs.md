# Understand groups, agents, and runs

Package users can use these identities to read configuration, status, and
message history without confusing stable members with short-lived processes.

## Repository and group

One Nanasa daemon owns mutations for one repository. The repository contains
ordered groups. A group is an operator-created team with shared instruction
files, ordered agents, and one retained message timeline.

## Integration and role

An integration identifies a coding-agent provider command and provider-state
policy. Its map key, such as `copilot`, is stable configuration. A role describes
responsibility independently of provider choice. It can add prompt instructions,
a permission policy, and portal presentation.

## Agent map key and member ID

An agent is a stable group-owned configuration entry. Its map key, such as
`agent_builder`, identifies the configuration and a membership-scoped provider
home. Pass this key to `npx nanasa auth login ... --agent`.

The nested `memberId`, such as `copilot.builder`, identifies the member in
status, direct messages, sender envelopes, and MCP tools. It is not accepted as
the `--agent` value. The editable agent name is a display label and can change
without changing either stable identity.

## Run and generation

A run is one process lifecycle for an agent. Restart or confirmed pane loss can
create a new generation. Nanasa pins terminal leases, reports, actions, waits,
and MCP credentials to the exact run and generation so delayed input cannot
apply to a replacement process.

Process lifecycle and semantic work status are separate. A running process can
be idle, working, waiting, blocked, or suspected stuck. A delivered message
proves terminal transport, not acceptance or completion. Fenced provider reports
and explicit progress records carry semantic evidence.

## Ownership boundaries

Configuration stores desired topology and policy. SQLite stores durable domain
facts such as identities, runs, messages, deliveries, status, actions, waits,
events, and audits. tmux owns agent processes, live terminal bytes, geometry,
history, and exit evidence. The browser owns routes, focus, rendering, and local
preferences.

These boundaries explain recovery: a browser can reconnect without replacing a
run, and a daemon can adopt a matching tmux process after restart.
