import type { AutomationPluginIcon } from '@rally/contracts';
import { connectorBrandMark, type PluginBrandMark } from './plugin-marks';

/**
 * The glyph a plugin row draws.
 *
 * A brand draws its own mark, from `plugin-marks.ts`. The rest are the shapes
 * no company owns: the two virtual groups, the mail mark an agent-to-agent
 * message wears and the two a worker's outcome does, multimodal generation,
 * automations, the public web, an unbranded webhook, and the plug a connector
 * with no mark of its own falls back to.
 */
export type PluginGroupIcon =
  | PluginBrandMark
  | 'agent-failed'
  | 'agent-finished'
  | 'agent-messages'
  | 'automations'
  | 'background-agents'
  | 'computer'
  | 'image-generation'
  | 'plug'
  | 'rally'
  | 'web'
  | 'webhook';

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
  /**
   * How the row reads, running and settled.
   *
   * Rally is the one plugin that is the agent, so it is the subject of its own
   * sentence: "Rally is working", "Rally worked". Every other row names a tool
   * Rally reached for, and reads as something Rally did with it — "Using
   * Slack", "Used Slack" — because a connector did not decide to do anything;
   * it was used. Carrying both phrasings on the group keeps that a property of
   * the group rather than a special case in the component that draws it.
   */
  activeVerb: string;
  completedVerb: string;
  /**
   * How a settled row reads when the group is counted rather than timed.
   *
   * Most rows here answer "how long": a plugin is a place Rally worked and the
   * time it spent there is the fact worth carrying. A message is not a place —
   * it either happened or it did not — and "Used Background agents for 1s" told
   * a reader nothing about the two messages that second contained. A group that
   * supplies this phrases its own total instead, and its row prints no duration
   * at all: `AgentWorkTiming` already renders the verb alone for a stretch whose
   * time is unknown, and an unknown time and an irrelevant one want exactly the
   * same row.
   *
   * Absent on every other group, which keeps "counted" a property one group
   * opts into rather than a second row type the feed has to learn.
   */
  countPhrase?: (count: number) => string;
}

/** The default phrasing: Rally used this plugin. */
function usedGroupVerbs(subject: string): Pick<PluginGroup, 'activeVerb' | 'completedVerb'> {
  return { activeVerb: `Using ${subject}`, completedVerb: `Used ${subject}` };
}

const RALLY_GROUP: PluginGroup = {
  key: 'rally',
  name: 'Rally',
  icon: 'rally',
  // Rally is not something Rally used.
  activeVerb: 'Rally is working',
  completedVerb: 'Rally worked',
};
const COMPUTER_GROUP: PluginGroup = {
  key: 'computer',
  name: 'Computer',
  icon: 'computer',
  // The only group whose name is a common noun rather than a proper one, so it
  // is the only one that needs an article: "Used a computer", not "Used
  // Computer". Every connector is a name and takes none.
  ...usedGroupVerbs('a computer'),
};
const MULTIMODAL_GENERATION_GROUP: PluginGroup = {
  key: 'name:Multimodal generation',
  name: 'Multimodal generation',
  icon: 'image-generation',
  ...usedGroupVerbs('Multimodal generation'),
};
/** "1 message", "2 messages" — the noun the two rows below both count. */
function messageCount(count: number): string {
  return `${count} message${count === 1 ? '' : 's'}`;
}

/**
 * A teammate's message arriving here, and this conversation's messages out to
 * one.
 *
 * Two rows rather than one because the direction is the whole fact: a reader
 * scanning a run wants to know whether Rally handed work out or got an answer
 * back, and a single "3 messages with a background agent" row answers neither.
 * They share a glyph for the same reason two Slack calls do — it is one
 * mechanism — and the mail mark is that mechanism rather than the Background
 * agents stack, which stands for the agents themselves and still owns
 * `start_agent`, `list_agents` and `stop_agent`.
 *
 * Inbound is never active. A received message has already arrived, so there is
 * no in-flight state for the row to report; the verb is there because every
 * group carries one, not because it is reachable.
 */
export const AGENT_MESSAGES_INBOUND_GROUP: PluginGroup = {
  key: 'agent-messages:inbound',
  name: 'Background agents',
  icon: 'agent-messages',
  activeVerb: 'Receiving a message from a background agent',
  completedVerb: '1 message from a background agent',
  countPhrase: (count) => `${messageCount(count)} from a background agent`,
};
export const AGENT_MESSAGES_OUTBOUND_GROUP: PluginGroup = {
  key: 'agent-messages:outbound',
  name: 'Background agents',
  icon: 'agent-messages',
  activeVerb: 'Sending a message to a background agent',
  completedVerb: '1 message sent to a background agent',
  countPhrase: (count) => `${messageCount(count)} sent to a background agent`,
};

