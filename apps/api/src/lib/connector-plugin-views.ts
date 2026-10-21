import { ConnectorConnectionCardCatalog } from "@rally/contracts";

export type GooglePluginBundle = "mail_calendar" | "drive";

/** One model-visible tool bundle backed by an unchanged connection row. */
export interface ConnectorPluginView {
  modelPluginId: string;
  credentialModelPluginId: string;
  grantedScopes: string[];
  googleBundle?: GooglePluginBundle;
}

export function connectorPluginViews(
  connectorType: string,
  modelPluginId: string,
  grantedScopes: readonly string[],
): ConnectorPluginView[] {
  if (connectorType !== "google") {
    return [{ modelPluginId, credentialModelPluginId: modelPluginId, grantedScopes: [...grantedScopes] }];
  }
  const bundles = [
    { key: "mail_calendar" as const, prefixes: ConnectorConnectionCardCatalog["google-mail-calendar"].capabilityPrefixes },
    { key: "drive" as const, prefixes: ConnectorConnectionCardCatalog["google-drive"].capabilityPrefixes },
  ].map(({ key, prefixes }) => ({ key, grantedScopes: grantedScopes.filter((scope) =>
    prefixes.some((prefix) => scope.startsWith(prefix))) }))
    .filter((bundle) => bundle.grantedScopes.length > 0);
  return bundles.map(({ key, grantedScopes }) => ({
    modelPluginId: bundles.length > 1 ? `${modelPluginId}_${key}` : modelPluginId,
    credentialModelPluginId: modelPluginId,
    grantedScopes,
    ...(bundles.length > 1 ? { googleBundle: key } : {}),
  }));
}

export function connectorPluginCanonicalId(connectionId: string, googleBundle?: GooglePluginBundle): string {
  return `connection:${connectionId}${googleBundle ? `:${googleBundle}` : ""}`;
}

/** Saved Sidekicks may still bind the credential's former combined ID. */
export function connectorPluginBindingViews(
  connectorType: string,
  modelPluginId: string,
  grantedScopes: readonly string[],
): ConnectorPluginView[] {
  const views = connectorPluginViews(connectorType, modelPluginId, grantedScopes);
  return views.some((view) => view.googleBundle)
    ? [...views, { modelPluginId, credentialModelPluginId: modelPluginId, grantedScopes: [...grantedScopes] }]
    : views;
}
