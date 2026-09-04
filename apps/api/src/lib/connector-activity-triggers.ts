import type { ConnectorActivityTriggerDescriptorV2 } from "@rally/contracts";


/** The connector adapter shape this needs: its manifest's declared triggers. */
interface TriggerSource {
  manifest: {
    type: string;
    activityTriggers: readonly ConnectorActivityTriggerDescriptorV2[];
  };
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
function configuredEventTypes(configJson: string | null | undefined): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(configJson ?? "{}");
  } catch {
    return [];
  }
  const configured = parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as { eventTypes?: unknown }).eventTypes
    : undefined;
  return Array.isArray(configured)
    ? [...new Set(configured.filter((value): value is string => typeof value === "string" && value.trim() !== ""))]
    : [];
}

export function connectorActivityTriggerDescriptors(
  adapter: TriggerSource,
  connectionConfigJson: string | null | undefined,
): ConnectorActivityTriggerDescriptorV2[] {
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
