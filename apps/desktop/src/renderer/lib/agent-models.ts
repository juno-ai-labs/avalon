import { AGENT_MODEL_OVERRIDES, type AgentModelOverride } from '@avalon/contracts';

/** Whether a served model id is one the selector's closed list admits. */
function isAgentModelOverride(model: string): model is AgentModelOverride {
  return (AGENT_MODEL_OVERRIDES as readonly string[]).includes(model);
}

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
 * The same models grouped under their vendor for the menu, each provider
 * appearing once, in the order the contract first mentions it.
 *
 * One group per provider rather than one per adjacent run: the provider is the
 * React key for its section, so a list that mentioned a vendor in two separate
 * places would otherwise render duplicate keys among siblings. The contract
 * happens to keep each vendor's models together today, and this does not
 * depend on it continuing to.
 */
export const AGENT_MODEL_GROUPS: ReadonlyArray<{ provider: string; models: AgentModelChoice[] }> =
  AGENT_MODEL_CHOICES.reduce<Array<{ provider: string; models: AgentModelChoice[] }>>((groups, choice) => {
    const existing = groups.find((group) => group.provider === choice.provider);
    if (existing) existing.models.push(choice);
    else groups.push({ provider: choice.provider, models: [choice] });
    return groups;
  }, []);

/** The name a pinned model wears, or `Default` where nothing is pinned. */
export function agentModelLabel(id: AgentModelOverride | null): string {
  return id === null ? UNPINNED_AGENT_MODEL_LABEL : PRESENTATION[id].label;
}

/**
 * The name to show for the model a work stream is *already* running on.
 *
 * That id is not necessarily one of the nine a pin may name: it is read off the
 * work stream's latest run, and an unpinned work stream runs on whatever
 * `agent-model-workstream` served it — any OpenRouter id the flag's variation
 * carries. A known id gets the same short name the menu gives it, so a pinned
 * work stream reads identically to the composer that pinned it; anything else
 * falls back to the id's own model segment, because the vendor prefix costs
 * half a pill's width to repeat what the name already implies. The full id
 * stays in the tooltip either way.
 *
 * Null is a work stream with neither a recorded run model nor a pin, where the
 * honest answer is the same as an untouched composer's: the flag decides, and
 * this process cannot see the served variation.
 */
export function agentModelInUseLabel(model: string | null): string {
  if (model === null) return UNPINNED_AGENT_MODEL_LABEL;
  if (isAgentModelOverride(model)) return PRESENTATION[model].label;
  return model.slice(model.lastIndexOf('/') + 1);
}

/**
 * The accessible name and tooltip for that same pill once its trigger is
 * disabled. It carries the exact id rather than the shortened name — the pill
 * is a glance, this is the answer — and says why the control does not open,
 * because a control that looks like the composer's and does nothing has to
 * explain itself.
 *
 * The tooltip still fires on the disabled trigger. That is worth knowing rather
 * than assuming: a disabled button swallows clicks, which is what keeps the menu
 * shut, but Radix's tooltip is driven by pointer movement that still reaches it.
 * Keyboard focus is the route that does go — Tab skips a disabled button — so
 * this string has to stand on its own as the accessible name too.
 */
export function agentModelInUseTriggerLabel(model: string | null): string {
  const subject = model === null
    ? `${UNPINNED_AGENT_MODEL_LABEL} (follows the agent-model-workstream flag)`
    : model;
  return `Model: ${subject} — a work stream keeps the model it started on, so this cannot be changed`;
}
