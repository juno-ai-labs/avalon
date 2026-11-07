import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  AGENT_MODEL_FLAG_KEYS,
  AGENT_MODEL_ROLES,
  ProductFeatureFlagKeySchema,
} from '@rally/contracts';
import { describe, expect, it } from 'vitest';
import {
  AZURE_ROUTED_MODEL_ROLES,
  GPT_5_6_SOL_MODEL_ID,
  MANAGED_FLAGS,
  MANAGED_MODELS,
  MODEL_CHOICES,
  ManagedFlagUpdateSchema,
  ManagedModelUpdateSchema,
  modelChoicesForRole,
} from '../src/protocol';

const repositoryDirectory = fileURLToPath(new URL('../../..', import.meta.url));

/**
 * Keys the API Worker deliberately resolves outside Ace, each with the reason
 * it is not a managed product Boolean. This is an allowlist rather than a
 * filter: anything else the Worker serves without an `-enabled` key fails the
 * naming test below rather than quietly falling outside Ace the way
 * `multiple-workspaces-enabled` did.
 */
const NOT_ACE_MANAGED = new Map([
  ['developer-settings', 'a per-device staff toggle, targeted through Wrangler'],
  ['control-tower-refresh-seconds', 'a cadence with no off, so it is not a Boolean'],
]);

/**
 * Every flag key the API resolves, read out of the Worker rather than restated
 * here. The flag modules follow one convention — `const <NAME>_FLAG_KEY =
 * "<key>"` in a `*flags.ts` beside the resolver — so the directory is scanned
 * instead of a file list: `docs/feature-flags.md` says a value with no safe off
 * gets a module of its own beside the others, and a hardcoded list would stop
 * seeing exactly the flag that module adds.
 *
 * Declarations are counted before their values are parsed, and the two counts
 * must agree. A declaration this scan cannot read as a plain quoted literal
 * contributes no key, and a scan that silently returned one fewer key would
 * leave both sides of the comparison below unchanged — passing while the flag
 * it named went unmanaged, which is the exact regression this file exists to
 * prevent. Nothing enforces quote style here (there is no `quotes` ESLint rule
 * and no Prettier config, and Ace's own source is single-quoted), so both
 * styles are read and anything else fails loudly instead of disappearing.
 */
async function servedFlagKeys(): Promise<string[]> {
  const services = `${repositoryDirectory}/apps/api/src/services`;
  const modules = (await readdir(services)).filter((file) => file.endsWith('flags.ts'));
  const keys: string[] = [];
  for (const file of modules) {
    const source = await readFile(`${services}/${file}`, 'utf8');
    const declared = source.match(/(?:const|let|var)\s+[A-Z0-9_]*_FLAG_KEY\b/gu) ?? [];
    const parsed = Array.from(
      source.matchAll(/(?:const|let|var)\s+[A-Z0-9_]*_FLAG_KEY\b[^=\n]*=\s*['"]([^'"]+)['"]/gu),
      (match) => match[1]!,
    );
    expect(
      parsed.length,
      `${file} declares a *_FLAG_KEY whose value this scan cannot read as a quoted string literal. `
        + 'Give it a plain literal, or teach this scan the new form — do not leave it unread, '
        + 'because an unread declaration is a flag nobody manages.',
    ).toBe(declared.length);
    keys.push(...parsed);
  }
  return [...new Set(keys)].sort();
}

