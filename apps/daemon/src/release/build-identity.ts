import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { BuildIdentitySchema, type BuildIdentity } from "@nanasa/contracts";

export function loadBuildIdentity(packageRoot: string): BuildIdentity {
  return BuildIdentitySchema.parse(
    JSON.parse(readFileSync(join(resolve(packageRoot), "dist", "meta", "build.json"), "utf8")),
  );
}
