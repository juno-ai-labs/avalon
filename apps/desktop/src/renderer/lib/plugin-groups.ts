import type { AutomationPluginIcon } from '@rally/contracts';

/**
 * The glyph a grouped activity row draws.
 *
 * The connector icons are the contract's, so a connector that already declares
 * one keeps it. The two extra marks belong to the virtual groups below, which
 * no connector owns and the backend therefore never names.
 */
export type PluginGroupIcon = AutomationPluginIcon | 'computer' | 'rally';

export interface PluginGroup {
  /** Two plugins that share this key share one row. */
  key: string;
  name: string;
  icon: PluginGroupIcon;
}

const RALLY_GROUP: PluginGroup = { key: 'rally', name: 'Rally', icon: 'rally' };
const COMPUTER_GROUP: PluginGroup = { key: 'computer', name: 'Computer', icon: 'computer' };

/**
 * The plugins a reader has no reason to tell apart.
 *
 * Discovery, skills, core, memory, and tables are all Rally thinking about its
 * own workspace; a row per plugin split one thought into five. Workstream and
 * Terminal are both Rally operating a machine on the reader's behalf, which is
 * what "Computer" names. Everything absent from this map keeps its own row —
 * a connector is a place the reader recognizes, and collapsing Slack into
 * Rally would hide the only part of the activity they can act on.
 */
const GROUPED_PLUGIN_IDS = new Map<string, PluginGroup>([
  ['rally:core', RALLY_GROUP],
  ['rally:discovery', RALLY_GROUP],
  ['rally:memory', RALLY_GROUP],
  ['rally:tables', RALLY_GROUP],
  ['rally.skills', RALLY_GROUP],
  ['rally:terminal', COMPUTER_GROUP],
  ['rally:workstream', COMPUTER_GROUP],
]);

/**
 * A first-party plugin the harness never gave a display name renders its raw
 * canonical id as its label — `rally:memory`, `rally.skills`. Those are the
 * ones the map above collapses, so an unmapped first-party plugin in that same
 * state is a new one nobody has decided about yet: fold it into Rally rather
 * than leak an internal identifier into the feed. A first-party plugin that
 * does carry a display name — Web, Terminal, Workstream — has been named
 * deliberately and is treated like any other named plugin.
 */
function isUnnamedFirstPartyPlugin(pluginId: string, displayName: string | undefined): boolean {
  return (pluginId.startsWith('rally:') || pluginId.startsWith('rally.'))
    && (displayName === undefined || displayName === pluginId);
}

/**
 * The connector glyph for a plugin's display name.
 *
 * The canonical transcript identifies a connector plugin by its connection id
 * — `connection:<uuid>` — which says nothing about which service it is, and
 * the icon the backend does resolve travels only on the live tool-invocation
 * row. So the name is the signal here, and it is a stable one: these are
 * manifest strings, not user input. It mirrors the backend's own mapping in
 * `connectorAutomationPluginIcon`, including that Granola and X have adapters
 * but no brand glyph and so share the generic plug.
 */
function connectorIconForName(displayName: string): PluginGroupIcon {
  const name = displayName.toLowerCase();
  if (name.startsWith('google')) return name.includes('drive') ? 'brand-google-drive' : 'brand-google';
  if (name.startsWith('slack')) return 'brand-slack';
  if (name.startsWith('github')) return 'brand-github';
  if (name.startsWith('notion')) return 'brand-notion';
  if (name.startsWith('linear')) return 'linear';
  if (name.includes('webhook')) return 'webhook';
  if (name.startsWith('web')) return 'world-search';
  return 'plug';
}

/**
 * The row a plugin's tool calls belong to, or null when the transcript does not
 * yet say which plugin ran.
 *
 * A tool block is written when the model plans the call and only learns its
 * owner when the call starts, so a planned block is briefly anonymous. Null
 * keeps that moment out of the feed rather than attributing work to a plugin
 * that may not have done it; the row appears with the plugin, a beat later,
 * and the run's own timer covers the gap.
 */
export function pluginGroup(
  pluginId: string | undefined,
  displayName: string | undefined,
): PluginGroup | null {
  if (pluginId) {
    const grouped = GROUPED_PLUGIN_IDS.get(pluginId);
    if (grouped) return grouped;
    if (isUnnamedFirstPartyPlugin(pluginId, displayName)) return RALLY_GROUP;
  }
  // Two connections to the same service — a personal and a workspace Slack —
  // are one place as far as the reader is concerned, so the name is the key
  // rather than the id. It is also the only key the live pre-canonical row and
  // the canonical block that replaces it can both produce: they identify the
  // same plugin by different ids.
  if (displayName) return { key: `name:${displayName}`, name: displayName, icon: connectorIconForName(displayName) };
  if (pluginId) return { key: `id:${pluginId}`, name: pluginId, icon: 'plug' };
  return null;
}
