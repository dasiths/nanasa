import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { z } from "zod";

const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_MANIFEST_FILES = 256;

const ProcessIdentitySchema = z
  .object({
    startTimeTicks: z.string().regex(/^\d+$/),
    executablePath: z.string().min(1),
    executableDevice: z.string().regex(/^\d+$/),
    executableInode: z.string().regex(/^\d+$/),
    uid: z.number().int().nonnegative(),
    argv: z.array(z.string()).min(1).max(256),
  })
  .strict();

export const TtydProcessManifestSchema = z
  .object({
    version: z.literal(1),
    runId: z.string().min(1),
    runGeneration: z.number().int().positive(),
    endpointKey: z.string().regex(/^[0-9a-f]{32}$/),
    basePath: z.string().regex(/^\/terminals\/[0-9a-f]{32}$/),
    pid: z.number().int().positive(),
    process: ProcessIdentitySchema,
    ttydArgv: z.array(z.string()).min(2).max(256),
    tmux: z
      .object({
        serverName: z.string().min(1),
        viewSessionName: z.string().regex(/^nanasa-view-[0-9a-f]{16}$/),
        bindingFingerprint: z.string().min(1),
      })
      .strict(),
    createdAt: z.string().datetime({ offset: true }),
  })
  .strict();

export type TtydProcessIdentity = z.infer<typeof ProcessIdentitySchema>;
export type TtydProcessManifest = z.infer<typeof TtydProcessManifestSchema>;

export interface TtydProcessInspector {
  inspect(pid: number): Promise<TtydProcessIdentity | undefined>;
}

export interface TtydManifestScanEntry {
  path: string;
  manifest?: TtydProcessManifest;
  rejectionReason?: string;
}

function manifestName(runId: string): string {
  const encoded = Buffer.from(runId, "utf8").toString("base64url");
  if (encoded.length === 0 || encoded.length > 180) {
    throw new Error("ttyd manifest run ID is invalid");
  }
  return `${encoded}.json`;
}

function parseProcStatStartTime(value: string): string {
  const commandEnd = value.lastIndexOf(")");
  if (commandEnd < 0) throw new Error("invalid_proc_stat");
  const fields = value
    .slice(commandEnd + 2)
    .trim()
    .split(/\s+/);
  const startTime = fields[19];
  if (startTime === undefined || !/^\d+$/.test(startTime)) {
    throw new Error("invalid_proc_start_time");
  }
  return startTime;
}

export const linuxProcessInspector: TtydProcessInspector = {
  async inspect(pid) {
    if (!Number.isInteger(pid) || pid < 1) return undefined;
    const procDirectory = `/proc/${pid}`;
    try {
      const [statText, commandLine, executablePath, processStat] = await Promise.all([
        readFile(join(procDirectory, "stat"), "utf8"),
        readFile(join(procDirectory, "cmdline")),
        readlink(join(procDirectory, "exe")),
        stat(procDirectory),
      ]);
      const executableStat = await stat(join(procDirectory, "exe"));
      const argv = commandLine
        .toString("utf8")
        .split("\0")
        .filter((argument, index, all) => argument.length > 0 || index < all.length - 1);
      return ProcessIdentitySchema.parse({
        startTimeTicks: parseProcStatStartTime(statText),
        executablePath,
        executableDevice: String(executableStat.dev),
        executableInode: String(executableStat.ino),
        uid: processStat.uid,
        argv,
      });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ESRCH") return undefined;
      throw error;
    }
  },
};

export function matchesManifestProcess(
  manifest: TtydProcessManifest,
  identity: TtydProcessIdentity | undefined,
): boolean {
  if (identity === undefined) return false;
  return (
    manifest.process.startTimeTicks === identity.startTimeTicks &&
    manifest.process.executablePath === identity.executablePath &&
    manifest.process.executableDevice === identity.executableDevice &&
    manifest.process.executableInode === identity.executableInode &&
    manifest.process.uid === identity.uid &&
    manifest.process.argv.length === identity.argv.length &&
    manifest.process.argv.every((argument, index) => argument === identity.argv[index])
  );
}

