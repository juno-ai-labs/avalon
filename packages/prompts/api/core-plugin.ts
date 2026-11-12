/** The always-active core plugin's system message: one line per core tool this run holds. */
export function renderCorePluginSystemMessage(tools: ReadonlySet<string>): string {
  return [
    ...(tools.has("current_time")
      ? ["Use current_time when exact current time or timezone matters; never infer it from transcript timestamps."]
      : []),
    ...(tools.has("request_elicitation")
      ? ["Use request_elicitation for one structured blocking question that must pause the run for human input."]
      : []),
    ...(tools.has("get_connector_connection_state")
      && tools.has("show_connector_connection")
      ? ["For a connector, call get_connector_connection_state first; it reports every scope. A connected personal connection is enough: do not ask for the workspace one when the person's own can do the task. If no connected scope can and reconnect_required or not_connected blocks the task, explain why and call show_connector_connection with the same connectorId and the scope the task needs. If it returns unavailable, explain that the connector is not configured in this Rally region and do not show a card. A state check is not a refusal: when a connected plugin can do the work, try it. Never tell a person to complete a connection prompt unless show_connector_connection ran in that same reply, and never tell another agent that a connection blocks it unless a tool refused for that reason. Do not invent an authorization URL or claim the connection succeeded."]
      : []),
    ...(tools.has("check_resource_access")
      ? ["Before reading or editing a linked file, or after a call on it was refused, call check_resource_access to learn which connection can open it, then use that plugin."]
      : []),
  ].join(" ");
}
