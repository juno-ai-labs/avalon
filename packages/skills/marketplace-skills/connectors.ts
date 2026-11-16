/**
 * The connectors a template may recommend, keyed by the slug of each one's
 * help page (`/help/connecting-your-tools/<id>/`), so a recommendation always
 * links to how to connect it. Named as those pages name them. `mark` is the
 * company's mark in `PLUGIN_BRAND_MARKS` (`packages/ui/src/lib/plugin-marks.ts`),
 * the one the app draws for the connector.
 */
export const TEMPLATE_CONNECTORS = [
  { id: 'google-mail-and-calendar', name: 'Google Mail and Calendar', mark: 'google' },
  { id: 'google-drive', name: 'Google Drive', mark: 'google-drive' },
  { id: 'github', name: 'GitHub', mark: 'github' },
  { id: 'linear', name: 'Linear', mark: 'linear' },
  { id: 'notion', name: 'Notion', mark: 'notion' },
  { id: 'slack', name: 'Slack', mark: 'slack' },
  { id: 'granola', name: 'Granola', mark: 'granola' },
  { id: 'fireflies', name: 'Fireflies', mark: 'fireflies' },
  { id: 'ashby', name: 'Ashby', mark: 'ashby' },
  { id: 'canva', name: 'Canva', mark: 'canva' },
  { id: 'x', name: 'X', mark: 'x' },
] as const;

export type TemplateConnectorId = (typeof TEMPLATE_CONNECTORS)[number]['id'];

/** The help page that explains connecting one. */
export const templateConnectorHelpPath = (id: TemplateConnectorId): string => `/help/connecting-your-tools/${id}/`;
