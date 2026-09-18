import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

import { TELEMETRY_EVENTS, telemetryEventRetirement, type TelemetryEventName } from "@rally/contracts/telemetry";

/**
 * Every product event the registry declares the API authoritative for has a
 * producer, or says in the registry why it does not.
 *
 * The registry is a catalogue as well as a schema: a declared event is a claim
 * that the pipeline carries this observation, and a dashboard, a funnel, or an
 * investigation is built on that claim. Four automation contracts lost their
 * producers to the August 2026 durable-lifecycle cutover and nothing noticed
 * for three weeks — the data simply stopped, the declarations stayed, and the
 * gap was found only when somebody tried to answer a question with them. This
 * file is the check that would have caught it the same day.
 *
 * It is deliberately a text scan rather than a runtime assertion. Proving an
 * emitter runs means driving every lifecycle that owns one, which is what the
 * producer's own test does; proving one *exists* only needs the name to appear
 * where an emitter would write it, and that is cheap enough to run on every
 * change.
 */

const SRC = join(__dirname, "..", "src");

/**
 * Modules that read an event name without producing it: the collector, the
 * delivery drain, the destination adapters, the replay path, and the lakehouse
 * projection each dispatch on names they never emit. Listing them keeps a
 * reader from standing in for the producer a contract lost.
 */
const READERS: readonly string[] = [
  "telemetry/collector.ts",
  "telemetry/delivery.ts",
  "telemetry/posthog-adapter.ts",
  "telemetry/replay.ts",
  "services/analytics-lakehouse.ts",
];

/**
 * Declared API product events that really have no producer, each with what is
 * known about the gap. This is a ledger, not an allowlist: the test below also
 * fails when an entry here *gains* a producer, so closing a gap forces the row
 * out and the list can only shrink.
 *
 * None of these is retired — a retirement is recorded in the registry, where
 * the claim is made. These are contracts the product is expected to produce
 * and does not, found while restoring the automation ones and left for a
 * change that can investigate each properly.
 */
const KNOWN_MISSING_PRODUCERS: ReadonlyMap<string, string> = new Map([
  ["connector_activity_ingested", "11,647 production events through 2026-08-19, then nothing; the largest of these gaps."],
  ["human_message_created", "Last produced 2026-08-18."],
  ["workstream_participant_changed", "Last produced 2026-08-18."],
  ["elicitation_resolved", "One production event, 2026-08-25; `elicitation_presented` beside it still has a producer."],
  ["run_action_completed", "No production occurrence has ever been recorded."],
  ["attention_consumed", "No production occurrence has ever been recorded."],
]);

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && path.endsWith(".ts") ? [path] : [];
  });
}

const producerSources = sourceFiles(SRC)
  .filter((path) => !READERS.includes(relative(SRC, path).replaceAll("\\", "/")))
  .map((path) => ({ path: relative(SRC, path), text: readFileSync(path, "utf8") }));

/** Producers spell the name as a bare quoted literal in every form used today. */
function producersFor(name: string): string[] {
  const literal = new RegExp(`(?<![\\w$])['"]${name}['"]`, "u");
  return producerSources.filter(({ text }) => literal.test(text)).map(({ path }) => path);
}

const apiProductEvents = Object.values(TELEMETRY_EVENTS)
  .filter((entry) => entry.category === "product" && entry.authoritativeSource === "api")
  .map((entry) => ({ name: entry.name as TelemetryEventName, retired: telemetryEventRetirement(entry.name as TelemetryEventName) }));

describe("API-authoritative product events", () => {
  it("declares enough of them for this check to be meaningful", () => {
    expect(apiProductEvents.length).toBeGreaterThan(20);
    for (const name of KNOWN_MISSING_PRODUCERS.keys()) {
      expect(apiProductEvents.map((entry) => entry.name)).toContain(name);
    }
  });

  it.each(apiProductEvents.filter((entry) => !entry.retired && !KNOWN_MISSING_PRODUCERS.has(entry.name)))(
    "$name is produced somewhere under apps/api/src",
    (entry) => {
      expect(producersFor(entry.name)).not.toHaveLength(0);
    },
  );

  it.each(apiProductEvents.filter((entry) => entry.retired))(
    "$name is retired, so nothing produces it",
    (entry) => {
      expect(entry.retired?.since).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
      expect(entry.retired?.reason.length).toBeGreaterThan(40);
      expect(producersFor(entry.name)).toHaveLength(0);
    },
  );

  it.each([...KNOWN_MISSING_PRODUCERS.keys()])(
    "%s is still a known gap; close the ledger row once it has a producer",
    (name) => {
      expect(producersFor(name)).toHaveLength(0);
    },
  );
});
