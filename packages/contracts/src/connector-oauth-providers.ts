export const ConnectorOAuthProviders = [
  "custom_mcp",
  "google",
  "github",
  "apollo",
  "ashby",
  "canva",
  "fireflies",
  "granola",
  "linear",
  "notion",
  "slack",
] as const;

export type ConnectorOAuthProviderValue = (typeof ConnectorOAuthProviders)[number];
