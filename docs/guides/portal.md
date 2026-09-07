# Use the portal

Package users can manage teams, watch terminals, review attention, and send
messages from Nanasa's local web portal.

## Open an authenticated session

Start Nanasa, then run `npx nanasa auth portal` in another terminal. Open the
one-use URL. The portal has repository operations, group navigation, system
views, and utility controls. On narrow screens, the application menu exposes
the same destinations.

## Manage groups and agents

Use **Create group** to add a named group and optional shared instruction files.
Use group settings to change the name or instruction paths. Move controls change
group order.

Within a group, use **Add agent** to choose a name, integration, optional role,
and agent instruction paths. Agent settings can change those fields. Use **Move
up**, **Move down**, or the move-to-group action to reorganize stopped agents.
Remove an agent only after checking whether its retained provider state or run
history is still needed.

Prompt-affecting group, integration, role, and instruction changes require the
affected agents to be stopped. Names and role presentation can change while an
agent runs.

## Control agent runs

Choose **Start** on one agent or **Start all** in the group header. The result
shows agents that started, were already running, or failed. **Stop** requests a
clean stop. **Interrupt** sends Ctrl+C to the owner pane. **Restart** creates a
new run generation when appropriate.

Choose **Stop all** in the group header to stop every active agent and close its
terminal pane. Nanasa asks for confirmation before it stops anything.

The portal checks for configuration, provider-file, and provider changes while
it is open. A warning appears when active agents may still be using older launch
settings. Stop and start those agents when it is safe to interrupt their work.

Recovery states distinguish reconciling, resuming, restarting, recovered, and
failed recovery. You can stop active recovery. Use retry only after recovery
reports that it cannot continue.

## Read status and attention

Process state says whether the tmux-owned command is starting, running,
stopping, stopped, or failed. Semantic status says whether the agent is idle,
working, waiting, blocked, suspected stuck, or finished. A suspected-stuck
state is a low-confidence signal based on missing progress, not proof.

Open **Attention** for questions, permission requests, plan approvals, failed
deliveries, health problems, and completion items. Reply to the exact wait or
open the linked terminal. A settled provider event does not by itself prove task
success.

## Use terminal tabs and grid view

Open an agent terminal from its group row. Tabs keep one terminal visible. Grid
view shows up to three columns and steps down on narrower screens. You can pin
or focus terminals and opt individual agents into future completion notices.

One controller can type, paste, resize, and approve terminal effects. Up to
three observers are read-only. Use **Take control** when a controller lease has
moved. Explicit takeover revokes the old controller without stopping the agent.

Use **Copy**, **Paste**, **Search**, and **Transcript** in the terminal toolbar.
Hold Shift while dragging on Linux or Windows, or Option on macOS, to override a
terminal user interface's mouse mode. The transcript is a bounded readable
surface, not a live replacement for the canvas terminal.

## Send and review messages

Open **Messages** for the selected group. Choose a direct recipient, several
recipients, or the group audience, then enter the task. Human submissions appear
as **Human**. Agent messages show the editable name and stable member ID.

Expand a delivery summary to see resolved recipients, retries, and failures.
Delivered means the text reached the recipient's terminal input. It does not
mean the provider read, accepted, or completed the task. Check status, progress,
replies, and terminal output.

The browser stores a per-repository, per-group read cursor. Opening Messages
marks retained messages as read. Clearing history deletes that group's stored
messages and delivery outcomes for all portal sessions.

## Adjust the interface

Choose light, dark, or system theme. Layout, terminal pinning, grid splits,
maximized terminals, and completion notification choices are browser-owned
preferences and synchronize across same-origin tabs when browser storage is
available. See [Accessibility](../concepts/accessibility.md) for keyboard,
clipboard, zoom, motion, and assistive-technology behavior.
