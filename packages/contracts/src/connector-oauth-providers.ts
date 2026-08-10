export const ConnectorOAuthProviders = [
  "google",
  "github",
  "granola",
  "linear",
  "notion",
  "slack",
] as const;

export type ConnectorOAuthProviderValue = (typeof ConnectorOAuthProviders)[number];
