import type { AgentKind } from "@nanasa/contracts";
import { ClaudeCodeAdapter } from "./claude-code-adapter.js";
import { CopilotAdapter } from "./copilot-adapter.js";
import { OpenCodeAdapter } from "./opencode-adapter.js";
import { PiAdapter } from "./pi-adapter.js";
import type { ProviderAdapter } from "./provider-adapter.js";

export class ProviderAdapterRegistry {
  readonly #adapters: ReadonlyMap<AgentKind, ProviderAdapter>;

  public constructor(adapters: readonly ProviderAdapter[]) {
    const indexed = new Map<AgentKind, ProviderAdapter>();
    for (const adapter of adapters) {
      if (indexed.has(adapter.id)) throw new Error(`Duplicate provider adapter ${adapter.id}`);
      indexed.set(adapter.id, adapter);
    }
    this.#adapters = indexed;
  }

  public get(kind: AgentKind): ProviderAdapter {
    const adapter = this.#adapters.get(kind);
    if (adapter === undefined) throw new Error(`Provider adapter is unavailable: ${kind}`);
    return adapter;
  }

  public list(): readonly ProviderAdapter[] {
    return Object.freeze([...this.#adapters.values()]);
  }

  public static builtIn(options: { piMcpAdapterPath?: string } = {}): ProviderAdapterRegistry {
    return new ProviderAdapterRegistry([
      new CopilotAdapter(),
      new ClaudeCodeAdapter(),
      new PiAdapter(options.piMcpAdapterPath),
      new OpenCodeAdapter(),
    ]);
  }
}
