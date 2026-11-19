import { googleActivityCapability, type ConnectorActivityTriggerDescriptorV2, type Scope } from "@rally/contracts";
import { connectorActivitySupportsScope } from "@rally/connectors";


/** The connector adapter shape this needs: its manifest's declared triggers. */
interface TriggerSource {
  manifest: {
    type: string;
    supportedScopes: readonly Scope[];
    activityTriggers: readonly ConnectorActivityTriggerDescriptorV2[];
  };
  activityConnectionScopes?: readonly Scope[] | undefined;
}

/**
 * A stored connection's scope, narrowed from the column it is read out of.
 *
 * Every caller of the helper below reads its connection straight from D1,
 * where `scope` is a string; the column admits only the two values, so the
 * narrowing is a cast with a name rather than a decision, and having one of
 * them keeps the two read paths from spelling it differently.
 */
export function storedConnectionScope(scope: string): Scope {
  return scope === "workspace" ? "workspace" : "personal";
}

/**
 * The event types a connection's stored config selects (`selectedEvents`).
 *
 * Most connectors declare their triggers once, in the manifest, because the
 * provider defines the events. Ashby's connection selects a subset of its
 * manifest's events, and only those can start an automation.
 */
function selectedEventTypes(configJson: string | null | undefined): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(configJson ?? "{}");
  } catch {
    return [];
  }
  const configured = parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>).selectedEvents
    : undefined;
  return Array.isArray(configured)
    ? [...new Set(configured.filter((value): value is string => typeof value === "string" && value.trim() !== ""))]
    : [];
}

export function connectorActivityTriggerDescriptors(
  adapter: TriggerSource,
  connectionConfigJson: string | null | undefined,
  connectionScope: Scope,
  grantedScopes?: readonly string[],
): ConnectorActivityTriggerDescriptorV2[] {
  // A connection whose scope cannot receive this connector's events advertises
  // nothing, whatever its manifest declares. Granola, Fireflies and Ashby all
  // throw `unauthorized` from `normalize` off workspace scope, so a trigger
  // offered on a personal one is an event that can never arrive: a Sidekick
  // built on it drafts, applies, activates and then stays silent forever,
  // which nothing in the product distinguishes from a Sidekick that simply
  // has nothing to do yet.
  if (!connectorActivitySupportsScope(adapter, connectionScope)) return [];
  if (adapter.manifest.type === "google" && grantedScopes) {
    return adapter.manifest.activityTriggers.filter((descriptor) => grantedScopes.includes(googleActivityCapability(descriptor.eventType)));
  }
  if (adapter.manifest.type === "ashby") {
    const selected = new Set(selectedEventTypes(connectionConfigJson));
    return adapter.manifest.activityTriggers.filter((descriptor) => selected.has(descriptor.eventType));
  }
  return [...adapter.manifest.activityTriggers];
}
