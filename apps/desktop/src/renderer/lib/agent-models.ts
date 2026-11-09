import { AGENT_MODEL_OVERRIDES, type AgentModelOverride } from '@rally/contracts';

/** Whether a served model id is one the selector's closed list admits. */
function isAgentModelOverride(model: string): model is AgentModelOverride {
  return (AGENT_MODEL_OVERRIDES as readonly string[]).includes(model);
}

/**
 * What the pill says where no model is known. Which model an unpinned
 * conversation runs on is decided by the `agent-model-workstream` flag, and the
 * renderer cannot see the served variation, so it names none.
 */
const UNPINNED_AGENT_MODEL_LABEL = 'Default';

/**
 * How each pinnable id reads on the pill: a short name rather than the raw
 * OpenRouter id, since the pill has room for a name but not for a path.
 * Exhaustive over the contract's list by type, so adding a model there fails
 * the build here rather than shipping a pill labelled with its id.
 */
const LABELS: Readonly<Record<AgentModelOverride, string>> = {
  'x-ai/grok-4.6': 'Grok 4.6',
  'x-ai/grok-4.5': 'Grok 4.5',
  'x-ai/grok-4.3': 'Grok 4.3',
  'google/gemini-3.8-flash': 'Gemini 3.8 Flash',
  'google/gemini-3.7-flash': 'Gemini 3.7 Flash',
  'google/gemini-3.6-flash': 'Gemini 3.6 Flash',
  'google/gemini-3.5-flash': 'Gemini 3.5 Flash',
  'google/gemini-3-flash-preview': 'Gemini 3 Flash Preview',
  'openai/gpt-5.6-sol': 'GPT-5.6 Sol',
  'openai/gpt-5.6-terra': 'GPT-5.6 Terra',
  'openai/gpt-5.6-luna': 'GPT-5.6 Luna',
  'deepseek/deepseek-v4-pro': 'DeepSeek V4 Pro',
  'deepseek/deepseek-v4-flash-0731': 'DeepSeek V4 Flash 0731',
};

/**
 * The name to show for the model a conversation is *already* running on.
 *
 * That id is not necessarily one of the ids a pin may name: it is read off the
 * conversation's latest run, and an unpinned conversation runs on whatever
 * `agent-model-workstream` served it — any OpenRouter id the flag's variation
 * carries. A known id gets its short name; anything else
 * falls back to the id's own model segment, because the vendor prefix costs
 * half a pill's width to repeat what the name already implies. The full id
 * stays in the tooltip either way.
 *
 * Null is a conversation with neither a recorded run model nor a pin, where the
 * flag decides and this process cannot see the served variation.
 */
export function agentModelInUseLabel(model: string | null): string {
  // Blank counts as absent. Nothing constrains `harness_runs.model` to be
  // non-empty, and a pill showing an empty string is worse than one saying it
  // does not know.
  if (model === null || model.trim() === '') return UNPINNED_AGENT_MODEL_LABEL;
  if (isAgentModelOverride(model)) return LABELS[model];
  return model.slice(model.lastIndexOf('/') + 1);
}

/**
 * The accessible name and tooltip for that same pill. It carries the exact id rather than the shortened name — the pill
 * is a glance, this is the answer — and says why the control does not open,
 * because a control that looks like the composer's and does nothing has to
 * explain itself.
 *
 * `pinned` is the difference between two claims only one of which is true of any
 * given conversation, and conflating them is a promise the server does not keep.
 * A pin is fixed: `resolveWorkstreamModelRouting` finds it on the row and never
 * consults the flag, so every run of that conversation uses it. An **unpinned**
 * conversation re-evaluates `agent-model-workstream` on *every* launch, so the
 * id shown is what the latest run happened to get and a later run may differ.
 * What is immutable there is the setting, not the model.
 *
 * "Conversation" rather than "work stream" because a substream carries a pin of
 * its own now and shows this same pill; naming the parent's kind in a child's
 * tooltip would describe the wrong row.
 *
 * The tooltip still fires on the disabled pill: a disabled button swallows
 * clicks, but Radix's tooltip is driven by pointer movement that still reaches it.
 * Keyboard focus is the route that does go — Tab skips a disabled button — so
 * this string has to stand on its own as the accessible name too.
 */
export function agentModelInUseTriggerLabel(model: string | null, pinned: boolean): string {
  if (model !== null && model.trim() === '') model = null;
  if (pinned && model !== null) {
    return `Model: ${model} — pinned when this conversation was created, so every run uses it. It cannot be changed.`;
  }
  const subject = model === null
    ? `${UNPINNED_AGENT_MODEL_LABEL} (no run yet)`
    : `${model} (the latest run's)`;
  return `Model: ${subject} — unpinned, so the agent-model-workstream flag decides each run and a later run may differ. It cannot be set here.`;
}
