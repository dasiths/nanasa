import { createRequire } from "node:module";
import {
  piMcpAdapterAssetDigest,
  type TrustedBuiltInProviderPackage,
} from "./builtin-provider-packages.js";
import type { ProviderSnapshotEvaluatorOptions } from "./provider-snapshot-evaluator.js";

const moduleRequire = createRequire(import.meta.url);

export function resolveBuiltInProviderEvaluatorOptions(
  packages: readonly TrustedBuiltInProviderPackage[],
  resolvePackage: (packageName: string) => string = (packageName) =>
    moduleRequire.resolve(packageName),
): ProviderSnapshotEvaluatorOptions {
  const piPackage = packages.find(
    (providerPackage) => providerPackage.snapshot.body.providerId === "pi",
  );
  if (piPackage === undefined) throw new Error("Built-in Pi provider package is missing");
  return Object.freeze({
    runtimeAssetPaths: Object.freeze({
      [piMcpAdapterAssetDigest(piPackage)]: resolvePackage("pi-mcp-adapter"),
    }),
  });
}