/** "1 background agent", "2 background agents" — the noun the three rows below count. */
function workerCount(count: number): string {
  return `${count} background agent${count === 1 ? '' : 's'}`;
}

/**
 * A worker being started, and the two ends the transcript records.
 *
 * These wear the agents' own marks rather than the mail one: the subject is the
 * worker, not what was said to it. Starting keeps the stack the Background
 * agents row has always drawn, because it is the one of the three that is still
 * Rally reaching for that plugin; the two outcomes take marks of their own,
 * since a row a reader may have to act on should not look like the row above it
 * that only says work was handed out.
 *
 * **There is no row for a worker that finished normally**, and there is nothing
 * to build one from: the host writes a notice only when a run fails or ends
 * without a word, because a run that replied has already said it is done in the
 * message it sent — which is the "messages from a background agent" row. A row
 * claiming to be general completion would be silent for exactly the workers
 * that did their job.
 */
export const AGENT_WORKERS_STARTED_GROUP: PluginGroup = {
  key: 'agent-workers:started',
  name: 'Background agents',
  icon: 'background-agents',
  activeVerb: 'Starting a background agent',
  completedVerb: '1 background agent started',
  countPhrase: (count) => `${workerCount(count)} started`,
};
export const AGENT_WORKERS_FINISHED_GROUP: PluginGroup = {
  key: 'agent-workers:finished',
  name: 'Background agents',
  icon: 'agent-finished',
  activeVerb: 'A background agent is finishing',
  completedVerb: '1 background agent finished without replying',
  // Not "finished". A worker that replied also finished and gets no row here,
  // so the short word would read as the general case and be wrong for it.
  countPhrase: (count) => `${workerCount(count)} finished without replying`,
};
export const AGENT_WORKERS_FAILED_GROUP: PluginGroup = {
  key: 'agent-workers:failed',
  name: 'Background agents',
  icon: 'agent-failed',
  activeVerb: 'A background agent is failing',
  completedVerb: '1 background agent failed',
  countPhrase: (count) => `${workerCount(count)} failed`,
};

/**
 * The failed group for one diagnostic.
 *
 * A failure row is the reader's whole record of it — the feed does not show
 * the notice body — so a row reading only "1 background agent failed" names
 * nothing anybody can act on, which is the generic code `CLAUDE.md` calls a
 * defect rather than a fallback. The reason rides in the key as well as the
 * phrase, so two failures for one reason still collapse into a row while two
 * different reasons stay two rows: aggregating them would have to drop one of
 * the two reasons to do it.
 */
export function agentWorkersFailedGroup(reason: string | null): PluginGroup {
  if (!reason) return AGENT_WORKERS_FAILED_GROUP;
  return {
    key: `${AGENT_WORKERS_FAILED_GROUP.key}:${reason}`,
    name: AGENT_WORKERS_FAILED_GROUP.name,
    icon: AGENT_WORKERS_FAILED_GROUP.icon,
    activeVerb: AGENT_WORKERS_FAILED_GROUP.activeVerb,
    completedVerb: `1 background agent failed: ${reason}`,
    countPhrase: (count) => `${workerCount(count)} failed: ${reason}`,
  };
}

/**
 * The counted groups by key, so a row rebuilt from a stored `groupKey` can find
 * the phrasing its total needs without the projection carrying a function
 * around on the message.
 */
const COUNTED_GROUPS: ReadonlyMap<string, PluginGroup> = new Map([
  [AGENT_MESSAGES_INBOUND_GROUP.key, AGENT_MESSAGES_INBOUND_GROUP],
  [AGENT_MESSAGES_OUTBOUND_GROUP.key, AGENT_MESSAGES_OUTBOUND_GROUP],
  [AGENT_WORKERS_STARTED_GROUP.key, AGENT_WORKERS_STARTED_GROUP],
  [AGENT_WORKERS_FINISHED_GROUP.key, AGENT_WORKERS_FINISHED_GROUP],
  [AGENT_WORKERS_FAILED_GROUP.key, AGENT_WORKERS_FAILED_GROUP],
]);

