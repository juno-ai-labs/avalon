import { ProductFeatureFlagKeySchema } from '@avalon/contracts';
import { z } from 'zod';

export const MANAGED_FLAGS = [
  { key: 'hypersight-enabled', label: 'HyperSight Enabled', description: 'True shows HyperSight surfaces in Electron; false hides them without changing API availability.' },
  { key: 'meeting-recording-enabled', label: 'Meeting Recording Enabled', description: 'True shows meeting-recording actions in Electron; false hides them without changing API availability.' },
  { key: 'suggested-work-enabled', label: 'Suggested Work Enabled', description: 'True shows Suggested Work surfaces in Electron; false hides them without changing API availability.' },
  { key: 'automation-workspace-templates-enabled', label: 'Automation Workspace Templates Enabled', description: 'True shows workspace-template surfaces in Electron; false hides them without changing API availability.' },
] as const;

export const FLAG_ATTRIBUTES = [
  { key: 'userPlatformId', label: 'Specific user', type: 'string' },
  { key: 'workspaceId', label: 'Workspace', type: 'string' },
  { key: 'userEmailDomain', label: 'User email domain', type: 'string' },
  { key: 'workspaceOwnerEmailDomain', label: 'Workspace owner domain', type: 'string' },
  { key: 'userRole', label: 'Workspace role', type: 'string' },
  { key: 'workspaceSlug', label: 'Workspace slug', type: 'string' },
  { key: 'workspaceMemberCount', label: 'Workspace member count', type: 'number' },
  { key: 'workspaceAgeDays', label: 'Workspace age in days', type: 'number' },
  { key: 'region', label: 'Region', type: 'string' },
  { key: 'appEnv', label: 'Application environment', type: 'string' },
] as const;

const AttributeSchema = z.enum(FLAG_ATTRIBUTES.map((attribute) => attribute.key) as [string, ...string[]]);
const OperatorSchema = z.enum([
  'equals', 'not_equals', 'greater_than', 'less_than', 'greater_than_or_equals',
  'less_than_or_equals', 'contains', 'starts_with', 'ends_with', 'in', 'not_in',
]);

export type AceCondition = {
  attribute?: string;
  operator?: z.infer<typeof OperatorSchema>;
  value?: string | number | Array<string | number>;
  logical_operator?: 'AND' | 'OR';
  clauses?: AceCondition[];
};

// Cloudflare Flagship limits, checked 2026-08-24:
// https://developers.cloudflare.com/flagship/reference/limits/
export const MAX_CONDITION_DEPTH = 5;
export const MAX_CONDITION_STRING_LENGTH = 256;
export const MAX_FLAG_DESCRIPTION_LENGTH = 512;

export const ConditionSchema: z.ZodType<AceCondition> = z.lazy(() => z.union([
  z.object({ attribute: AttributeSchema, operator: OperatorSchema, value: z.union([
    z.string().min(1).max(MAX_CONDITION_STRING_LENGTH), z.number(),
    z.array(z.union([z.string().min(1).max(MAX_CONDITION_STRING_LENGTH), z.number()])).min(1),
  ]) }).strict(),
  z.object({
    logical_operator: z.enum(['AND', 'OR']),
    clauses: z.array(ConditionSchema).min(1),
  }).strict(),
]));

export const FlagRuleSchema = z.object({
  priority: z.number().int().min(1),
  conditions: z.array(ConditionSchema),
  serve_variation: z.enum(['on', 'off']),
  rollout: z.object({ percentage: z.number().min(0).max(100), attribute: AttributeSchema.optional() }).optional(),
}).strict();

export const ManagedFlagUpdateSchema = z.object({
  key: ProductFeatureFlagKeySchema,
  description: z.string().max(MAX_FLAG_DESCRIPTION_LENGTH),
  enabled: z.boolean(),
  default_variation: z.enum(['on', 'off']),
  rules: z.array(FlagRuleSchema),
}).strict().superRefine((flag, context) => {
  const validateDepth = (condition: AceCondition, depth: number): void => {
    if (!condition.clauses) return;
    if (depth > MAX_CONDITION_DEPTH) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Targeting conditions may be nested at most ${MAX_CONDITION_DEPTH} levels.`,
      });
      return;
    }
    for (const clause of condition.clauses) validateDepth(clause, depth + 1);
  };
  for (const rule of flag.rules) {
    for (const condition of rule.conditions) validateDepth(condition, 1);
  }
});

export type ManagedFlagUpdate = z.infer<typeof ManagedFlagUpdateSchema>;
