import { ConnectorInstallationProviders, type ConnectorInstallationProvider } from "./connector-installation";

/**
 * Everything a person needs to get one API key pasted, per provider.
 *
 * The product rule is one API key: somebody pastes a key and Rally does the
 * rest. Two things stood between a person and that paste, and both were spread
 * across surfaces rather than declared once:
 *
 * - **Where the key is issued.** Every setup modal linked a documentation page
 *   and then wrote out the click path in prose, so the person read a guide and
 *   went hunting. `issuingUrl` is the page that issues the key wherever the
 *   provider has one, and the documentation page only where it does not.
 * - **What a key looks like.** The Granola pattern existed three times — the
 *   API's request schema, the adapter's own check, and a regex literal inline
 *   in a disabled button — and the desktop copy told nobody why the button was
 *   dead. One declaration, one message.
 *
 * `format` is null unless the provider documents a format. Ashby and Fireflies
 * do not: their keys are opaque strings, and a prefix invented here would
 * reject a valid key at the one step this is meant to smooth.
 */
export interface ConnectorApiKeyFormat {
  /** Documented shape of an issued key. Anchored, and never global — this is tested repeatedly. */
  readonly pattern: RegExp;
  /** Shown in the empty field, so the expected shape is visible before anything is typed. */
  readonly placeholder: string;
  /** What to say when the paste does not match. Names the provider and the observable part of the shape. */
  readonly mismatch: string;
}

export interface ConnectorApiKeyGuidance {
  /** The page to open: where the key is issued, or the documentation page when the provider issues keys elsewhere. */
  readonly issuingUrl: string;
  /** Link text, without the external-link mark the surface adds. */
  readonly issuingLabel: string;
  readonly format: ConnectorApiKeyFormat | null;
}

export const ConnectorApiKeyGuidanceCatalog = {
  ashby: {
    issuingUrl: "https://app.ashbyhq.com/admin/api/keys",
    issuingLabel: "Create the key in Ashby",
    // Ashby documents no format: its authentication page shows a key only as a
    // basic-auth username. Nothing to check that would not be a guess.
    format: null,
  },
  fireflies: {
    issuingUrl: "https://app.fireflies.ai/integrations/custom/fireflies",
    issuingLabel: "Copy the key from Fireflies",
    // Fireflies documents no format either — its authorization page describes
    // the header, not the key.
    format: null,
  },
  granola: {
    // Granola issues workspace keys in its desktop app — Settings → Connectors
    // → Workspace API keys — and publishes no web page that creates one, so
    // this is the help-centre article rather than a deep link.
    issuingUrl: "https://docs.granola.ai/help-center/sharing/integrations/granola-api",
    issuingLabel: "Open Granola’s API key guide",
    format: {
      pattern: /^grn_[\x21-\x7E]{1,508}$/u,
      placeholder: "grn_…",
      mismatch: "That does not look like a Granola workspace API key — Granola keys start with grn_. Paste the whole key.",
    },
  },
} as const satisfies Record<ConnectorInstallationProvider, ConnectorApiKeyGuidance>;

/**
 * The reason a pasted key cannot be a key for this provider, or null.
 *
 * Null for a provider with no documented format and for an empty field: an
 * empty field is a person who has not pasted yet, not a person who pasted the
 * wrong thing, and telling them off before they start is the friction this is
 * removing.
 */
export function connectorApiKeyMismatch(provider: ConnectorInstallationProvider, apiKey: string): string | null {
  const format = ConnectorApiKeyGuidanceCatalog[provider].format;
  if (!format) return null;
  const pasted = apiKey.trim();
  if (!pasted) return null;
  return format.pattern.test(pasted) ? null : format.mismatch;
}

/** True when the trimmed value can be sent: non-empty, and matching a documented format if there is one. */
export function connectorApiKeyAcceptable(provider: ConnectorInstallationProvider, apiKey: string): boolean {
  const pasted = apiKey.trim();
  if (!pasted) return false;
  return connectorApiKeyMismatch(provider, pasted) === null;
}

export function isConnectorApiKeyProvider(provider: string): provider is ConnectorInstallationProvider {
  return (ConnectorInstallationProviders as readonly string[]).includes(provider);
}
