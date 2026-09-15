import { sha256 } from "../lib/crypto";

/** One reusable computation, with rejection observed even before a consumer awaits it. */
export class Preparation<T> {
  private promise: Promise<T> | null = null;

  constructor(private readonly load: () => Promise<T>) {}

  get(): Promise<T> {
    if (this.promise) return this.promise;
    const attempt = Promise.resolve().then(this.load);
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
