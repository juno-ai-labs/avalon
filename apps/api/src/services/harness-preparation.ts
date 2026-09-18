import { sha256 } from "../lib/crypto";

/** One reusable computation, with rejection observed even before a consumer awaits it. */
export class Preparation<T> {
  private promise: Promise<T> | null = null;
  private settledElapsedMs: number | null = null;

  constructor(private readonly load: () => Promise<T>) {}

  /** I/O-visible elapsed time for the current settled attempt; null until it settles. */
  get elapsedMs(): number | null {
    return this.settledElapsedMs;
  }

  get(): Promise<T> {
    if (this.promise) return this.promise;
    this.settledElapsedMs = null;
    const attempt = Promise.resolve().then(async () => {
      const startedAtMs = Date.now();
      try {
        return await this.load();
      } finally {
        this.settledElapsedMs = Date.now() - startedAtMs;
      }
    });
    this.promise = attempt;
    void attempt.catch(() => {
      if (this.promise === attempt) this.promise = null;
    });
    return attempt;
  }
}

/** Only built-in plugin IDs belong here; retain their latest metadata variant. */
export class ToolSurfacePreparations {
  private readonly surfaces = new Map<string, { json: string; hash: Preparation<string> }>();

  get(pluginId: string, json: string): Promise<string> {
    let entry = this.surfaces.get(pluginId);
    if (!entry || entry.json !== json) {
      entry = { json, hash: new Preparation(() => sha256(json)) };
      this.surfaces.set(pluginId, entry);
    }
    return entry.hash.get();
  }
}
