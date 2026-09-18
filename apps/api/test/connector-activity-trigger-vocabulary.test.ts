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
    // A connector missing from the fixture would pass this by never being
    // built. `testRegistryConfig` is typed `Required<…>` over the factory's own
    // input, so that cannot happen without a compile failure; this is the
    // weaker second check, for a connector on the telemetry list the fixture
    // builds under a different key. It is deliberately not the coverage oracle:
    // telemetry is a separate vocabulary, and a connector absent from both it
    // and the fixture would be invisible to it — which is the same mistake as
    // the bug above, one level up.
    expect(unconfiguredConnectorTypes(registry)).toEqual([]);

    const unnameable = registry.list()
      .filter((manifest) => manifest.activityTriggers.length > 0)
      .map((manifest) => manifest.type)
      .filter((type) => !ConnectorTypeSchema.safeParse(type).success);

    expect(unnameable).toEqual([]);
  });
});
