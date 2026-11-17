/**
 * The always-active core plugin's system message: one line per core tool this
 * run holds. The caller decides which it holds, with the tool-name constants
 * where they exist, so the prompt package needs none of them.
 */
export function renderCorePluginSystemMessage(holds: {
  currentTime: boolean;
  elicitation: boolean;
  addMember: boolean;
  connectorConnection: boolean;
  connectorList: boolean;
  resourceAccess: boolean;
}): string {
  return [
    ...(holds.currentTime
      ? ["Use current_time when exact current time or timezone matters; never infer it from transcript timestamps."]
      : []),
    ...(holds.elicitation
      ? ["Use request_elicitation for one structured blocking question that must pause the run for human input."]
      : []),
    ...(holds.addMember
      ? ["When the work needs someone named by email to be a member of this Organization, such as to ask them for a Sidekick source, call offer_to_add_member with their address: it returns a member's userId, and offers to add anyone who is not one. Never call it for people the work only emails or reads mail from, such as customers, leads or vendors."]
      : []),
    ...(holds.connectorConnection
      ? ["For a connector, call get_connector_connection_state first; it reports every scope. A connected personal connection is enough: do not ask for the workspace one when the person's own can do the task. If no connected scope can and reconnect_required or not_connected blocks the task, explain why and call show_connector_connection with the same connectorId and the scope the task needs. If it returns unavailable, explain that the connector is not configured in this Rally region and do not show a card. A state check is not a refusal: when a connected plugin can do the work, try it. Never tell a person to complete a connection prompt unless show_connector_connection ran in that same reply or a tool result in it says its own card connects the account, and never tell another agent that a connection blocks it unless a tool refused for that reason. Do not invent an authorization URL or claim the connection succeeded."]
      : []),
    ...(holds.connectorList
      ? [[
          "When the work or artifact asked for would draw on email, calendar, files, chat, issues, code, meeting notes or another outside system, call list_connectors to see which connectors and accounts the person has and which they could add.",
          // Offering is the card's job; a loop whose card refuses is told only to read.
          ...(holds.connectorConnection
            ? ["Offer a missing one only when it would clearly help, in one sentence, with show_connector_connection; never block on it when the work can be done without it. In a Sidekick run that call pauses the run, so there offer only a connection the run cannot finish without."]
            : []),
        ].join(" ")]
      : []),
    ...(holds.resourceAccess
      ? ["Before reading or editing a linked file, or after a call on it was refused, call check_resource_access to learn which connection can open it, then use that plugin."]
      : []),
  ].join(" ");
}
