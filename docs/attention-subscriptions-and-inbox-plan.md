---
title: Attention subscriptions and unified inbox plan
description: Implementation plan for configurable agent Attention subscriptions, unified inbox rows, stacked toasts, and optional browser notifications
---

## Goal

Make Attention a subscribed operator inbox rather than a complete projection of
every available event. Repository configuration defines the default event
subscriptions for each agent. The terminal toolbar bell opens an agent-scoped
dropdown where an operator can store durable overrides.

Every item admitted by the effective subscription creates an Attention item and
a temporary in-app toast. A global browser setting can also deliver the same
item through the browser Notification API. Events rejected by subscription
policy remain available through their durable source domain, but do not enter
Attention and do not produce a notification.

## User outcome

An operator can:

1. Open an agent terminal's existing bell menu.
2. Select the event types that should enter Attention for that agent.
3. See whether each value comes from repository configuration or an operator
   override.
4. Reset the agent to repository defaults.
5. Receive a stacked in-app toast for every newly admitted Attention item.
6. Enable browser notifications globally across subscribed agents.
7. Review admitted items in one continuous inbox.
8. Open the relevant terminal, messages, or setup surface from each item.
9. Dismiss individual items or bulk-dismiss selected items.

## Product decisions

### Attention admission and notification are one policy

An event subscription controls both inbox admission and notification delivery:

```text
subscribed event = Attention item + in-app toast + optional browser notification
unsubscribed event = durable source history only
```

There is no independent per-event toast toggle. This prevents a second settings
model from drifting away from the inbox model.

### Source events remain durable

Subscription policy must not suppress status revisions, actions, delivery
outcomes, provider updates, launch consent requests, messages, or domain events.
It controls only the operator-facing Attention projection. Agent details,
activity, messages, and terminal state remain truthful when an event is not
subscribed.

### Changes update the live projection

Changing a subscription immediately recomputes the live Attention projection.
Disabling an event removes matching projected items without deleting their
durable source history. Enabling an event can admit a currently active item and
produce its first toast, but does not synthesize old resolved incidents or
revisions. Operators can dismiss admitted items individually or with bulk
dismissal.

### Browser delivery is global across agents

Browser notifications are controlled by one portal preference for the current
operator. Browser permission remains local to each browser profile and device.
The first release sends browser notifications only while a Nanasa portal tab is
open. Service-worker delivery while the portal is closed is outside this scope.

### System integrity remains visible

Repository security, daemon continuity, authentication, and configuration
integrity failures are not agent events. They remain globally visible and are
not controlled by an agent terminal bell.

## Semantic event taxonomy

The public policy uses provider-independent event names. Provider hook names and
status protocol details do not appear in configuration or portal controls.

| Event type | Default | Attention sources | Destination |
|------------|---------|-------------------|-------------|
| `response-required` | On | Waits, questions, permissions, approvals, launch consent | Terminal or consent review |
| `agent-health` | On | Agent failure, suspected stuck state | Terminal |
| `completion` | On | New unacknowledged completion revision | Terminal |
| `delivery-failure` | On | Failed message delivery | Messages |
| `action-state` | Off | Active and terminal exact actions | Terminal |
| `provider-update-failed` | On | Failed or ownership-uncertain provider update | Setup or terminal |
| `provider-update-succeeded` | Off | Successful provider replacement | Setup or terminal |
| `unread-message` | Off | Group unread-message summary | Messages |

Group-level events without a member use repository defaults. Agent-specific
overrides apply only when an item has an exact group and member identity.

## Configuration contract

Add a strict, defaulted `attention` section to configuration version 2. Add a
partial agent override inside each configured agent.

```yaml
attention:
  defaults:
    response-required: true
    agent-health: true
    completion: true
    delivery-failure: true
    action-state: false
    provider-update-failed: true
    provider-update-succeeded: false
    unread-message: false

groups:
  backend:
    name: Backend Team
    agents:
      project-manager:
        memberId: project-manager
        name: Project Manager
        integrationId: copilot
        attention:
          completion: true
          action-state: true
```

