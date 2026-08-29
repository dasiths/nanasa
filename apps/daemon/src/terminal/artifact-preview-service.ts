import { openSync, closeSync, fstatSync, readSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { DomainError } from "../store.js";

const MAX_PREVIEW_BYTES = 16 * 1024 * 1024;
const mediaTypes = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".txt", "text/plain"],
]);

export class ArtifactPreviewService {
  readonly #root: string;

  public constructor(root: string) {
    this.#root = realpathSync(root);
  }

  public inspect(path: string): {
    path: string;
    absolutePath: string;
    mediaType: string;
    byteCount: number;
  } {
    if (path.includes("\0") || isAbsolute(path))
      throw new DomainError(
        "artifact_path_invalid",
        "Artifact path must be repository-relative",
        400,
      );
    const candidate = resolve(this.#root, path);
    const inside = relative(this.#root, candidate);
    if (inside.startsWith("..") || isAbsolute(inside))
      throw new DomainError("artifact_path_invalid", "Artifact path escaped the repository", 400);
    const absolutePath = realpathSync(candidate);
    if (relative(this.#root, absolutePath).startsWith(".."))
      throw new DomainError(
        "artifact_path_invalid",
        "Artifact symlink escaped the repository",
        400,
      );
    const metadata = statSync(absolutePath);
    if (!metadata.isFile() || metadata.size > MAX_PREVIEW_BYTES)
      throw new DomainError("artifact_preview_unavailable", "Artifact is not previewable", 413);
    const extension = absolutePath.slice(absolutePath.lastIndexOf(".")).toLowerCase();
    const mediaType = mediaTypes.get(extension);
    if (mediaType === undefined)
      throw new DomainError("artifact_type_unsupported", "Artifact type is not previewable", 415);
    this.#validateSignature(absolutePath, mediaType);
    return { path, absolutePath, mediaType, byteCount: metadata.size };
  }

  #validateSignature(path: string, mediaType: string): void {
    if (mediaType === "text/plain") return;
    const descriptor = openSync(path, "r");
    try {
      const bytes = Buffer.alloc(12);
      const length = readSync(descriptor, bytes, 0, bytes.length, 0);
      const actual = bytes.subarray(0, length);
      const valid =
        mediaType === "image/png"
          ? actual
              .subarray(0, 8)
              .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
          : mediaType === "image/jpeg"
            ? actual[0] === 0xff && actual[1] === 0xd8
            : actual.subarray(0, 4).toString("ascii") === "RIFF" &&
              actual.subarray(8, 12).toString("ascii") === "WEBP";
      if (!valid || fstatSync(descriptor).nlink !== 1)
        throw new DomainError("artifact_signature_invalid", "Artifact signature is invalid", 415);
    } finally {
      closeSync(descriptor);
    }
  }
}
