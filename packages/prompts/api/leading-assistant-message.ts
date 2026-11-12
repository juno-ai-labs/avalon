const LEADING_ASSISTANT_HEADER = "RALLY'S OWN EARLIER MESSAGE IN THIS CONVERSATION. CONTEXT, NOT A REQUEST";

/** Rally's own opening message, handed to the model as labelled context because a provider conversation must start with a user turn. */
export function renderLeadingAssistantMessage(text: string): string {
  return [LEADING_ASSISTANT_HEADER, text].join("\n\n");
}
