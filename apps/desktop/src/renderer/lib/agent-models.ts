import { AGENT_MODEL_OVERRIDES, type AgentModelOverride } from '@avalon/contracts';

export type { AgentModelOverride };

/**
 * The unpinned state, as a radio value the menu can carry.
 *
 * It is deliberately not the first model in the list. Which model an unpinned
 * work stream runs on is decided by the `agent-model-workstream` flag, and the
 * renderer cannot see the served variation — so naming a model here would be a
 * claim this process is not in a position to make, and would be wrong for
 * exactly the audience this control exists for the moment the flag is rolled
 * anywhere else. Keeping the two states distinct also leaves every model in the
 * list, including the first, available as a deliberate choice.
 */
export const UNPINNED_AGENT_MODEL = 'unpinned';
export const UNPINNED_AGENT_MODEL_LABEL = 'Default';

/**
 * The trigger's accessible name and tooltip. Unpinned says which mechanism is
 * in charge instead of naming a model, because that is the honest thing this
 * process can say — and it is what makes an explicit pin to the first listed
 * model observably different from never having touched the control.
 */
export function agentModelTriggerLabel(id: AgentModelOverride | null): string {
  return id === null
    ? `Model: ${UNPINNED_AGENT_MODEL_LABEL} (follows the agent-model-workstream flag)`
    : `Model: ${PRESENTATION[id].label}`;
}

interface AgentModelPresentation {
  provider: string;
  label: string;
}

/**
 * How each id reads in the menu. Split into a provider and a short name rather
 * than shown as the raw OpenRouter id: nine ids from four vendors are a wall of
 * slashes, and the trigger has room for a name but not for a path.
 *
 * Exhaustive over the contract's list by type, so adding a model there fails
 * the build here rather than shipping a selector entry labelled with its id.
 */
const PRESENTATION: Readonly<Record<AgentModelOverride, AgentModelPresentation>> = {
  'x-ai/grok-4.3': { provider: 'xAI', label: 'Grok 4.3' },
  'x-ai/grok-4.5': { provider: 'xAI', label: 'Grok 4.5' },
  'google/gemini-3.6-flash': { provider: 'Google', label: 'Gemini 3.6 Flash' },
  'google/gemini-3.5-flash': { provider: 'Google', label: 'Gemini 3.5 Flash' },
  'google/gemini-3-flash-preview': { provider: 'Google', label: 'Gemini 3 Flash Preview' },
  'openai/gpt-5.6-terra': { provider: 'OpenAI', label: 'GPT-5.6 Terra' },
  'openai/gpt-5.6-luna': { provider: 'OpenAI', label: 'GPT-5.6 Luna' },
  'deepseek/deepseek-v4-pro': { provider: 'DeepSeek', label: 'DeepSeek V4 Pro' },
  'deepseek/deepseek-v4-flash-0731': { provider: 'DeepSeek', label: 'DeepSeek V4 Flash 0731' },
};

export interface AgentModelChoice extends AgentModelPresentation {
  id: AgentModelOverride;
}

/** Every selectable model, in the contract's order. */
export const AGENT_MODEL_CHOICES: readonly AgentModelChoice[] = AGENT_MODEL_OVERRIDES.map((id) => ({
  id,
  ...PRESENTATION[id],
}));

/**
 * The same models grouped under their vendor for the menu. Grouping is derived
 * from the order above rather than sorted, so the default stays at the top and
 * a model's neighbours are the ones the contract listed it beside.
 */
export const AGENT_MODEL_GROUPS: ReadonlyArray<{ provider: string; models: AgentModelChoice[] }> =
  AGENT_MODEL_CHOICES.reduce<Array<{ provider: string; models: AgentModelChoice[] }>>((groups, choice) => {
    const current = groups.at(-1);
    if (current?.provider === choice.provider) current.models.push(choice);
    else groups.push({ provider: choice.provider, models: [choice] });
    return groups;
  }, []);

/** The name a pinned model wears, or `Default` where nothing is pinned. */
export function agentModelLabel(id: AgentModelOverride | null): string {
  return id === null ? UNPINNED_AGENT_MODEL_LABEL : PRESENTATION[id].label;
}
