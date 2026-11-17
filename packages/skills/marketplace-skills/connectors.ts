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
  { id: 'x', name: 'X', mark: 'x' },
] as const;

export type TemplateConnectorId = (typeof TEMPLATE_CONNECTORS)[number]['id'];

/** The help page that explains connecting one. */
export const templateConnectorHelpPath = (id: TemplateConnectorId): string => `/help/connecting-your-tools/${id}/`;

/**
 * Rally's own plugins a template may call out: built in, so there is nothing
 * to connect, but worth knowing a template leans on. Each links to the help
 * page that explains it, and draws the glyph the app's transcript gives that
 * plugin (`glyph`, drawn by the site's `connector-marks.ts`).
 */
export const TEMPLATE_PLUGINS = [
  { id: 'web', name: 'Web search', helpPath: '/help/working-with-rally/research-and-the-web/', glyph: 'web' },
  { id: 'push-notifications', name: 'Push notifications', helpPath: '/help/rally-everywhere/notifications/', glyph: 'notifications' },
  { id: 'audio-and-images', name: 'Audio and images', helpPath: '/help/working-with-rally/pictures-and-voices/', glyph: 'image-generation' },
] as const;

export type TemplatePluginId = (typeof TEMPLATE_PLUGINS)[number]['id'];
