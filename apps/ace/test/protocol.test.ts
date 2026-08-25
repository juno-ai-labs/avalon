import { ProductFeatureFlagKeySchema } from '@avalon/contracts';
import { describe, expect, it } from 'vitest';
import { MANAGED_FLAGS, ManagedFlagUpdateSchema } from '../src/protocol';

describe('Ace managed flag protocol', () => {
  it('keeps every application boolean explicit about its enabled state', () => {
    expect(MANAGED_FLAGS.map((flag) => flag.key)).toEqual([
      'hypersight-enabled',
      'meeting-recording-enabled',
      'suggested-work-enabled',
      'automation-workspace-templates-enabled',
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
