import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { createConnectorRegistry } from "./index";

/**
 * `docs/connector-digestibility.md` reviews every connector's judgement in one
 * place, which is only worth reading if it is true. A reference table drifts the
 * first time somebody adds an event type and updates one of the two files, and
 * the half that gets forgotten is always the prose — so the manifests check it
 * rather than a reviewer.
 *
 * This asserts the rows, not the reasons. A reason that has stopped being the
 * real reason is a review problem; a row that has stopped existing is a lie the
 * next person plans around.
 */
const DOC_PATH = fileURLToPath(new URL("../../../docs/connector-digestibility.md", import.meta.url));

/** Every connector Avalon can register, with credentials shaped to pass validation. */
function fullRegistry() {
  const header = ["-----BEGIN", "PRIVATE KEY-----"].join(" ");
  const footer = ["-----END", "PRIVATE KEY-----"].join(" ");
  const oauth = { clientId: "client", clientSecret: "secret", redirectUri: "https://api.example.com/callback" };
  return createConnectorRegistry({
    canva: { redirectUri: "https://api.example.com/callback" },
    fireflies: { redirectUri: "https://api.example.com/callback" },
    granola: { redirectUri: "https://api.example.com/callback" },
    google: oauth,
    github: {
      appId: "1",
      clientId: "Iv1.client-id",
      clientSecret: "secret",
      privateKey: `${header}\nAA==\n${footer}`,
      webhookSecret: "webhook",
      redirectUri: "https://api.example.com/callback",
    },
    linear: oauth,
    notion: oauth,
    slack: { ...oauth, signingSecret: "signing" },
    x: { apiKey: "key" },
  });
}

/**
 * The activity rows. Google's polling streams use the same table shape and are
 * named for their stream id, so they are excluded by name rather than by
 * position — a heading moving must not silently drop rows from this check.
 */
const STREAM_ROW_IDS = new Set(["gmail", "calendar", "drive"]);

function documentedVerdicts(): Map<string, boolean> {
  const rows = new Map<string, boolean>();
  for (const [, eventType, verdict] of readFileSync(DOC_PATH, "utf8")
    .matchAll(/^\| `([a-z_][a-z0-9_.]*)` \| (Yes|No) \|/gmu)) {
    if (STREAM_ROW_IDS.has(eventType!)) continue;
    expect(rows.has(eventType!), `${eventType} is listed twice`).toBe(false);
    rows.set(eventType!, verdict === "Yes");
  }
  return rows;
}

describe("the connector digestibility reference", () => {
  it("states a verdict for every declared activity type, and states the manifest's", () => {
    const documented = documentedVerdicts();
    const declared = fullRegistry().list()
      .flatMap((manifest) => manifest.activityTriggers.map((trigger) => trigger.eventType));

    expect([...documented.keys()].sort()).toEqual([...declared].sort());
  });

  it("agrees with every manifest about what a digest may read", () => {
    const documented = documentedVerdicts();
    const disagreements = fullRegistry().list().flatMap((manifest) => manifest.activityTriggers
      .filter((trigger) => documented.get(trigger.eventType) !== trigger.digestible)
      .map((trigger) => `${trigger.eventType}: manifest says ${trigger.digestible}`));

    expect(disagreements).toEqual([]);
  });
});
