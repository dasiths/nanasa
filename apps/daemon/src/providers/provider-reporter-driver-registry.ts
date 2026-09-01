import type {
  ProviderAssetRegistry,
  ResolvedProviderAdapter,
} from "./resolved-provider-adapter.js";

export interface ProviderReporterDriver {
  readonly driverId: string;
  readonly protocolMajor: number;
  readonly sourceId: string;
  readonly reporterVersion: string;
  readonly sourceAssetDigest: string;
}

export class ProviderReporterDriverRegistry {
  readonly #drivers: ReadonlyMap<string, ProviderReporterDriver>;
  readonly #assets: ProviderAssetRegistry;

  public constructor(assets: ProviderAssetRegistry, drivers: readonly ProviderReporterDriver[]) {
    const indexed = new Map<string, ProviderReporterDriver>();
    for (const driver of drivers) {
      if (indexed.has(driver.driverId)) {
        throw new Error(`Duplicate provider reporter driver ${driver.driverId}`);
      }
      const source = assets.get(driver.sourceAssetDigest);
      if (source.kind !== "literal" || typeof source.payload !== "string") {
        throw new Error(`Reporter driver ${driver.driverId} does not reference a literal asset`);
      }
      indexed.set(driver.driverId, Object.freeze({ ...driver }));
    }
    this.#assets = assets;
    this.#drivers = indexed;
  }

  public static fromSnapshot(adapter: ResolvedProviderAdapter): ProviderReporterDriverRegistry {
    const capability = adapter.body.capabilities.find((item) => item.id === "reporter");
    if (capability === undefined) throw new Error("Provider snapshot has no reporter capability");
    const reporter = capability.payload as ProviderReporterDriver;
    return new ProviderReporterDriverRegistry(adapter.assets, [
      {
        driverId: reporter.driverId,
        protocolMajor: reporter.protocolMajor,
        sourceId: reporter.sourceId,
        reporterVersion: reporter.reporterVersion,
        sourceAssetDigest: reporter.sourceAssetDigest,
      },
    ]);
  }

  public get(driverId: string): ProviderReporterDriver {
    const driver = this.#drivers.get(driverId);
    if (driver === undefined)
      throw new Error(`Provider reporter driver is unavailable: ${driverId}`);
    return driver;
  }

  public source(driverId: string): string {
    const asset = this.#assets.get(this.get(driverId).sourceAssetDigest);
    if (typeof asset.payload !== "string") throw new Error("Reporter source asset is malformed");
    return asset.payload;
  }
}
