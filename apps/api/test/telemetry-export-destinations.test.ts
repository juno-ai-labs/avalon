import "../../../tests/isolated-region";
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
 * anyway, as `unknown`, so the "enterprise names no destination" assertion can check a
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
 * two files decide which Worker sends telemetry out of Cloudflare, and the enterprise
 * Worker's abstention is the whole of what keeps enterprise telemetry in the enterprise.
 *
 * That abstention is otherwise held up by a comment, which is exactly the kind
 * of thing a later edit removes without noticing. `docs/telemetry.md` records
 * the decision that Global exports and enterprise does not; this is that decision as a
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



});