describe('Ace managed flag protocol', () => {
  it('manages every client-visible product Boolean the API serves, and nothing it does not', async () => {
    // The gap this closes runs API → Ace, a direction nothing else checks.
    // The test below pins the catalog to the contracts enum and starts here,
    // so a flag added to the Worker alone passes it while being uncreatable in
    // Flagship, invisible in Ace's list, and rejected by its save route. That is exactly how
    // `multiple-workspaces-enabled` shipped in #464 resolving off for everyone
    // with no way for an operator to turn it on.
    const served = await servedFlagKeys();
    expect(served.filter((key) => key.endsWith('-enabled')))
      .toEqual([...MANAGED_FLAGS.map((flag) => flag.key)].sort());
  });

  it('refuses a served flag that opts out of Ace by not being named -enabled', async () => {
    // The suffix is what routes a flag to Ace (`docs/ace.md`), so it is also
    // the one thing standing between a new product Boolean and the state this
    // file exists to prevent: a key named `multiple-workspaces` would be
    // unmanaged, permanently off, and invisible to the test above, which only
    // ever looks at `-enabled` keys. Naming an escape hatch is what makes
    // taking it deliberate — a genuinely non-Ace flag is added here with its
    // reason, and everything else fails until it is renamed and registered.
    const served = await servedFlagKeys();
    expect(served.filter((key) => !key.endsWith('-enabled') && !NOT_ACE_MANAGED.has(key)))
      .toEqual([]);
  });

  it('keeps every application boolean explicit about its enabled state', () => {
    expect(MANAGED_FLAGS.map((flag) => flag.key)).toEqual([
      'suggested-work-enabled',
      'multiple-workspaces-enabled',
      'push-notifications-enabled',
    ]);
    expect(MANAGED_FLAGS.map((flag) => flag.key)).toEqual(ProductFeatureFlagKeySchema.options);
    for (const flag of MANAGED_FLAGS) {
      expect(flag.label).toMatch(/ Enabled$/);
      expect(flag.description).toMatch(/^True .+; false .+\.$/);
    }
  });

  it('accepts every documented Flagship operator over the safe targeting vocabulary', () => {
    const operators = ['equals', 'not_equals', 'greater_than', 'less_than', 'greater_than_or_equals',
      'less_than_or_equals', 'contains', 'starts_with', 'ends_with', 'in', 'not_in'];
    for (const operator of operators) {
      expect(ManagedFlagUpdateSchema.safeParse({
        key: 'suggested-work-enabled', description: 'Meeting recording', enabled: true,
        default_variation: 'off', rules: [{ priority: 1, conditions: [{
          attribute: 'userEmailDomain', operator, value: operator.includes('in') ? ['juno-labs.com'] : 'juno-labs.com',
        }], serve_variation: 'on' }],
      }).success).toBe(true);
    }
  });

  it('does not allow a raw email address attribute to reach Flagship', () => {
    expect(ManagedFlagUpdateSchema.safeParse({
      key: 'suggested-work-enabled', description: 'Meeting recording', enabled: true, default_variation: 'off',
      rules: [{ priority: 1, conditions: [{ attribute: 'email', operator: 'equals', value: 'person@example.com' }], serve_variation: 'on' }],
    }).success).toBe(false);
  });

  it('rejects incomplete and empty targeting values', () => {
    const incomplete = (value: string | string[]) => ({
      key: 'suggested-work-enabled', description: 'Meeting Recording Enabled', enabled: true,
      default_variation: 'off', rules: [{ priority: 1, conditions: [{
        attribute: 'workspaceId', operator: Array.isArray(value) ? 'in' : 'equals', value,
      }], serve_variation: 'on' }],
    });

    expect(ManagedFlagUpdateSchema.safeParse(incomplete('')).success).toBe(false);
    expect(ManagedFlagUpdateSchema.safeParse(incomplete([])).success).toBe(false);
    expect(ManagedFlagUpdateSchema.safeParse({
      key: 'suggested-work-enabled', description: 'Meeting Recording Enabled', enabled: true,
      default_variation: 'off', rules: [{ priority: 1, conditions: [{
        logical_operator: 'AND', clauses: [],
      }], serve_variation: 'on' }],
    }).success).toBe(false);
  });

  it('accepts five nested logical groups and rejects a sixth', () => {
    const simple = { attribute: 'workspaceId', operator: 'equals', value: 'workspace-1' } as const;
    const nested = (levels: number): unknown => levels === 0
      ? simple
      : { logical_operator: 'AND', clauses: [nested(levels - 1)] };
    const flag = (conditions: unknown) => ({
      key: 'suggested-work-enabled', description: 'Meeting Recording Enabled', enabled: true,
      default_variation: 'off', rules: [{ priority: 1, conditions: [conditions], serve_variation: 'on' }],
    });

    expect(ManagedFlagUpdateSchema.safeParse(flag(nested(5))).success).toBe(true);
    expect(ManagedFlagUpdateSchema.safeParse(flag(nested(6))).success).toBe(false);
  });
});