Effective policy is resolved in this order:

```text
repository defaults < configured agent values < operator overrides
```

The API returns a source for every effective field:

* `repository-default`
* `agent-config`
* `operator-override`

## Durable persistence

Increase the database schema version from 13 to 14. Add a strict table for
operator overrides:

```sql
CREATE TABLE attention_subscription_overrides (
  operator_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (operator_id, group_id, member_id, event_type)
) STRICT;
```

Deleting an agent or group removes matching overrides. Resetting an agent's
menu removes its override rows and exposes current repository defaults again.
The existing `attention_dismissals` table continues to store durable item
dismissals.

## API contracts

Add authenticated operator routes:

| Method | Route | Purpose |
|--------|-------|---------|
| `GET` | `/api/v1/attention-subscriptions` | List effective repository defaults and active-member policies |
| `PUT` | `/api/v1/groups/:groupId/members/:memberId/attention-subscriptions/:eventType` | Set one durable operator override |
| `DELETE` | `/api/v1/groups/:groupId/members/:memberId/attention-subscriptions` | Reset one agent to config defaults |

Mutation responses return the complete effective member policy so the portal
does not construct policy optimistically. Unknown memberships return the
existing `membership_not_found` domain error.

## Attention projection

Keep source-domain projection in `attention-items.ts`. Add one pure admission
function that maps each item to a semantic event type and evaluates the effective
subscription snapshot.

Apply admission before the item list reaches:

* Attention counters
* Navigation badges and document title
* In-app toast delivery
* Browser notification delivery
* Repository and group Attention routes

The sequence is:

1. Derive candidate items from the durable snapshot and action workspaces.
2. Map each candidate to one semantic event type.
3. Resolve repository or exact-member policy.
4. Remove unsubscribed candidates.
5. Remove durably dismissed item IDs.
6. Publish the resulting list as the sole portal Attention collection.

This ordering ensures an unsubscribed item cannot affect a count or trigger a
notification.

## Terminal toolbar bell

Replace the completion-only bell toggle in `TerminalPane` with an anchored
dropdown. Preserve the current toolbar order and density: bell, pin, and focus.

The dropdown contains:

* Agent name and an `Attention` heading
* One checkbox per semantic event type
* Config or override source labels
* Reset to config defaults
* Global browser notification state and a link to Preferences

The menu opens beneath the clicked bell, closes on Escape or outside click, and
restores focus to the bell. Checkbox changes persist immediately through the
typed API. A failed mutation restores the server value and displays an inline
error.

Bell presentation communicates policy state:

* Ringing bell when at least one event is subscribed
* Off bell when every agent event is disabled
* Accessible label reporting the subscribed event count

## Unified Attention inbox

Replace source-oriented sections with one continuous list and four views:

* `Needs action`
* `Active`
* `History`
* `All`

Rows use one shared structure:

* Selection checkbox
* State indicator
* Agent or group identity
* Plain-language state badge
* Team, event type, and relative time
* Short summary
* Expandable related or diagnostic details when available
* One contextual destination action
* Dismiss

Bulk mode exposes only `Dismiss selected` and `Clear selection`. Retry,
approval, cancellation, acknowledgement, and other domain actions remain on the
destination surface.

## In-app toast behavior

Every newly admitted item can create one in-app toast. Existing items loaded
during initial hydration do not replay.

Toast rules:

* Stack at the bottom-right without overlap
* Show the newest toast at the top
* Keep at most four visible toasts
* Expire after five seconds
* Pause expiry while hovered or keyboard-focused
* Use the same title, summary, and destination as the inbox item
* Do not dismiss the inbox item when the toast expires or closes
* Do not repeat an item after refresh, event-stream reconnect, or another tab's
  delivery claim

