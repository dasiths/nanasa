import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

import {
  type CustomLaunchConsentLauncherFile,
  type CustomLaunchConsentSubject,
  CustomLaunchConsentSubjectSchema,
  canonicalJson,
} from "@nanasa/contracts";

const SET_LIKE_SUBJECT_PATHS = ["/environmentNames", "/launcherFiles"] as const;

export interface RepositoryLauncherFilesInput {
  readonly repositoryRoot: string;
  readonly workingDirectory?: string;
  readonly configuredCommand: readonly string[];
}

function isInside(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

function repositoryPath(root: string, candidate: string): string {
  return relative(root, candidate).split(sep).join("/");
}

function digestRepositoryFile(
  root: string,
  candidate: string,
): CustomLaunchConsentLauncherFile | undefined {
  let status;
  try {
    status = lstatSync(candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (status.isSymbolicLink()) {
    throw new Error(
      `Repository launcher file may not be a symbolic link: ${repositoryPath(root, candidate)}`,
    );
  }
  if (!status.isFile()) return undefined;
  if (typeof process.getuid === "function" && status.uid !== process.getuid()) {
    throw new Error(
      `Repository launcher file must be owned by the current user: ${repositoryPath(root, candidate)}`,
    );
  }

  const realCandidate = realpathSync(candidate);
  if (!isInside(root, realCandidate)) {
    throw new Error(
      `Repository launcher file must remain beneath the repository root: ${candidate}`,
    );
  }

  const descriptor = openSync(candidate, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.dev !== status.dev || opened.ino !== status.ino) {
      throw new Error(
        `Repository launcher file changed while being inspected: ${repositoryPath(root, realCandidate)}`,
      );
    }
    if (typeof process.getuid === "function" && opened.uid !== process.getuid()) {
      throw new Error(
        `Repository launcher file must be owned by the current user: ${repositoryPath(root, realCandidate)}`,
      );
    }
    return {
      path: repositoryPath(root, realCandidate),
      digest: createHash("sha256").update(readFileSync(descriptor)).digest("hex"),
    };
  } finally {
    closeSync(descriptor);
  }
}

export function repositoryLauncherFiles(
  input: RepositoryLauncherFilesInput,
): CustomLaunchConsentLauncherFile[] {
  const root = realpathSync(resolve(input.repositoryRoot));
  const workingDirectory = realpathSync(resolve(input.workingDirectory ?? root));
  if (!isInside(root, workingDirectory)) {
    throw new Error("Launcher working directory must remain beneath the repository root");
  }

  const files = new Map<string, CustomLaunchConsentLauncherFile>();
  for (const argument of input.configuredCommand) {
    const candidate = resolve(workingDirectory, argument);
    if (!isInside(root, candidate)) continue;
    const file = digestRepositoryFile(root, candidate);
    if (file !== undefined) files.set(file.path, file);
  }
  return [...files.values()].sort((left, right) => left.path.localeCompare(right.path));
}

export function customLaunchConsentSubjectDigest(subject: CustomLaunchConsentSubject): string {
  const parsed = CustomLaunchConsentSubjectSchema.parse(subject);
  const bytes = canonicalJson(parsed, { setLikePaths: SET_LIKE_SUBJECT_PATHS });
  return createHash("sha256").update(bytes).digest("hex");
}
