import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  AGENT_MODEL_FLAG_KEYS,
  AGENT_MODEL_ROLES,
  ProductFeatureFlagKeySchema,
} from '@rally/contracts';
import { describe, expect, it } from 'vitest';
import {
  MANAGED_FLAGS,
  MANAGED_MODELS,
  MODEL_CHOICES,
  ManagedFlagUpdateSchema,
  ManagedModelUpdateSchema,
} from '../src/protocol';

const repositoryDirectory = fileURLToPath(new URL('../../..', import.meta.url));

/**
 * Every product-Boolean key the API resolves, read out of the Worker rather
 * than restated here. The four flag modules follow one naming convention —
 * `<NAME>_FLAG_KEY = "<key>"` in a `*flags.ts` beside the resolver — so the
 * directory is scanned instead of a file list: `docs/feature-flags.md` says a
 * value with no safe off gets a module of its own beside the others, and a
 * hardcoded list would stop seeing exactly the flag that module adds.
 *
 * Filtering on the `-enabled` suffix is Ace's own invariant, not a convenience
 * (`docs/ace.md`): a product Boolean's key ends in `-enabled` so `true` means
 * one thing everywhere. `developer-settings` and `control-tower-refresh-seconds`
 * fall outside it by that rule rather than by being skipped — the first is a
 * per-device staff toggle driven through Wrangler, the second a cadence with no
 * off. Either one renamed to `-enabled` becomes Ace's to manage, which is the
 * right answer.
 */
async function servedProductBooleanKeys(): Promise<string[]> {
  const services = `${repositoryDirectory}/apps/api/src/services`;
  const modules = (await readdir(services)).filter((file) => file.endsWith('flags.ts'));
  const sources = await Promise.all(modules.map(async (file) => readFile(`${services}/${file}`, 'utf8')));
  const keys = sources.flatMap((source) => Array.from(
    source.matchAll(/_FLAG_KEY = "([^"]+)"/gu),
    (match) => match[1]!,
  ));
  return [...new Set(keys.filter((key) => key.endsWith('-enabled')))].sort();
}

describe('Ace managed flag protocol', () => {
  it('manages every client-visible product Boolean the API serves, and nothing it does not', async () => {
    // The gap this closes runs API → Ace, and it is the only direction nothing
    // else checks. `deployment-contract.test.ts` walks outward from this
    // catalog to `deploy.mjs`, and the test below pins the catalog to the
    // contracts enum — both start here, so a flag added to the Worker alone
    // passes every one of them while being uncreatable in Flagship, invisible
    // in Ace's list, and rejected by its save route. That is exactly how
    // `multiple-workspaces-enabled` shipped in #464 resolving off for everyone
    // with no way for an operator to turn it on.
    expect(await servedProductBooleanKeys()).toEqual([...MANAGED_FLAGS.map((flag) => flag.key)].sort());
  });

  it('keeps every application boolean explicit about its enabled state', () => {
    expect(MANAGED_FLAGS.map((flag) => flag.key)).toEqual([
      'hypersight-enabled',
      'meeting-recording-enabled',
      'suggested-work-enabled',
      'automation-workspace-templates-enabled',
      'multiple-workspaces-enabled',
      'digests-enabled',
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
        key: 'meeting-recording-enabled', description: 'Meeting recording', enabled: true,
        default_variation: 'off', rules: [{ priority: 1, conditions: [{
          attribute: 'userEmailDomain', operator, value: operator.includes('in') ? ['juno-labs.com'] : 'juno-labs.com',
        }], serve_variation: 'on' }],
      }).success).toBe(true);
    }
  });

  it('does not allow a raw email address attribute to reach Flagship', () => {
    expect(ManagedFlagUpdateSchema.safeParse({
      key: 'hypersight-enabled', description: 'HyperSight', enabled: true, default_variation: 'off',
      rules: [{ priority: 1, conditions: [{ attribute: 'email', operator: 'equals', value: 'person@example.com' }], serve_variation: 'on' }],
    }).success).toBe(false);
  });

  it('rejects incomplete and empty targeting values', () => {
    const incomplete = (value: string | string[]) => ({
      key: 'meeting-recording-enabled', description: 'Meeting Recording Enabled', enabled: true,
      default_variation: 'off', rules: [{ priority: 1, conditions: [{
        attribute: 'workspaceId', operator: Array.isArray(value) ? 'in' : 'equals', value,
      }], serve_variation: 'on' }],
    });

    expect(ManagedFlagUpdateSchema.safeParse(incomplete('')).success).toBe(false);
    expect(ManagedFlagUpdateSchema.safeParse(incomplete([])).success).toBe(false);
    expect(ManagedFlagUpdateSchema.safeParse({
      key: 'hypersight-enabled', description: 'HyperSight Enabled', enabled: true,
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
      key: 'hypersight-enabled', description: 'HyperSight Enabled', enabled: true,
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
      { role: 'addressing_classifier', key: 'agent-model-addressing-classifier' },
      { role: 'inline_child', key: 'agent-model-inline-child' },
      { role: 'workstream_description', key: 'agent-model-workstream-description' },
      { role: 'workstream_naming', key: 'agent-model-workstream-naming' },
      { role: 'automation_compiler', key: 'agent-model-automation-compiler' },
      { role: 'meeting_notes', key: 'agent-model-meeting-notes' },
      { role: 'work_opportunity_admission', key: 'agent-model-work-opportunity-admission' },
      { role: 'work_opportunity_ranking', key: 'agent-model-work-opportunity-ranking' },
      { role: 'automation_result_disposition', key: 'agent-model-automation-result-disposition' },
      { role: 'block_dashboard', key: 'agent-model-block-dashboard' },
    ]);
    expect(MANAGED_MODELS.map((model) => model.rank)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
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
