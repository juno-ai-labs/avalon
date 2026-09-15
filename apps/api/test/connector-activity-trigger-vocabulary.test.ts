import { ConnectorTypeSchema } from "@rally/contracts";
import { describe, expect, it } from "vitest";

import { createTestConnectorRegistry, unconfiguredConnectorTypes } from "./helpers/connector-registry";

/**
 * The one link between the connector registry and the vocabulary a rule may
 * name.
 *
 * `ConnectorTypeSchema` is a second spelling of the registry's own membership,
 * and nothing but this file ties them together. It drifted once, in the way
 * that costs the most to find: `fireflies` shipped as a connector with activity
 * triggers and was never added to the enum, so a Fireflies Sidekick was
 * accepted and showed as published, and then its registration projection was
 * rejected at `source.connectorType` — on a Durable Object RPC hop, where a
 * `ZodError` arrives with no issues and no message. The Sidekick never fired,
 * the publication alarm retried forever, and the only evidence was the word
 * `ZodError`.
 *
 * A connector that declares no activity trigger is deliberately not required
 * here: it can never produce an event for a rule to match, so naming it would
 * be vocabulary for nothing.
 */
describe("connector activity-trigger vocabulary", () => {
  it("lets a rule name every connector that can emit an activity event", () => {
    const registry = createTestConnectorRegistry();
    // Guard the guard: a connector missing from the fixture would otherwise
    // pass this by never being built.
    expect(unconfiguredConnectorTypes(registry)).toEqual([]);

    const unnameable = registry.list()
      .filter((manifest) => manifest.activityTriggers.length > 0)
      .map((manifest) => manifest.type)
      .filter((type) => !ConnectorTypeSchema.safeParse(type).success);

    expect(unnameable).toEqual([]);
  });
});