## Browser notification behavior

Retain the existing global desktop-notification preference and permission flow.
Deliver a browser notification only when:

* The item passed Attention subscription admission
* Browser notifications are globally enabled
* The browser permission is `granted`
* The portal document is hidden or unfocused
* This tab wins the existing cross-tab delivery claim

Clicking a browser notification focuses Nanasa and opens the item's contextual
destination. Titles and bodies must not include prompt text, command content,
environment values, or credentials.

Preferences show:

* Browser notification toggle
* `Off`, `Permission required`, `On`, or `Blocked` permission state
* Send test notification
* Explanation that a portal tab must remain open

Permission requests happen only after an explicit operator gesture.

## Compatibility and migration

The configuration additions are defaulted and remain compatible with version 2
files. The daemon subscription policy supersedes the browser-local
`completionNotificationMemberIdsByGroup` preference. The portal ignores and
strips that obsolete field during normal preference persistence. Repository
configuration and durable operator overrides are the only subscription sources.

Existing Attention dismissals remain valid because item identity does not
change solely due to subscription policy.

## Implementation phases

### Phase 1: Contracts and policy resolution

* Add event taxonomy, config schemas, effective policy schemas, and API commands
* Add pure precedence and item-to-event mapping tests
* Update config examples and generated references

### Phase 2: Persistence and routes

* Add schema version 14 and migration coverage
* Add bounded store methods for list, set, reset, and cleanup
* Register typed authenticated routes and control-client methods
* Add operator-isolation and database-reopen tests

### Phase 3: Portal admission

* Load effective subscriptions with portal startup state
* Filter candidate Attention items before counts and delivery
* Add tests proving unsubscribed events affect neither inbox nor notifications
* Add tests proving source-domain status and actions remain available

### Phase 4: Terminal bell dropdown

* Replace the completion toggle with the anchored agent menu
* Add keyboard, focus restoration, narrow-layout, source-label, and failure tests
* Remove completion-only browser preference behavior

### Phase 5: Unified inbox

* Replace sectioned panels with the shared row list and views
* Add per-item destinations and durable individual dismissal
* Add selection with durable bulk dismissal
* Preserve partial-workspace errors and exact wait navigation

### Phase 6: Notification delivery

* Make all admitted items eligible for in-app toast delivery
* Implement the bounded pauseable toast stack
* Integrate the global browser channel after subscription admission
* Verify cross-tab claims, hidden-document behavior, and permission states

### Phase 7: Validation and rollout

* Run full daemon and portal suites
* Run formatting, lint, type checks, docs checks, and package build
* Validate all built-in providers with subscriptions enabled and disabled
* Verify reload, reconnect, multiple tabs, and browser permission denial
* Verify desktop and narrow mobile layouts with browser screenshots

## Acceptance criteria

* Disabling an agent event prevents future matching items from entering
  Attention.
* An unsubscribed event produces no in-app or browser notification.
* The underlying durable source event remains queryable.
* Enabling an event admits the next matching incident without replaying history.
* Config, agent, and operator precedence is deterministic and visible in the UI.
* Operator overrides survive daemon restart, browser refresh, and a new browser
  session.
* Every admitted item creates at most one toast per browser delivery claim.
* Four simultaneous toasts stack without overlap and expire independently.
* Browser notifications remain globally controlled and never request permission
  without an operator gesture.
* The terminal bell menu is scoped to the exact group member that owns the
  terminal.
* Attention uses one list, one contextual action, Dismiss, and bulk dismissal.
* Existing source-domain workflows and durable dismissals continue to work.

## Explicit non-goals

* Web Push or notifications while no portal tab is open
* Provider-specific subscription names
* Rewriting repository YAML from the portal
* Suppressing source-domain persistence
* Bulk retry, approve, cancel, reply, or acknowledge actions
* Retroactively creating Attention items when a subscription is enabled