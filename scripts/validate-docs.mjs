import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const docsRoot = join(root, "docs", "next");
const required = [
  "index.md",
  "installation.md",
  "concepts.md",
  "continuity.md",
  "providers.md",
  "state-and-models.md",
  "configuration.md",
  "cli.md",
  "api-events-terminal-mcp.md",
  "git-worktrees.md",
  "extensions.md",
  "remote.md",
  "security.md",
  "troubleshooting.md",
  "accessibility.md",
  "testing.md",
  "support.md",
  "contributing.md",
  "release.md",
];
const errors = [];

function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? files(path) : [path];
  });
}

for (const requiredPath of required) {
  if (!existsSync(join(docsRoot, requiredPath)))
    errors.push(`missing required page ${requiredPath}`);
}

for (const path of files(docsRoot).filter((item) => extname(item) === ".md")) {
  const source = readFileSync(path, "utf8");
  const label = relative(root, path);
  if (!source.startsWith("---\n")) errors.push(`${label}: missing YAML frontmatter`);
  const frontmatterEnd = source.indexOf("\n---\n", 4);
  if (frontmatterEnd < 0) errors.push(`${label}: unterminated YAML frontmatter`);
  const frontmatter = frontmatterEnd < 0 ? "" : source.slice(4, frontmatterEnd);
  if (!/^title:\s+.+$/m.test(frontmatter)) errors.push(`${label}: missing title`);
  if (!/^description:\s+.+$/m.test(frontmatter)) errors.push(`${label}: missing description`);
  if (/^#\s+/m.test(source.slice(frontmatterEnd + 5)))
    errors.push(`${label}: H1 is forbidden with title frontmatter`);
  if (/—/.test(source)) errors.push(`${label}: em dash is forbidden`);
  const headings = [...source.matchAll(/^#{2,6}\s+(.+)$/gm)].map((match) =>
    match[1].trim().toLowerCase(),
  );
  const duplicates = headings.filter((heading, index) => headings.indexOf(heading) !== index);
  if (duplicates.length > 0) errors.push(`${label}: duplicate heading ${duplicates[0]}`);
  for (const match of source.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
    const target = match[1];
    if (target.startsWith("http:") || target.startsWith("https:") || target.startsWith("#"))
      continue;
    const [file] = target.split("#", 1);
    if (file.length === 0) continue;
    const decoded = decodeURIComponent(file);
    if (!existsSync(resolve(dirname(path), decoded)))
      errors.push(`${label}: broken link ${target}`);
  }
}

if (errors.length > 0) throw new Error(`Documentation validation failed:\n${errors.join("\n")}`);
console.log(
  `Verified ${files(docsRoot).filter((item) => extname(item) === ".md").length} documentation pages and local links`,
);
