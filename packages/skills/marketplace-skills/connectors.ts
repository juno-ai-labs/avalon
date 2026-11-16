/**
 * The connectors a template may recommend, keyed by the slug of each one's
 * help page (`/help/connecting-your-tools/<id>/`), so a recommendation always
 * links to how to connect it. Named as those pages name them.
 */
export const TEMPLATE_CONNECTORS = [
  { id: 'google-mail-and-calendar', name: 'Google Mail and Calendar' },
  { id: 'google-drive', name: 'Google Drive' },
  { id: 'github', name: 'GitHub' },
  { id: 'linear', name: 'Linear' },
  { id: 'notion', name: 'Notion' },
  { id: 'slack', name: 'Slack' },
  { id: 'granola', name: 'Granola' },
  { id: 'fireflies', name: 'Fireflies' },
  { id: 'ashby', name: 'Ashby' },
  { id: 'canva', name: 'Canva' },
  { id: 'x', name: 'X' },
] as const;

export type TemplateConnectorId = (typeof TEMPLATE_CONNECTORS)[number]['id'];

/** The help page that explains connecting one. */
export const templateConnectorHelpPath = (id: TemplateConnectorId): string => `/help/connecting-your-tools/${id}/`;
