import type { AutomationPluginIcon } from '@rally/contracts';
import { connectorBrandMark, type PluginBrandMark } from './plugin-marks';

/**
 * The glyph a plugin row draws.
 *
 * A brand draws its own mark, from `plugin-marks.ts`. The rest are the shapes
 * no company owns: the two virtual groups, the public web, an unbranded
 * webhook, and the plug a connector with no mark of its own falls back to.
 */
export type PluginGroupIcon = PluginBrandMark | 'computer' | 'plug' | 'rally' | 'web' | 'webhook';

/**
 * The glyph for one of the backend's own icon names.
 *
 * The contract enum is what a live tool-invocation row and the automation draft
 * wizard carry, and it predates this vocabulary: it calls a Drive mark
 * `brand-google-drive` and a web search `world-search`. Translating rather than
 * widening the contract keeps the glyph a presentation decision — and the
 * contract has no name at all for X, whose mark this renderer can now draw.
 */
export function pluginGroupIconForContract(icon: AutomationPluginIcon): PluginGroupIcon {
  switch (icon) {
    case 'brand-github': return 'github';
    case 'brand-google': return 'google';
    case 'brand-google-drive': return 'google-drive';
    case 'brand-notion': return 'notion';
    case 'brand-slack': return 'slack';
    case 'linear': return 'linear';
    case 'webhook': return 'webhook';
    case 'world-search': return 'web';
    case 'plug': return 'plug';
  }
}

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
 * The connector type a plugin's display name belongs to.
 *
 * The canonical transcript identifies a connector plugin by its connection id
 * — `connection:<uuid>` — which says nothing about which service it is, and the
 * icon the backend does resolve travels on the live tool-invocation row alone.
 * So a name is all this surface has, and it is a stable one: these are manifest
 * strings, not user input.
 *
 * Recovering the type rather than picking a mark here is what keeps a connector
 * wearing one mark everywhere. `connectorBrandMark` is the single table, and
 * Settings reaches it from the type it already holds.
 */
function connectorTypeForName(displayName: string): string | null {
  const name = displayName.toLowerCase();
  if (name.startsWith('google')) return 'google';
  if (name.startsWith('slack')) return 'slack';
  if (name.startsWith('github')) return 'github';
  if (name.startsWith('notion')) return 'notion';
  if (name.startsWith('linear')) return 'linear';
  if (name.startsWith('granola')) return 'granola';
  // Exactly "X", which is the connector's whole manifest name. A prefix match
  // on one letter would claim every later connector that starts with it.
  if (name === 'x') return 'x';
  if (name.includes('webhook')) return 'generic_webhook';
  return null;
}

/** The glyph for a plugin known only by the name it displays. */
function connectorIconForName(displayName: string): PluginGroupIcon {
  const connectorType = connectorTypeForName(displayName);
  const mark = connectorType ? connectorBrandMark(connectorType, displayName) : null;
  if (mark) return mark;
  if (connectorType === 'generic_webhook') return 'webhook';
  // Not a connector at all: Rally's own named plugins reach here too.
  if (displayName.toLowerCase().startsWith('web')) return 'web';
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
  // A plugin id this table cannot name is not a row. `connection:<uuid>` is the
  // shape that reaches here — a connector block whose plugin activity has not
  // arrived, or never will — and a row reading "connection:9c1f… worked for
  // 0ms" is worse than the tool name this feed already declines to show. It
  // would also key on the id, so the activity landing later would open a second
  // row beside it rather than merging into one.
  return null;
}
