import {
  AGENT_MODEL_OVERRIDES,
  AGENT_MODEL_ROLES,
  AgentModelRoutingSchema,
  ProductFeatureFlagKeySchema,
  type AgentModelRole,
  type AgentModelRouting,
  type AGENT_MODEL_FLAG_KEYS,
} from '@rally/contracts';
import { z } from 'zod';

export const MODEL_CHOICES = [
  ...AGENT_MODEL_OVERRIDES,
  // The small classifier/structured default is not in the work-stream pin
  // selector above, but it is a first-class option for Ace's fleet routing.
  'google/gemini-2.5-flash-lite',
] as const;

export const GPT_5_6_SOL_MODEL_ID = 'openai/gpt-5.6-sol' as const;

/**
 * These roles reach Bind with the regional Azure transport and pricing port.
 * Every other role currently constructs a direct OpenRouter request somewhere
 * in its execution path, so Ace must not let Sol enter that route.
 */
export const AZURE_ROUTED_MODEL_ROLES = [
  'inline_child',
] as const satisfies readonly AgentModelRole[];
const AZURE_ROUTED_MODEL_ROLE_SET = new Set<AgentModelRole>(AZURE_ROUTED_MODEL_ROLES);

export function modelIsAllowedForRole(role: AgentModelRole, modelId: string): boolean {
  return modelId !== GPT_5_6_SOL_MODEL_ID || AZURE_ROUTED_MODEL_ROLE_SET.has(role);
}

export function modelChoicesForRole(role: AgentModelRole): readonly string[] {
  return MODEL_CHOICES.filter((modelId) => modelIsAllowedForRole(role, modelId));
}

interface ManagedModelDefinition {
  rank: number;
  rankReason: string;
  role: AgentModelRole;
  key: (typeof AGENT_MODEL_FLAG_KEYS)[AgentModelRole];
  label: string;
  description: string;
  defaultRouting: AgentModelRouting;
}

/**
 * Ace cannot discover model roles from the deployed Worker: Flagship stores
 * only opaque flag keys and route-plan values. This catalog is deliberately
 * hard-coded from every role in `apps/api/src/services/agent-model-flags.ts`
 * and the call sites behind it, so the operator sees what a model actually
 * does rather than an internal enum name.
 */
export const MANAGED_MODELS = [
  {
    rank: 1,
    rankReason: 'Core path · every main run',
    role: 'workstream',
    key: 'agent-model-workstream',
    label: 'Conversation agent',
    description: 'Runs a Canvas\'s Chat or a Sidekick\'s conversation and the structured attachment-summary pass: reasons over transcripts, calls tools, and streams answers.',
    defaultRouting: { model: 'openai/gpt-6.1-sol', fallbackModels: ['google/gemini-3.8-flash'] },
  },
  {
    rank: 2,
    rankReason: 'Core path · delegated work',
    role: 'inline_child',
    key: 'agent-model-inline-child',
    label: 'Inline subagent',
    description: 'Runs a bounded read-only child task delegated by a Canvas chat\'s or Sidekick conversation\'s agent and returns the result to its parent.',
    defaultRouting: { model: 'openai/gpt-6.1-sol', fallbackModels: ['google/gemini-3.8-flash'] },
  },

  {
    rank: 3,
    rankReason: 'Frequent · each paste that becomes an attachment',
    role: 'workstream_naming',
    key: 'agent-model-workstream-naming',
    label: 'Pasted-text naming',
    description: 'Titles a long pasted text from its contents, so the attachment chip has a name.',
    defaultRouting: { model: 'google/gemini-2.5-flash-lite', fallbackModels: ['google/gemini-3.8-flash'] },
  },
  {
    rank: 4,
    rankReason: 'Background · one call per rested conversation window',
    role: 'memory_sweep',
    key: 'agent-model-memory-sweep',
    label: 'Memory sweep',
    description: 'Reads a window of a Canvas or Sidekick conversation after it settles and decides which facts Rally should remember, revise or retract; the judgment is what a colleague would need later, so it runs on a strong model.',
    defaultRouting: { model: 'openai/gpt-6.1-sol', fallbackModels: ['google/gemini-3.8-flash'] },
  },
  {
    rank: 5,
    rankReason: 'On demand · Sidekick setup and editing',
    role: 'sidekick_authoring',
    key: 'agent-model-sidekick-authoring',
    label: 'Sidekick wizard',
    description: 'Creates and revises Sidekick definitions in their authoring conversations, including event bindings, schedules, tools, and durable run instructions.',
    defaultRouting: { model: 'openai/gpt-6.1-sol', fallbackModels: ['google/gemini-3.8-flash'] },
  },
] as const satisfies readonly ManagedModelDefinition[];

