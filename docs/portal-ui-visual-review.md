---
title: Portal concept visual review
description: Independent screenshot review findings, mock refinements, evidence coverage, and remaining approval gates
ms.date: 2026-09-06
---

## Superseded design direction

The user rejected the component-reuse mock as a mixture of old controls and the
new visual language. This review and its passing checks describe that historical
prototype only; they do not establish design acceptance. Do not continue the
production-component restyling approach.

The current direction is the [entity-first experience](portal-ui-entity-design.md)
and [capability register](portal-ui-entity-actions.json): preserve capabilities
and safeguards, then reimagine their interactions using the Agents language.

## Historical review scope

The full-controls design preview runs at
<http://localhost:5182/agents>. The screen gallery is available at
<http://localhost:5182/review/index.html>, with the interaction gallery at
<http://localhost:5182/review/interactions/index.html>.

The preview reuses the current portal React controls with a local fixture client
and terminal transport. Production source and behavior remain unchanged. The
earlier visual study at <http://localhost:5181/mock/portal-concept.html> is not
the control-parity review target.

The independent reviewer inspected 28 of 56 screen captures, covering all
14 route samples, and 57 of 79 indexed interaction captures. Desktop, mobile,
light, and dark examples were included. The reviewer also inspected a mobile
subscription probe and nearby source selectors. This was a screenshot/source
review, not an independent execution of every interaction.

The named Implementation Validator could not access image tools and returned no
findings. A general reviewer subagent with image access completed the review.

A focused follow-up inspected nine regenerated images. It confirmed transcript
readability, subscription containment, narrow terminal identities, and the
quieter heading hierarchy. It caught a more-specific message checkbox rule and
a full-page capture resize that closed action menus. Both were corrected in the
mock and checked with computed geometry and a visible-menu assertion.

## Findings and disposition

| Priority | Finding | Mock refinement | Remaining boundary |
| --- | --- | --- | --- |
| High | Light-mode transcript text used a dark background with dark text | Pair dialog, output, search, and feedback colors with theme tokens | Keep production accessibility fixes separate |
| High | Desktop subscriptions clipped labels and checkboxes | Use viewport-bounded positioning; verify actual pointer hit testing at 1440px and 390px | A production anchored portal should use collision detection |
| Medium | Narrow terminal action strips truncated agent identity | Use two header rows at narrow pane widths, retaining the complete action strip | Check dense multi-column workflows during approval |
| Medium | Checkbox labels appeared detached from their controls | Use intrinsic checkbox width and start-aligned label rows | Retain existing form semantics and validation |
| Medium | Repeated global headings consumed the first viewport | Reduce the shell heading to a quieter context strip | Consolidating semantic headings needs approved production work |
| Medium | Editor typography and spacing varied | Normalize field typography and spacing; populate inherited instruction fixtures | Explicit empty instruction content requires a structural change |
| Low | Tall rows added empty space around small metadata | Reduce unnecessary minimum heights and vertical padding | Comfortable and compact preferences remain available |
| Low | Provider detail framing and command fixtures were inconsistent | Add inspector padding, replace nested boxes with separators, and use provider-specific strategies/commands | All lifecycle and trust controls remain intact |

Reviewer refinements are isolated to the mock stylesheet, fixture data, and
capture tooling. No controls were removed to achieve the visual changes.

## Capture coverage

The screen audit captures all ten global routes, all three team route types,
and an additional frontend terminal example. Each is captured at 1440px and
390px in both light and dark themes: 56 screen images.

The interaction audit contains 79 named states, including:

* Command palette, search, utility menu, system status, and ad-hoc console
* Group creation, filled form, menu, settings, inline rename, and delete confirmation
* Agent menus, settings, rename, move, remove, details, grouping, search, and prompt layers
* Role presentation, compact preferences, and reduced-motion preferences
* Stop-all confirmation, terminal columns, focus, pin, observe, search, selection, and transcript
* Previous checkpoints, selection tooltip, subscriptions, and unsubscribe state
* Attention selection, history, team filtering, empty results, URL details, and launch consent
* Direct, multicast, and broadcast messages; intent modes; prompt-when-ready; clear confirmation
* Workspace creation, assignment, activation, attachment, and switch confirmation
* Provider drift, install plan, removal confirmation, and service restart preview
* Working, recovery, stopped, empty, disconnected, and recovery-results scenarios
* Mobile navigation, dialogs, composers, subscription details, and transcripts

Capture names and visible control inventories are recorded in generated
`test-results/portal-parity/interactions/interaction-audit.json`. Raw captures
and reports are generated artifacts, not production assets. Full-page screenshots
do not by themselves prove internal scrolling, focus behavior, or every possible
combination of state and screen size.

## Verification and limitations

The client check compares the mock implementation with the actual `PortalClient`
interface: all 73 current methods are implemented and exercised locally. The six
fixture scenarios are validated against the existing contract schemas. This
establishes interface coverage, not real backend equivalence. Git, commands,
provider installation, permission decisions, messages, and service state are
simulated; no real work is performed.

The browser audit checks screen rendering, horizontal overflow, WCAG rules,
runtime errors, and daemon requests. Inherited terminal ARIA attributes and the
static Help article's scroll focusability are narrowly identified and retained
in the raw report. They are not silently treated as fixed. Their production
markup remains unchanged.

Browser notification and clipboard behavior still depends on browser permission
and security policy. Fixture lifecycle timing is illustrative, and automated
method coverage is not a claim that every possible failure or race is modeled.

Final verification results:

* All 73 client methods are present and exercised; all six scenarios pass schemas.
* All 56 screen/theme/viewport checks pass with no new audit findings.
* Ten inherited accessibility rule occurrences remain explicitly recorded.
* All 79 named interaction states are captured with no runtime or capture failures.
* No daemon API traffic was observed; explicit API requests receive HTTP 403.
* Subscription hit testing and transcript contrast pass at desktop and mobile widths.
* Mobile terminal heights remain bounded; open menus stay visible during captures.
* Mock TypeScript and ESLint checks pass.
* Production source, existing Agents mock, manifests, and lockfile remain unchanged.

## Reproduce

From the repository root, load the configured registry environment before
package-manager commands:

```bash
if [[ -f .devcontainer/.env ]]; then
  set -a
  source .devcontainer/.env
  set +a
fi
pnpm --filter @nanasa/portal exec vite --config mock/parity/vite.config.ts
```

In a second terminal:

```bash
node --import tsx apps/portal/mock/parity/check.mjs
node apps/portal/mock/parity/capture-interactions.mjs
```

## Approval gate

This POC was reviewed but not accepted as the design direction. The entity-first
replacement must be designed, exercised, and reviewed independently. Its
capability coverage and screenshots cannot be inferred from this historical
audit. No production rollout is approved.