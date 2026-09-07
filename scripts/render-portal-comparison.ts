import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const root = resolve(process.argv[2] ?? "docs/assets/portal-comparison");
const documentPath = resolve(process.argv[3] ?? "docs/portal-before-after.md");
const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8")) as {
  capturedAt: string;
  viewport: { width: number; height: number };
  deviceScaleFactor: number;
  versions: Array<{ version: string; commit: string; teams: number; agents: number }>;
  captures: Array<{ version: string; state: string; theme: string; file: string }>;
  gaps: Array<{ version: string; state: string; error: string }>;
  browserErrors: Array<{ version: string; message: string }>;
};
const descriptions: Record<string, [string, string]> = {
  agents: [
    "All agents",
    "Matched list-only state with no selected inspector. Old uses configuration-scope, execution, and prompt columns; new uses runtime, model, and role columns. In the new navigation, All agents is a Teams subview. The old initial default selection was explicitly closed for this pair.",
  ],
  "agent-configuration": [
    "Agent configuration",
    "The same Backend Engineer is selected. Both show authored configuration and mapped workspace details; the new inspector adds management, session, and subscription entry points.",
  ],
  "agent-prompts": [
    "Prompt layers",
    "Both show the same global, team, and role instruction-source summary with Team expanded. This compares layer organization and a team-file path, not full instruction contents. No prompt text or provider output was substituted in the browser.",
  ],
  "teams-directory": [
    "Teams directory (new-only)",
    "No direct old equivalent. The old portal organizes teams through its sidebar tree; the new portal adds a dedicated searchable Teams directory. The team-members and team-edit pairs below compare the equivalent tasks.",
  ],
  "team-members": [
    "Team membership entry point",
    "Task comparison, not identical screens: old opens the team's terminals with members in the tree; new has a dedicated Members tab. Both select Backend Team.",
  ],
  "team-edit": [
    "Edit team",
    "Old opens a group-settings dialog from the sidebar menu; new edits within the selected team's inspector. Neither edit is saved.",
  ],
  "team-create": [
    "Create team",
    "Both begin creating Data Team. Old uses a sidebar form; new uses a create dialog in Teams. The new team is not submitted.",
  ],
  "team-delete": [
    "Review team deletion",
    "Both review deleting Backend Team and its three active agents. No deletion is confirmed. These images compare impact information, not backend deletion correctness.",
  ],
  "agent-create": [
    "Add agent",
    "Both use the team-header Add agent control and show the same draft name. This retained dialog is intentionally a largely unchanged workflow.",
  ],
  "agent-edit": [
    "Edit agent",
    "Old uses the sidebar agent-settings dialog; new uses the configuration inspector. Both inspect Backend Engineer with the same authored instructions and role. Save/Cancel fall below the initial new viewport; the next scrolled pair exposes them.",
  ],
  "agent-edit-actions": [
    "Agent editor actions (scrolled)",
    "The Save agent control is scrolled into view in each editor. Compare this with the initial Edit agent pair: the new inspector's actions fall below the first viewport, while the old dialog contains them. Nothing is saved.",
  ],
  "agent-organize": [
    "Organize agents",
    "Old exposes reorder, move, and lifecycle commands in an agent menu. New exposes explicit Organize controls in Members, with move/lifecycle actions in Session. These are equivalent task entry points, not equivalent command sets in one view.",
  ],
  "agent-remove": [
    "Review agent removal",
    "Both review removal of Backend Engineer. No removal is confirmed; the other agents continue running.",
  ],
  "terminal-grid": [
    "Terminal grid",
    "Three real safe-echo PTYs in Backend Team. New adds a role-glyph session strip above the existing live terminal panes. Output is fixture output, not an AI-provider conversation.",
  ],
  "terminal-focused": [
    "Focused terminal",
    "Backend Engineer is focused in both portals. Each viewport contains real terminal output and connection/ownership controls.",
  ],
  "terminal-subscriptions": [
    "Terminal Attention subscriptions",
    "Both open the terminal bell's subscription dialog for Backend Engineer. The existing event and inherited-setting controls remain available.",
  ],
  "terminal-search": [
    "Terminal search",
    "Both open the existing Search toolbar for the focused Backend Engineer terminal.",
  ],
  "terminal-transcript": [
    "Terminal transcript",
    "Both open the live tmux transcript dialog. No retained historical checkpoint exists in the fixture, so checkpoint selection behavior is not compared.",
  ],
  "terminal-tools": [
    "Additional terminal tools",
    "Both open the focused terminal's overflow menu. This compares existing terminal commands within their surrounding shell.",
  ],
  messages: [
    "Messages",
    "The same three message bodies are delivered to Backend Engineer in both versions before capture. Old shows a launcher for a modal composer; new attaches audience, intent, recipient, body, and execution controls to the conversation.",
  ],
  "message-compose": [
    "Compose a message",
    "The same draft targets Backend Manager in both portals, independently of the history messages sent to Backend Engineer. Old presents a modal; new keeps composition attached to the conversation. The draft is not sent.",
  ],
  "message-delivery": [
    "Delivery details",
    "Both expand recipient details for the latest fixture message after terminal injection is confirmed. Delivery is distinct from durable execution; this does not claim an agent completed the requested work.",
  ],
  "message-clear": [
    "Review message-history clearing",
    "Both open the history-clear confirmation. Stored message history is not actually deleted.",
  ],
  attention: [
    "Attention inbox",
    "A real managed browser request from Backend Manager populates both inboxes. Old presents actions on the event row; new presents an inspectable row with actions in the selected event's inspector.",
  ],
  "attention-url": [
    "Inspect browser request",
    "Both expose the same example.invalid URL. Old expands Full URL on the row; new opens the event inspector. The URL is not opened and no external site is contacted.",
  ],
  "attention-selected": [
    "Bulk Attention selection",
    "Both select the same request and expose durable bulk dismissal. Dismissal is not applied.",
  ],
  workspaces: [
    "Workspace overview",
    "Both have main plus a managed feature/frontend checkout assigned to Frontend Team. Old combines assignment and inventory; new starts with a branch directory.",
  ],
  "workspace-assignment": [
    "Workspace assignment",
    "Old exposes assignments for all teams; new inspects main and shows its current owners plus an assign-another-team control.",
  ],
  "workspace-create": [
    "Create workspace",
    "Both draft feature/platform and select Platform Team without enabling immediate activation. The worktree is not created.",
  ],
  "workspace-attach": [
    "Attach existing workspace",
    "Both open the retained attach-existing-worktree form. No filesystem path is submitted.",
  ],
  "workspace-switch": [
    "Review workspace switch",
    "Both review moving the three running Backend agents from main to feature/frontend. This destination is already assigned to Frontend Team. The preview is captured without applying it; it is not evidence the switch would be allowed.",
  ],
  "workspace-maintenance": [
    "Workspace removal protection",
    "feature/frontend is assigned and its removal control is disabled. Old shows this in inventory; new shows it in the Maintenance inspector.",
  ],
  "workspace-error": [
    "Workspace validation failure",
    "Both submit the same invalid branch name to the actual API. The returned invalid_worktree_branch error is real. In both versions the feedback is outside the open dialog and dimmed by its backdrop. This is an observed UI issue, not a capture failure. No valid worktree is created.",
  ],
  "provider-overview": [
    "Provider overview",
    "OpenCode's built-in package is selected in both. Old combines overview, plan, and lifecycle in one panel; new initially shows Overview in an inspector. Package readiness is not provider authentication.",
  ],
  "provider-plan": [
    "Provider plan",
    "Both expose permissions, owned mutations, and command preview. New has a Plan tab; old includes these in the combined detail panel. The initial new viewport cuts off lower metadata and approval; the next scrolled pair exposes them. No approval is submitted.",
  ],
  "provider-plan-approval": [
    "Provider plan approval (scrolled)",
    "The exact-plan approval button is scrolled into view in both versions. This additional viewport exposes the command metadata and approval control below the initial new Plan capture. Approval is not submitted.",
  ],
  "provider-lifecycle": [
    "Provider lifecycle",
    "Both expose lifecycle commands. New places them in a Lifecycle tab; old keeps them under the combined preview. No provider mutation is performed.",
  ],
  "provider-removal": [
    "Provider removal review",
    "Both type the same package ID into the conservative removal confirmation. New first expands Remove provider. Removal is not submitted; the fixture references this provider.",
  ],
  settings: [
    "Preferences",
    "Same presentation preferences. Old uses form/card groups and selects; new uses unframed sections and segmented Theme/Density controls. Browser notification permissions are not granted.",
  ],
  roles: [
    "Role presentation",
    "Both open the existing role-presentation dialog with matching Manager, Engineer, and Reviewer icons and colors. No settings are saved.",
  ],
  diagnostics: [
    "Diagnostics",
    "Both show actual daemon metadata, configuration status, and provider state. Checkpoints are below the initial new viewport; the separate scrolled pair shows that section. Version/build and random runtime identities legitimately differ.",
  ],
  "diagnostics-checkpoints": [
    "Diagnostics checkpoints (scrolled)",
    "The Terminal checkpoints section is scrolled into view. Both fixtures have no retained checkpoints. The new page places this section below its initial Full HD viewport; this pair supplies the missing visible evidence.",
  ],
  service: [
    "Service status",
    "Both show the real service descriptor for the temporary fixture. No systemd service is installed or restarted for this comparison.",
  ],
  remote: ["Remote access", "Both show real remote-access descriptors. No SSH tunnel is created."],
  help: [
    "Help",
    "Both display shipped generated help. The new layout changes section framing; command descriptions come from each version's registry.",
  ],
  release: [
    "About Nanasa",
    "Both open the shipped About view. The displayed configuration-derived identifier is not a substitute for the pinned source SHAs recorded above.",
  ],
  more: [
    "More menu",
    "Old keeps providers/preferences/help/about here while System routes are elsewhere; new folds provider and System destinations into More. Operations now contains Workspaces, Teams, Attention.",
  ],
  commands: [
    "Command palette",
    "Both open their actual registered command palette at its initial list position. Lower entries and some descriptions continue beyond this viewport; this pair does not demonstrate every registered command or shortcut.",
  ],
  "system-status": [
    "Connection and system status",
    "Both open the actual System status dialog. Old launches from the header status badge; new launches from contextual project status.",
  ],
};
const escape = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
const assets = relative(dirname(documentPath), root).replaceAll("\\", "/");
const states = Object.keys(descriptions).filter((state) =>
  manifest.captures.some((item) => item.state === state),
);
const imageHashes: Record<string, string> = {};
for (const item of manifest.captures) {
  const buffer = readFileSync(join(root, item.file));
  if (buffer.readUInt32BE(16) !== 1920 || buffer.readUInt32BE(20) !== 1080)
    throw new Error(`Incorrect resolution: ${item.file}`);
  imageHashes[item.file] = createHash("sha256").update(buffer).digest("hex");
}
const oldCommit = manifest.versions.find((item) => item.version === "old")!.commit;
const newCommit = manifest.versions.find((item) => item.version === "new")!.commit;
const intro = `---
title: Old and new Nanasa portal comparison
description: Full HD screenshots of actual old and proposed portals using matching isolated three-team daemon fixtures
ms.date: 2026-09-07
---

## Review scope

The new UI/UX is not accepted. These captures provide evidence for comparison,
not approval to merge or release it. No application code was changed for the
comparison. The operator authorized committing and pushing this review material
to the feature branch; that authorization does not accept the UI/UX.

| Version | Ref | Pinned commit |
| --- | --- | --- |
| Old | Freshly fetched origin/main | \`${oldCommit}\` |
| New | feat/portal-entity-design | \`${newCommit}\` |

Open the [side-by-side HTML gallery](${assets}/index.html) for a wider view.
Every image below links to its original **1920 x 1080** PNG. Each screenshot is
a viewport capture at device scale factor 1 and 100% zoom, not a cropped or
stitched mock. Capture timestamp: ${manifest.capturedAt}.

## Matching fixture

| Team | Members | Runtime | Workspace |
| --- | --- | --- | --- |
| Backend Team | Backend Manager, Backend Engineer, Backend Reviewer | Three running fixture agents | main |
| Frontend Team | Frontend Manager, Frontend Engineer, Frontend Reviewer | Three running fixture agents | feature/frontend |
| Platform Team | Platform Manager, Platform Engineer, Platform Reviewer | Configured, not started | main |

Both versions ran from separate detached source/build worktrees under /tmp and
separate runtime repositories, databases, ports, and tmux servers. The same
deterministic team/member IDs, role glyphs, instructions, workspace binding,
three delivered messages, and managed browser request were seeded through config
and real daemon APIs. There are no mocked browser responses or simulated UI widgets.

Agents use the safe-echo integration with the OpenCode adapter, not real AI
providers. Reviewer identity uses inherited permissions because a custom echo
launcher cannot enforce a read-only provider policy. Semantic status may be
Unknown because the fixture has no real AI reporter; Unknown is not a failed
launch. We did not fabricate Working, Done, approval, or provider-error states.

## Capture controls and limitations

* Main screens use both persisted dark and light themes; task interactions use
  dark mode. Full HD viewport, locale en-GB, and timezone UTC are fixed.
* Font loading, authenticated snapshots, terminal connections, and delivered
  message outcomes were awaited. The same setup advisory was dismissed through
  the actual UI before main captures. No content was hidden with injected CSS.
* Equivalent selections are used where available. Task-level differences and
  new-only views are named explicitly rather than made to look identical.
* Temporary paths, timestamps, process/run IDs, and revision digests differ
  naturally between independent daemons. No credential files or bootstrap URLs
  are included in the screenshots or manifest.
* No destructive confirmation or provider lifecycle action was applied. The
  invalid workspace request is an intentional real validation failure.
* Full HD does not show every scrolled region at once. The separate task captures
  expose important controls; these are not exhaustive keyboard, accessibility,
  mobile, real-provider, or failure-state certifications.
* The capture manifest records ${manifest.captures.length} screenshots,
  ${manifest.gaps.length} workflow capture gaps, and ${manifest.browserErrors.length}
  browser JavaScript errors. Asset dimensions and SHA-256 hashes are recorded in
  [image audit](${assets}/image-audit.json).

## Evidence review

Two read-only reviewers inspected the initial 120 captures through contact sheets
and reopened key originals at full resolution. They identified transient terminal
backgrounds and below-fold action coverage, not wrong entities or themes. The
runner was tightened to wait for every visible terminal's connection and output;
all images were regenerated, and eight lower-scroll captures were added. Original
first-view images remain alongside these supplemental views.

A targeted follow-up review checked all eight supplemental originals and the
previously unsettled menu/palette backgrounds. The missing controls and checkpoint
empty states are now visible. The new plan-approval button still has low-contrast
text near the bottom edge of its scrolled view; this is retained as real UI
evidence, not corrected or hidden for the comparison. Lower command-palette
entries and upper content outside a scrolled viewport remain explicit limitations.

The comparison exposes one reproducible shared issue: workspace validation
feedback appears behind the open dialog. It is recorded separately as OPEN-002 in
[the functional bug ledger](portal-functional-bugs.md); the pinned old/new product
sources were not altered to conceal it. No UI/UX acceptance is implied by review.

## Validation and cleanup

All 128 original PNGs are 1920 x 1080. The offline HTML gallery was opened in
local Playwright Chromium: every image decoded, every section link resolved, and
the gallery had no horizontal overflow at Full HD. Capture scripts passed ESLint;
documentation and local image links were checked. No product test suite is claimed
to have run as part of this documentation task.

Both temporary daemons and their runtime repositories were closed by the harness.
The two detached source/build worktrees and task logs were removed after review;
no comparison tmux processes remained. The current feature branch and the existing
operator frontend worktree were left in place. Screenshots, manifest, image hashes,
contact sheets, and reproduction scripts are retained together as feature-branch
review material, separately from any decision to accept or release the redesign.

## Screens and workflows
`;
let markdown = intro;
let html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Nanasa old vs new portal</title><style>body{margin:0;background:#f4f6f5;color:#1b2922;font:15px/1.5 sans-serif}header,section,nav{padding:22px 28px}header{background:#fff;border-bottom:1px solid #c9d2cc}h1{font-size:26px;margin:0}h2{font-size:20px}p{max-width:1100px}nav{display:flex;flex-wrap:wrap;gap:8px 20px;border-bottom:1px solid #c9d2cc}a{color:#186448}section{border-bottom:1px solid #c9d2cc}.pair{display:grid;grid-template-columns:1fr 1fr;gap:16px}figure{margin:0;min-width:0}img{display:block;width:100%;height:auto;background:#e3e8e5}figcaption{padding:7px 0;font-size:13px}code{overflow-wrap:anywhere}@media(max-width:900px){.pair{grid-template-columns:1fr}}.notice{font-weight:600;color:#704900}</style></head><body><header><h1>Nanasa portal: old vs new</h1><p class="notice">Proposed UI/UX, acceptance pending. Actual isolated daemons, not mock screens.</p><p>Old ${oldCommit.slice(0, 7)} / New ${newCommit.slice(0, 7)}. Three teams, nine agents. Original images: 1920 x 1080, DPR 1. Main screens in both themes; interactions in dark mode.</p><p>Six safe-echo agents running, three configured but stopped. Paths, timestamps and runtime identifiers differ. Click an image for full resolution. See the Markdown comparison for fixture details and limitations.</p></header><nav>${states.map((state) => `<a href="#${state}">${escape(descriptions[state]![0])}</a>`).join("")}</nav>`;
for (const state of states) {
  const [title, note] = descriptions[state]!;
  markdown += `\n### ${title}\n\n${note}\n`;
  html += `<section id="${state}"><h2>${escape(title)}</h2><p>${escape(note)}</p>`;
  for (const theme of ["dark", "light"]) {
    const pair = ["old", "new"].map((version) =>
      manifest.captures.find(
        (item) => item.version === version && item.state === state && item.theme === theme,
      ),
    );
    if (pair.every((item) => !item)) continue;
    markdown += `\n| Old (${theme}) | New (${theme}) |\n| --- | --- |\n| ${pair.map((item, index) => (item ? `[![${index === 0 ? "Old" : "New"} ${title}, ${theme}](${assets}/${item.file})](${assets}/${item.file})` : "No direct equivalent")).join(" | ")} |\n`;
    html += `<h3>${theme[0]!.toUpperCase() + theme.slice(1)}</h3><div class="pair">${pair.map((item, index) => `<figure><figcaption>${index === 0 ? "Old" : "New"} / ${theme}</figcaption>${item ? `<a href="${item.file}"><img loading="lazy" src="${item.file}" alt="${escape(title)}: ${index === 0 ? "old" : "new"}, ${theme}"></a>` : "<p>No direct equivalent.</p>"}</figure>`).join("")}</div>`;
  }
  html += "</section>";
}
markdown += `\n## Reproduction\n\nSource scripts: [capture runner](../scripts/capture-portal-comparison.ts) and\n[workflow definitions](../scripts/portal-comparison-workflows.ts). Build separate\ndetached worktrees at the SHAs above. Follow [AGENTS.md](../AGENTS.md) before any\npackage command; preserve the registry environment and do not print secrets.\n\n\`\`\`bash\nnode --import tsx scripts/capture-portal-comparison.ts /tmp/old-source /tmp/new-source docs/assets/portal-comparison\nnode --import tsx scripts/render-portal-comparison.ts\n\`\`\`\n\nThe runner uses each source worktree's real PackageAcceptanceService, closes its\nbrowser context and daemon, and removes its temporary runtime repository in\nfinally blocks. Source/build worktrees are removed separately after image review.\nThe current checkout and operator sessions are not used as comparison fixtures.\n`;
writeFileSync(documentPath, markdown);
writeFileSync(join(root, "index.html"), html + "</body></html>\n");
writeFileSync(
  join(root, "image-audit.json"),
  JSON.stringify(
    {
      viewport: manifest.viewport,
      deviceScaleFactor: manifest.deviceScaleFactor,
      count: manifest.captures.length,
      sha256: imageHashes,
    },
    null,
    2,
  ) + "\n",
);
const sheets = join(root, "review");
mkdirSync(sheets, { recursive: true });
const ordered = states.flatMap((state) =>
  ["dark", "light"].flatMap((theme) =>
    ["old", "new"].flatMap((version) =>
      manifest.captures.filter(
        (item) => item.state === state && item.theme === theme && item.version === version,
      ),
    ),
  ),
);
for (let index = 0; index < ordered.length; index += 6) {
  execFileSync("montage", [
    "-font",
    "DejaVu-Sans",
    "-pointsize",
    "15",
    "-label",
    "%f",
    ...ordered.slice(index, index + 6).map((item) => join(root, item.file)),
    "-thumbnail",
    "640x360",
    "-tile",
    "2x3",
    "-geometry",
    "640x390+8+8",
    "-background",
    "#e8ece9",
    join(sheets, `sheet-${String(index / 6 + 1).padStart(2, "0")}.jpg`),
  ]);
}
console.log(
  `Rendered ${manifest.captures.length} images across ${states.length} workflows into ${documentPath}`,
);
