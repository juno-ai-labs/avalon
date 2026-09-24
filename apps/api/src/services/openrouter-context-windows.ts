import { z } from "zod";

const CATALOG_URL = "https://openrouter.ai/api/v1/models";
const CACHE_KEY = "openrouter:context-windows:v1";
const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;

const SnapshotSchema = z.object({
  version: z.literal(1),
  fetchedAtMs: z.number().int().nonnegative(),
  windows: z.record(z.string(), z.number().int().positive()),
});

type ContextWindowCache = { INFERENCE_PRICING_CACHE: KVNamespace };

/** One best-effort KV read; the owning Durable Object retains its result in memory. */
export async function loadOpenRouterContextWindows(
  env: ContextWindowCache,
): Promise<Readonly<Record<string, number>>> {
  const value = await env.INFERENCE_PRICING_CACHE.get(CACHE_KEY, "json");
  return SnapshotSchema.safeParse(value).data?.windows ?? {};
}

/** The hourly metadata tick seeds a missing snapshot and refreshes it once per day. */
export async function refreshOpenRouterContextWindowsIfDue(
  env: ContextWindowCache,
  options: { fetch?: typeof globalThis.fetch; now?: () => number } = {},
): Promise<void> {
  const now = (options.now ?? Date.now)();
  const current = SnapshotSchema.safeParse(await env.INFERENCE_PRICING_CACHE.get(CACHE_KEY, "json"));
  if (current.success && Object.keys(current.data.windows).length > 0
    && now - current.data.fetchedAtMs < REFRESH_INTERVAL_MS) return;
  await refreshOpenRouterContextWindows(env, options);
}

/** A failed refresh retains the last snapshot. */
export async function refreshOpenRouterContextWindows(
  env: ContextWindowCache,
  options: { fetch?: typeof globalThis.fetch; now?: () => number } = {},
): Promise<void> {
  const response = await (options.fetch ?? globalThis.fetch)(CATALOG_URL, {
    headers: { accept: "application/json" },
  });
  if (!response.ok) throw new Error(`OpenRouter model catalog failed (${response.status})`);
  const envelope = z.object({ data: z.array(z.unknown()) }).parse(await response.json());
  const windows: Record<string, number> = {};
  const entrySchema = z.looseObject({
    id: z.string().min(1),
    context_length: z.number().nullish(),
    top_provider: z.looseObject({ context_length: z.number().nullish() }).nullish(),
  });
  for (const entry of envelope.data) {
    const parsed = entrySchema.safeParse(entry);
    if (!parsed.success) continue;
    const value = parsed.data.context_length ?? parsed.data.top_provider?.context_length;
    if (value && Number.isFinite(value) && Math.floor(value) > 0) {
      windows[parsed.data.id] = Math.floor(value);
    }
  }
  if (Object.keys(windows).length === 0) throw new Error("OpenRouter model catalog contains no context windows");
  const snapshot = SnapshotSchema.parse({
    version: 1,
    fetchedAtMs: (options.now ?? Date.now)(),
    windows,
  });
  await env.INFERENCE_PRICING_CACHE.put(CACHE_KEY, JSON.stringify(snapshot));
}
