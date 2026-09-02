# Use Nanasa with keyboard and assistive technology

Portal users can operate navigation, dialogs, messages, attention, and terminals
with a keyboard and readable alternatives to canvas terminal output.

## Navigate the portal

Routes are deep linkable and announce navigation. Menus, dialogs, tabs, command
palette results, group controls, and terminal controls manage focus and return it
when they close. Repository operations and utility controls appear in a desktop
rail. A mobile application menu exposes the same destinations.

Nanasa supports reduced motion, forced colors, narrow layouts, and 200 percent
zoom. Light, dark, and system themes are available.

## Review messages and attention

Messages is the canonical history and unread surface. Terminal views provide a
compose shortcut without creating another history. Attention filter buttons use
pressed state and update one result list. Questions retain exact reply controls,
while health, completion, and delivery items link to their source.

One repository Attention count is visible in the desktop rail or mobile header.
Each selected group also has its own count. Unread counts appear only on message
surfaces.

## Read and control terminals

One controller can type. Observers can select and copy local text without
changing the pseudo-terminal. Hold Shift while dragging on Linux or Windows, or
Option on macOS, to override application mouse mode. With an existing selection,
Ctrl+C or Command+C copies. Without a selection, Ctrl+C remains terminal input.

Some terminal user interfaces own their selection and request a clipboard write
through OSC 52. Nanasa shows the controller only the byte count. Activate Copy
to approve the browser write. A denied request can be retried until it expires;
observers never receive it. tmux-wrapped OSC 52 needs tmux 3.3 or later. On tmux
3.2, use portal selection or the transcript.

Open **Transcript** for a bounded Document Object Model (DOM) view that works
with assistive technology and mobile selection. Previous-output checkpoints show
the generation, capture time, and truncation. They are not labeled as live
terminal state.

Browser clipboard access requires a user action. Denial is reported without
logging or rendering the clipboard payload.

## Control notifications

Completion notifications are off by default and can be enabled per agent from
its terminal toolbar. They affect future quiet in-app or silent desktop notices,
not status or attention counts. Attention sound has a separate default-off
setting, requires prior browser activation, and deduplicates the same urgent
item across same-origin tabs.