describe('Ace managed model protocol', () => {
  it('catalogs every model-using role with its concrete Flagship key', () => {
    expect(MANAGED_MODELS.map(({ role, key }) => ({ role, key }))).toEqual([
      { role: 'workstream', key: 'agent-model-workstream' },
      { role: 'inline_child', key: 'agent-model-inline-child' },
      { role: 'workstream_description', key: 'agent-model-workstream-description' },
      { role: 'workstream_naming', key: 'agent-model-workstream-naming' },
      { role: 'work_opportunity_admission', key: 'agent-model-work-opportunity-admission' },
      { role: 'work_opportunity_ranking', key: 'agent-model-work-opportunity-ranking' },
      { role: 'session_import', key: 'agent-model-session-import' },
      { role: 'suggestion_draft', key: 'agent-model-suggestion-draft' },
      { role: 'memory_sweep', key: 'agent-model-memory-sweep' },
      { role: 'sidekick_authoring', key: 'agent-model-sidekick-authoring' },
    ]);
    expect(MANAGED_MODELS.map((model) => model.rank)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(MANAGED_MODELS.every((model) => model.rankReason.length > 15)).toBe(true);
    expect(new Set(MANAGED_MODELS.map((model) => model.key)).size).toBe(MANAGED_MODELS.length);
    expect(MANAGED_MODELS.every((model) => model.description.length > 60)).toBe(true);
    expect(new Set(MANAGED_MODELS.map((model) => model.role))).toEqual(new Set(AGENT_MODEL_ROLES));
    for (const model of MANAGED_MODELS) {
      expect(model.key, `${model.role} must use the runtime Flagship key`).toBe(AGENT_MODEL_FLAG_KEYS[model.role]);
    }
  });

  it('suggests the checked-in classifier model as well as the reviewed pin list', () => {
    expect(MODEL_CHOICES).toContain('google/gemini-2.5-flash-lite');
    expect(MODEL_CHOICES).toContain('x-ai/grok-4.3');
    expect(MODEL_CHOICES.filter((id) => id.startsWith('openai/gpt-5.6-'))).toEqual([
      'openai/gpt-5.6-sol',
      'openai/gpt-5.6-terra',
      'openai/gpt-5.6-luna',
    ]);
  });

  it('offers Gemini 3.8 Flash to every managed role', () => {
    for (const { role } of MANAGED_MODELS) {
      expect(modelChoicesForRole(role), role).toContain('google/gemini-3.8-flash');
    }
  });

  it('offers Sol only to roles whose complete execution path is Azure-routed', () => {
    expect(AZURE_ROUTED_MODEL_ROLES).toEqual(['inline_child']);
    expect(modelChoicesForRole('inline_child')).toContain(GPT_5_6_SOL_MODEL_ID);
    expect(modelChoicesForRole('workstream')).not.toContain(GPT_5_6_SOL_MODEL_ID);

    expect(ManagedModelUpdateSchema.safeParse({
      role: 'inline_child',
      routing: { model: GPT_5_6_SOL_MODEL_ID, fallbackModels: [] },
    }).success).toBe(true);
    expect(ManagedModelUpdateSchema.safeParse({
      role: 'workstream',
      routing: { model: GPT_5_6_SOL_MODEL_ID, fallbackModels: [] },
    }).success).toBe(false);
    expect(ManagedModelUpdateSchema.safeParse({
      role: 'meeting_notes',
      routing: { model: 'x-ai/grok-4.3', fallbackModels: [GPT_5_6_SOL_MODEL_ID] },
    }).success).toBe(false);
  });

  it('accepts a free-text primary and preserves the ordered fallback array', () => {
    expect(ManagedModelUpdateSchema.parse({
      role: 'workstream_description',
      routing: {
        model: ' custom/provider-primary ',
        fallbackModels: ['custom/first', ' custom/second '],
      },
    })).toEqual({
      role: 'workstream_description',
      routing: {
        model: 'custom/provider-primary',
        fallbackModels: ['custom/first', 'custom/second'],
      },
    });
  });

  it('rejects blank primary and fallback entries', () => {
    expect(ManagedModelUpdateSchema.safeParse({
      role: 'workstream', routing: { model: ' ', fallbackModels: [] },
    }).success).toBe(false);
    expect(ManagedModelUpdateSchema.safeParse({
      role: 'workstream', routing: { model: 'x-ai/grok-4.3', fallbackModels: [' '] },
    }).success).toBe(false);
  });

  it('accepts an explicitly empty or omitted fallback array like the runtime resolver', () => {
    expect(ManagedModelUpdateSchema.parse({
      role: 'workstream', routing: { model: 'x-ai/grok-4.3', fallbackModels: [] },
    }).routing.fallbackModels).toEqual([]);
    expect(ManagedModelUpdateSchema.parse({
      role: 'workstream', routing: { model: 'x-ai/grok-4.3' },
    }).routing.fallbackModels).toEqual([]);
  });
});
