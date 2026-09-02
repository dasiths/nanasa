import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const docsRoot = join(root, "docs", "next");
const required = [
  join(root, "README.md"),
  join(root, "apps", "portal", "README.md"),
  join(docsRoot, "index.md"),
];
const errors = [];

function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? files(path) : [path];
  });
}

function contentOutsideFences(source) {
  let fence;
  return source
    .split(/\r?\n/)
    .filter((line) => {
      const marker = line.match(/^\s*(`{3,}|~{3,})/u)?.[1];
      if (marker === undefined) return fence === undefined;
      if (fence === undefined) fence = marker[0];
      else if (marker[0] === fence) fence = undefined;
      return false;
    })
    .join("\n");
}

function localLinkTarget(rawTarget) {
  const target =
    rawTarget.startsWith("<") && rawTarget.endsWith(">") ? rawTarget.slice(1, -1) : rawTarget;
  if (
    target.startsWith("#") ||
    target.startsWith("/") ||
    target.startsWith("//") ||
    /^[a-z][a-z\d+.-]*:/iu.test(target)
  ) {
    return undefined;
  }
  return target.split(/[?#]/u, 1)[0];
}

for (const path of required) {
  if (!existsSync(path)) errors.push(`missing required page ${relative(root, path)}`);
}

const documentationPaths = existsSync(docsRoot)
  ? [
      join(root, "README.md"),
      join(root, "apps", "portal", "README.md"),
      ...files(docsRoot).filter((item) => extname(item) === ".md"),
    ]
  : [join(root, "README.md"), join(root, "apps", "portal", "README.md")];

for (const path of documentationPaths.filter((item) => existsSync(item))) {
  const source = readFileSync(path, "utf8");
  const label = relative(root, path);
  const markdown = contentOutsideFences(source.replace(/^\uFEFF/u, ""));
  if (/^---\s*$/u.test(markdown.split("\n", 1)[0]))
    errors.push(`${label}: YAML frontmatter is forbidden`);
  const h1Headings = [...markdown.matchAll(/^#\s+(.+)$/gmu)];
  if (h1Headings.length !== 1)
    errors.push(`${label}: expected exactly one H1, found ${h1Headings.length}`);
  if (/—/.test(source)) errors.push(`${label}: em dash is forbidden`);
  const headings = [...markdown.matchAll(/^#{2,6}\s+(.+)$/gmu)].map((match) =>
    match[1]
      .replace(/\s+#+\s*$/u, "")
      .trim()
      .toLowerCase(),
  );
  const duplicates = headings.filter((heading, index) => headings.indexOf(heading) !== index);
  if (duplicates.length > 0) errors.push(`${label}: duplicate heading ${duplicates[0]}`);
  for (const match of markdown.matchAll(/!?\[[^\]]*\]\((<?[^\s)>]+>?)(?:\s+[^)]*)?\)/gu)) {
    const target = match[1];
    const file = localLinkTarget(target);
    if (file === undefined || file.length === 0) continue;
    let decoded;
    try {
      decoded = decodeURIComponent(file);
    } catch {
      errors.push(`${label}: invalid link ${target}`);
      continue;
    }
    if (!existsSync(resolve(dirname(path), decoded)))
      errors.push(`${label}: broken link ${target}`);
  }
}

if (errors.length > 0) throw new Error(`Documentation validation failed:\n${errors.join("\n")}`);
console.log(`Verified ${documentationPaths.length} public documentation pages and local links`);