export const ManagedModelRoleSchema = z.enum(AGENT_MODEL_ROLES);
export type ManagedModelRole = AgentModelRole;
export { AgentModelRoutingSchema };
export type { AgentModelRouting };

export const ManagedModelUpdateSchema = z.object({
  role: ManagedModelRoleSchema,
  routing: AgentModelRoutingSchema,
}).strict().superRefine((update, context) => {
  for (const [index, modelId] of [update.routing.model, ...update.routing.fallbackModels].entries()) {
    if (modelIsAllowedForRole(update.role, modelId)) continue;
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'GPT-5.6 Sol is available only for roles whose complete path is routed through Azure.',
      path: index === 0 ? ['routing', 'model'] : ['routing', 'fallbackModels', index - 1],
    });
  }
});

export type ManagedModelUpdate = z.infer<typeof ManagedModelUpdateSchema>;

export const ModelValidationRequestSchema = z.object({
  modelIds: z.array(z.string().trim().min(1)),
}).strict();

/**
 * `defaultVariation` is the one fact `apps/ace/scripts/deploy.mjs` and the
 * client editor must never disagree on. `deploy.mjs` runs under plain Node rather
 * than through Vite, so it cannot import this table and read it at runtime;
 * keep its `ensureFlag` calls in step with this table by hand.
 */
export const MANAGED_FLAGS = [
  { key: 'suggested-work-enabled', label: 'Suggested Work Enabled', description: 'True shows Suggested Work surfaces in Electron; false hides them without changing API availability.', defaultVariation: 'off' },
  { key: 'multiple-workspaces-enabled', label: 'Multiple Workspaces Enabled', description: 'True shows workspace switching, invitations, creation, and background attention in Electron; false hides them without changing API availability.', defaultVariation: 'off' },
  { key: 'push-notifications-enabled', label: 'Push Notifications Enabled', description: 'True enables Apple push delivery and the desktop Notifications setting for everyone from launch; false pauses push for the targeted users.', defaultVariation: 'on' },
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

/**
 * The private RPC Ace exports as `FlagAdministration` for the engineering MCP
 * (`docs/engineering-mcp.md`). It is the same managed catalogs and the same
 * write functions as the Ace pages, so a flag changed from either place is
 * validated, written and fanned out once, by one Worker. Only a Worker holding
 * the Service Binding can call it; the caller passes the verified Access
 * identity of the engineer it acts for, which Ace records on every write.
 */
export interface FlagAdministrationActor {
  subject: string;
}

export type FlagAdministrationResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: string; message: string };

/** A catalog entry beside Flagship's live definition, `null` when not provisioned. */
export type ManagedProductFlagState = (typeof MANAGED_FLAGS)[number] & { flag: unknown };
export type ManagedModelFlagState = (typeof MANAGED_MODELS)[number] & { flag: unknown };

export interface FlagAdministrationRpc {
  listProductFlags(): Promise<FlagAdministrationResult<ManagedProductFlagState[]>>;
  updateProductFlag(input: { actor: FlagAdministrationActor; update: unknown }): Promise<FlagAdministrationResult<unknown>>;
  listModelFlags(): Promise<FlagAdministrationResult<ManagedModelFlagState[]>>;
  updateModelRouting(input: { actor: FlagAdministrationActor; update: unknown }): Promise<FlagAdministrationResult<unknown>>;
}