export function matchesExpectedTtydArgv(
  launchArgv: readonly string[],
  observedArgv: readonly string[],
): boolean {
  if (
    launchArgv.length === observedArgv.length &&
    launchArgv.every((argument, index) => argument === observedArgv[index])
  ) {
    return true;
  }
  const expectedObserved: string[] = [];
  for (let index = 0; index < launchArgv.length; index += 1) {
    const argument = launchArgv[index]!;
    if (launchArgv[index - 1] === "--client-option" && argument.includes("=")) {
      const separator = argument.indexOf("=");
      expectedObserved.push(argument.slice(0, separator), argument.slice(separator + 1));
    } else {
      expectedObserved.push(argument);
    }
  }
  return (
    expectedObserved.length === observedArgv.length &&
    expectedObserved.every((argument, index) => argument === observedArgv[index])
  );
}

export class TtydManifestStore {
  readonly #directory: string;
  readonly #uid: number | undefined;

  public constructor(directory: string, uid = process.getuid?.()) {
    this.#directory = resolve(directory);
    this.#uid = uid;
  }

  public pathForRun(runId: string): string {
    return join(this.#directory, manifestName(runId));
  }

  public async write(manifest: TtydProcessManifest): Promise<void> {
    const parsed = TtydProcessManifestSchema.parse(manifest);
    await this.#ensureDirectory();
    const target = this.pathForRun(parsed.runId);
    const temporary = join(this.#directory, `.${basename(target)}.${randomUUID()}.tmp`);
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(parsed)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await chmod(temporary, 0o600);
      await rename(temporary, target);
      await this.#syncDirectory();
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  public async remove(runId: string): Promise<void> {
    await unlink(this.pathForRun(runId)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    await this.#syncDirectory();
  }

  public async removeEntry(entry: TtydManifestScanEntry): Promise<void> {
    if (dirname(resolve(entry.path)) !== this.#directory) {
      throw new Error("ttyd manifest path escaped its runtime directory");
    }
    await unlink(entry.path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    await this.#syncDirectory();
  }

  public async scan(): Promise<TtydManifestScanEntry[]> {
    await this.#ensureDirectory();
    const names = (await readdir(this.#directory)).sort();
    const entries: TtydManifestScanEntry[] = [];
    for (const name of names.slice(0, MAX_MANIFEST_FILES)) {
      const path = join(this.#directory, name);
      if (!/^[A-Za-z0-9_-]{1,180}\.json$/.test(name)) {
        entries.push({ path, rejectionReason: "invalid_manifest_name" });
        continue;
      }
      try {
        const metadata = await lstat(path);
        if (metadata.isSymbolicLink()) {
          entries.push({ path, rejectionReason: "manifest_symlink" });
          continue;
        }
        if (!metadata.isFile()) {
          entries.push({ path, rejectionReason: "manifest_not_regular_file" });
          continue;
        }
        if (metadata.size > MAX_MANIFEST_BYTES) {
          entries.push({ path, rejectionReason: "manifest_oversized" });
          continue;
        }
        if ((metadata.mode & 0o777) !== 0o600) {
          entries.push({ path, rejectionReason: "manifest_wrong_mode" });
          continue;
        }
        if (this.#uid !== undefined && metadata.uid !== this.#uid) {
          entries.push({ path, rejectionReason: "manifest_wrong_owner" });
          continue;
        }
        const parsed = TtydProcessManifestSchema.safeParse(
          JSON.parse(await readFile(path, "utf8")),
        );
        if (!parsed.success || this.pathForRun(parsed.data.runId) !== path) {
          entries.push({ path, rejectionReason: "manifest_invalid" });
          continue;
        }
        entries.push({ path, manifest: parsed.data });
      } catch {
        entries.push({ path, rejectionReason: "manifest_unreadable" });
      }
    }
    return entries;
  }

  async #ensureDirectory(): Promise<void> {
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    await chmod(this.#directory, 0o700);
    const canonical = await realpath(this.#directory);
    if (canonical !== this.#directory) {
      throw new Error("ttyd manifest directory must not traverse symlinks");
    }
  }

  async #syncDirectory(): Promise<void> {
    if (process.platform !== "linux") return;
    const handle = await open(this.#directory, "r").catch(() => undefined);
    if (handle === undefined) return;
    try {
      await handle.sync().catch(() => undefined);
    } finally {
      await handle.close();
    }
  }
}
