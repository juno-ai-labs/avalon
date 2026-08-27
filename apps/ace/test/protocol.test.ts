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

describe('Ace managed flag protocol', () => {
  it('keeps every application boolean explicit about its enabled state', () => {
    expect(MANAGED_FLAGS.map((flag) => flag.key)).toEqual([
      'hypersight-enabled',
      'meeting-recording-enabled',
      'suggested-work-enabled',
      'automation-workspace-templates-enabled',
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
      { role: 'activity_structured', key: 'agent-model-activity-structured' },
      { role: 'work_opportunity_admission', key: 'agent-model-work-opportunity-admission' },
      { role: 'work_opportunity_ranking', key: 'agent-model-work-opportunity-ranking' },
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
