import type { Checkout, GitStatusProjection, Repository } from "@nanasa/contracts";
import type { NanasaStore } from "../store.js";
import { GitStatusService } from "./git-status-service.js";
import { RepositoryDiscoveryService } from "./repository-discovery-service.js";

export class CheckoutService {
  public constructor(
    private readonly store: NanasaStore,
    private readonly discovery: RepositoryDiscoveryService,
    private readonly statuses: GitStatusService,
  ) {}

  public async discover(path: string, makePrimary = false): Promise<Checkout> {
    const discovered = await this.discovery.discover(path);
    const status = await this.statuses.inspect(discovered.checkout);
    const checkout: Checkout = {
      ...discovered.checkout,
      ...(status.head === undefined ? {} : { head: status.head }),
      ...(status.branch === undefined ? {} : { branch: status.branch }),
      dirty: status.staged + status.modified + status.untracked > 0,
      observedAt: status.observedAt,
    };
    return this.store.saveDiscoveredCheckout(discovered.repository, checkout, makePrimary).checkout;
  }

  public async initialize(path: string): Promise<{ repository: Repository; checkout: Checkout }> {
    const checkout = await this.discover(path, true);
    return { repository: this.store.getRepository(checkout.repositoryId), checkout };
  }

  public async refresh(checkoutId: string): Promise<GitStatusProjection> {
    const current = this.store.getCheckout(checkoutId);
    const discovered = await this.discovery.discover(current.path);
    if (
      discovered.repository.id !== current.repositoryId ||
      discovered.checkout.id !== current.id ||
      discovered.checkout.path !== current.path
    ) {
      throw new Error("Checkout identity changed during Git status refresh");
    }
    const status = await this.statuses.inspect(discovered.checkout);
    this.store.saveDiscoveredCheckout(discovered.repository, {
      ...discovered.checkout,
      ...(status.head === undefined ? {} : { head: status.head }),
      ...(status.branch === undefined ? {} : { branch: status.branch }),
      dirty: status.staged + status.modified + status.untracked > 0,
      observedAt: status.observedAt,
    });
    return status;
  }

  public list(repositoryId?: string): Checkout[] {
    return this.store.listCheckouts(repositoryId);
  }
}
