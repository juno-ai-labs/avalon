import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

interface SignalConfig {
  enabled?: boolean;
  head_sampling_rate?: number;
  destinations?: string[];
  persist?: boolean;
}

/**
 * `destinations` and `persist` are signal-scoped in Wrangler's schema — there is
 * no `observability.destinations`. They are declared at the top level here
 * anyway, as `unknown`, so the "EU names no destination" assertion can check a
 * misplaced key rather than being unable to express it.
 */
interface ObservabilityConfig {
  enabled?: boolean;
  head_sampling_rate?: number;
  logs?: SignalConfig;
  traces?: SignalConfig;
  destinations?: unknown;
  persist?: unknown;
}

interface WorkerConfig {
  observability?: ObservabilityConfig;
}

function config(fileName: string): WorkerConfig {
  const raw = readFileSync(new URL(`../${fileName}`, import.meta.url), 'utf8');
  return JSON.parse(raw.replace(/^\s*\/\/.*$/gmu, '')) as WorkerConfig;
}

/**
 * An OTLP destination is account configuration, but the opt-in is not: these
 * two files decide which Worker sends telemetry out of Cloudflare, and the EU
 * Worker's abstention is the whole of what keeps EU telemetry in the EU.
 *
 * That abstention is otherwise held up by a comment, which is exactly the kind
 * of thing a later edit removes without noticing. `docs/telemetry.md` records
 * the decision that Global exports and EU does not; this is that decision as a
 * check.
 */
describe('regional telemetry export', () => {
  it('sends Global logs and traces to the PostHog destinations', () => {
    const observability = config('wrangler.global.jsonc').observability;

    expect(observability?.logs?.destinations).toEqual(['posthog-logs']);
    expect(observability?.traces?.destinations).toEqual(['posthog-traces']);
    // Naming a destination while the signal is off would export nothing, and
    // would do it silently — the config would still read as though it did.
    expect(observability?.enabled).toBe(true);
    expect(observability?.logs?.enabled).toBe(true);
    expect(observability?.traces?.enabled).toBe(true);
  });

  it('keeps the Cloudflare copy rather than redirecting to the destination', () => {
    const observability = config('wrangler.global.jsonc').observability;

    // `persist: false` would export *instead of* storing in Cloudflare, leaving
    // the third party holding the only copy. Absent means the default, true.
    expect(observability?.logs?.persist).toBeUndefined();
    expect(observability?.traces?.persist).toBeUndefined();
  });

  it('names no destination for the EU Worker, in either signal', () => {
    const observability = config('wrangler.eu.jsonc').observability;

    // Both are asserted, not just the one that exists today: adding a `logs`
    // block to the EU config with a destination in it is the failure this
    // guards against, and it would pass a check that only looked at `traces`.
    expect(observability?.logs?.destinations).toBeUndefined();
    expect(observability?.traces?.destinations).toBeUndefined();
    expect(observability?.destinations).toBeUndefined();
  });

  it('still collects EU telemetry — the abstention is about export, not observability', () => {
    const observability = config('wrangler.eu.jsonc').observability;

    // The EU Worker is fully observable inside its own region; what it does not
    // do is ship any of it to a US project. A change that disabled EU
    // observability to satisfy the rule above would pass the wrong test.
    expect(observability?.enabled).toBe(true);
    expect(observability?.traces?.enabled).toBe(true);
  });
});
