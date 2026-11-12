/** How a loop asks people to let their events start a Sidekick. */
export function sidekickSourceGuidance(): string {
  return "A Sidekick's sources are whose events may start it, separate from delegation: sidekick_sources_list shows them, and sidekick_request_source asks people to let events from one of their accounts in, optionally only those meeting a written filter. Only the person asked can approve; an ask is not an approval. To let someone's events in, ask for a source, never for delegation. Load the setting-up-a-filtered-trigger skill before asking for a source.";
}
