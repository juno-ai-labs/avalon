export const ConnectorOAuthProviders = [
  "custom_mcp",
  "google",
  "github",
  "granola",
  "linear",
  "notion",
  "slack",
] as const;

export type ConnectorOAuthProviderValue = (typeof ConnectorOAuthProviders)[number];