/** The group a counted row belongs to, or nothing for the timed majority. */
export function countedGroup(groupKey: string): PluginGroup | undefined {
  const known = COUNTED_GROUPS.get(groupKey);
  if (known) return known;
  // A failure group carries its diagnostic in its key, so it is one group per
  // reason rather than an entry the map could hold.
  if (groupKey.startsWith(`${AGENT_WORKERS_FAILED_GROUP.key}:`)) {
    return agentWorkersFailedGroup(groupKey.slice(AGENT_WORKERS_FAILED_GROUP.key.length + 1));
  }
  return undefined;
}

const AUTOMATIONS_GROUP: PluginGroup = {
  key: 'name:Automations',
  name: 'Automations',
  icon: 'automations',
  ...usedGroupVerbs('Automations'),
};

/**
 * The plugins a reader has no reason to tell apart.
 *
 * Discovery, skills, core, memory, and tables are all Rally thinking about its
 * own workspace; a row per plugin split one thought into five. Workstream and
 * Terminal are both Rally operating a machine on the reader's behalf, which is
 * what "Computer" names. Everything absent from this map keeps its own row —
 * a connector is a place the reader recognizes, and collapsing Slack into
 * Rally would hide the only part of the activity they can act on. A first-party
 * plugin that keeps its own row but needs a dedicated glyph also lives here, so
 * its icon is pinned to its canonical id rather than mutable display-name text.
 */
const GROUPED_PLUGIN_IDS = new Map<string, PluginGroup>([
  ['avalon:agents', {
    key: 'name:Background agents',
    name: 'Background agents',
    icon: 'background-agents',
    ...usedGroupVerbs('Background agents'),
  }],
  ['rally:sidekicks', AUTOMATIONS_GROUP],
  // The id a transcript recorded before the Sidekick rename; a stored row
  // keeps it, so it keeps its glyph.
  ['rally:automations', AUTOMATIONS_GROUP],
  ['rally:core', RALLY_GROUP],
  ['rally:discovery', RALLY_GROUP],
  ['rally:memory', RALLY_GROUP],
  ['rally:multimodal-generation', MULTIMODAL_GENERATION_GROUP],
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
 * Shipped connectors use these manifest names. Custom MCP runs carry an
 * explicit connector type and bypass this inference, because their labels
 * are user input.
 *
 * Recovering the type rather than picking a mark here is what keeps a connector
 * wearing one mark everywhere. `connectorBrandMark` is the single table, and
 * Settings reaches it from the type it already holds.
 */
function connectorTypeForName(displayName: string): string | null {
  const name = displayName.toLowerCase();
  if (name.startsWith('apollo.io')) return 'apollo';
  if (name.startsWith('canva')) return 'canva';
  if (name.startsWith('google')) return 'google';
  if (name.startsWith('slack')) return 'slack';
  if (name.startsWith('github')) return 'github';
  if (name.startsWith('notion')) return 'notion';
  if (name.startsWith('linear')) return 'linear';
  if (name.startsWith('ashby')) return 'ashby';
  if (name.startsWith('fireflies')) return 'fireflies';
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
  connectorType?: string,
): PluginGroup | null {
  if (pluginId) {
    const grouped = GROUPED_PLUGIN_IDS.get(pluginId);
    if (grouped) return grouped;
    if (isUnnamedFirstPartyPlugin(pluginId, displayName)) return RALLY_GROUP;
  }
  if (connectorType === 'custom_mcp' && pluginId) {
    const name = displayName || 'Custom MCP server';
    return { key: `custom_mcp:${pluginId}`, name, icon: 'model-context-protocol', ...usedGroupVerbs(name) };
  }
  // Two connections to the same shipped service — a personal and a workspace Slack —
  // are one place as far as the reader is concerned, so the name is the key
  // rather than the id. It is also the only key the live pre-canonical row and
  // the canonical block that replaces it can both produce: they identify the
  // same plugin by different ids.
  if (displayName) {
    return {
      key: `name:${displayName}`,
      name: displayName,
      icon: connectorIconForName(displayName),
      ...usedGroupVerbs(displayName),
    };
  }
  // A plugin id this table cannot name is not a row. `connection:<uuid>` is the
  // shape that reaches here — a connector block whose plugin activity has not
  // arrived, or never will — and a row reading "connection:9c1f… worked for
  // 0ms" is worse than the tool name this feed already declines to show. It
  // would also key on the id, so the activity landing later would open a second
  // row beside it rather than merging into one.
  return null;
}
