import type { ConnectorActivityTriggerDescriptorV2, Scope } from "@rally/contracts";
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
 * The activity triggers one connection can start an automation with.
 *
 * Most connectors declare their triggers once, in the manifest, because the
 * provider defines the events. A generic webhook is the other way around: the
 * connection's own `eventTypes` allowlist is the vocabulary its deliveries
 * carry (the adapter reads `event_type` from the body and the ingress refuses
 * any type outside the list), so its triggers are one per configured type,
 * with the payload's own keys as the filter fields. Declaring only
 * `webhook.received` made every webhook rule unmatchable: a delivery carried
 * its caller's type, and the matcher selects registrations by exact type.
 */
function configuredEventTypes(configJson: string | null | undefined, field: "eventTypes" | "selectedEvents" = "eventTypes"): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(configJson ?? "{}");
  } catch {
    return [];
  }
  const configured = parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)[field]
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
    return adapter.manifest.activityTriggers.filter((descriptor) => {
      // Docs and Sheets changes arrive through the Drive polling stream.
      const capability = descriptor.eventType.startsWith("email.") ? "gmail.read"
        : descriptor.eventType.startsWith("calendar.") ? "calendar.read" : "drive.read";
      return grantedScopes.includes(capability);
    });
  }
  if (adapter.manifest.type === "ashby") {
    const selected = new Set(configuredEventTypes(connectionConfigJson, "selectedEvents"));
    return adapter.manifest.activityTriggers.filter((descriptor) => selected.has(descriptor.eventType));
  }
  if (adapter.manifest.type !== "generic_webhook") return [...adapter.manifest.activityTriggers];
  const eventTypes = configuredEventTypes(connectionConfigJson);
  return (eventTypes.length > 0 ? eventTypes : ["webhook.received"]).map((eventType) => ({
    eventType,
    label: eventType,
    description: `A delivery of ${eventType} on this webhook. Any key the caller posts under metadata may be filtered on, with the operators of its type; name the key bare, without a metadata. prefix.`,
    eventFamilies: [],
    filterFields: [],
    resourceRelationships: [],
    digestible: false,
    openFilterFields: true,
  }));
}
