import type { ExperimentComputeAdapter } from "./types.js";

/** Explicit registry: the compiler chooses a backend ID, never provider internals. */
export class ComputeAdapterRegistry {
  private readonly adapters = new Map<string, ExperimentComputeAdapter>();

  register(adapter: ExperimentComputeAdapter): void {
    if (this.adapters.has(adapter.id)) throw new Error(`compute adapter already registered: ${adapter.id}`);
    this.adapters.set(adapter.id, adapter);
  }

  resolve(id: string): ExperimentComputeAdapter {
    const adapter = this.adapters.get(id);
    if (!adapter) throw new Error(`unknown compute adapter ${id}; registered: ${[...this.adapters.keys()].sort().join(", ") || "none"}`);
    return adapter;
  }

  ids(): string[] { return [...this.adapters.keys()].sort(); }
}
