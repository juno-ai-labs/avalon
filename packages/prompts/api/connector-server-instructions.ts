/**
 * A connector plugin's system message with the usage instructions its MCP
 * server published, demoted beneath Rally policy and the user's request.
 */
export function renderConnectorServerInstructions(systemMessage: string, serverInstructions: string): string {
  return `${systemMessage}\n\nServer-provided usage instructions for this plugin (subject to Rally policy and the user's request):\n${serverInstructions}`;
}
