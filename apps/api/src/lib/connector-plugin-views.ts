import { ConnectorConnectionCardCatalog } from "@rally/contracts";

export type GooglePluginBundle = "mail_calendar" | "drive";

/** One model-visible tool bundle backed by an unchanged connection row. */
export interface ConnectorPluginView {
  modelPluginId: string;
  credentialModelPluginId: string;
  grantedScopes: string[];
  googleBundle?: GooglePluginBundle;
}

function googleBundles(grantedScopes: readonly string[]) {
  return [
    { key: "mail_calendar" as const, prefixes: ConnectorConnectionCardCatalog["google-mail-calendar"].capabilityPrefixes },
    { key: "drive" as const, prefixes: ConnectorConnectionCardCatalog["google-drive"].capabilityPrefixes },
  ].map(({ key, prefixes }) => ({ key, grantedScopes: grantedScopes.filter((scope) =>
    prefixes.some((prefix) => scope.startsWith(prefix))) }))
    .filter((bundle) => bundle.grantedScopes.length > 0);
}

export function connectorPluginViews(
  connectorType: string,
  modelPluginId: string,
  grantedScopes: readonly string[],
  displayName?: string,
): ConnectorPluginView[] {
  if (connectorType !== "google") {
    return [{
      modelPluginId: connectorType === "custom_mcp" ? customMcpModelPluginId(modelPluginId, displayName) : modelPluginId,
      credentialModelPluginId: modelPluginId,
      grantedScopes: [...grantedScopes],
    }];
  }
  const bundles = googleBundles(grantedScopes);
  return bundles.map(({ key, grantedScopes }) => ({
    modelPluginId: bundles.length > 1 ? `${modelPluginId}_${key}` : modelPluginId,
    credentialModelPluginId: modelPluginId,
    grantedScopes,
    ...(bundles.length > 1 ? { googleBundle: key } : {}),
  }));
}

/** A bounded identifier derived from the name, never raw configuration in prompt prose. */
function customMcpModelPluginId(credentialId: string, displayName?: string): string {
  const match = /^plugin_custom_mcp(?:_([1-9][0-9]*))?$/u.exec(credentialId);
  if (!match || displayName === undefined) return credentialId;
  const suffix = `_${match[1] ?? "1"}`;
  const prefix = "plugin_mcp_";
  const slug = displayName.normalize("NFKD").toLowerCase()
    .replace(/\p{M}/gu, "").replace(/[^a-z0-9]+/gu, "_").replace(/^_+|_+$/gu, "") || "server";
  // ModelPluginIdSchema permits 70 characters, including `plugin_`. Preserve
  // the allocated ordinal even when the name is truncated or transliterates away.
  return `${prefix}${slug.slice(0, 70 - prefix.length - suffix.length).replace(/_+$/u, "")}${suffix}`;
}

export function connectorPluginCanonicalId(connectionId: string, googleBundle?: GooglePluginBundle): string {
  return `connection:${connectionId}${googleBundle ? `:${googleBundle}` : ""}`;
}

/** Saved bindings retain both credential and bundle aliases as grants change. */
export function connectorPluginBindingViews(
  connectorType: string,
  modelPluginId: string,
  grantedScopes: readonly string[],
  displayName?: string,
): ConnectorPluginView[] {
  if (connectorType !== "google") {
    const views = connectorPluginViews(connectorType, modelPluginId, grantedScopes, displayName);
    return views[0]?.modelPluginId === modelPluginId ? views : [
      ...views, { modelPluginId, credentialModelPluginId: modelPluginId, grantedScopes: [...grantedScopes] },
    ];
  }
  const bundles = googleBundles(grantedScopes);
  if (bundles.length === 0) return [];
  return [...bundles.map(({ key, grantedScopes }) => ({
    modelPluginId: `${modelPluginId}_${key}`, credentialModelPluginId: modelPluginId,
    grantedScopes, googleBundle: key,
  })), { modelPluginId, credentialModelPluginId: modelPluginId, grantedScopes: [...grantedScopes] }];
}
