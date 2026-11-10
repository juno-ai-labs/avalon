/**
 * What a Sidekick source's connector is called to a person, wherever a
 * source is named in words: a notice's title, an email, the page an emailed
 * answer opens. `docs/sidekick-sources.md` owns the source.
 *
 * Google is one connector type and several products, and a source names
 * events rather than a product: mail events are Gmail's, calendar events
 * Google Calendar's, file events Google Drive's. A mix, or a family this does
 * not know, is the connector's own name. Every other connector is called by
 * the name the caller already has for it (its manifest's display name on the
 * server).
 */
export function sourceConnectorName(connectorType: string, eventTypes: readonly string[], connectorName: string): string {
  if (connectorType !== "google" || eventTypes.length === 0) return connectorName;
  const families = new Set(eventTypes.map((eventType) => eventType.split(".")[0] ?? ""));
  const only = (...names: string[]): boolean => [...families].every((family) => names.includes(family));
  if (only("email")) return "Gmail";
  if (only("calendar")) return "Google Calendar";
  if (only("drive", "docs", "sheets")) return "Google Drive";
  return connectorName;
}
