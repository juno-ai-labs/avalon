import {
  AutomationPluginActivitySchema,
  ResourceDirectionSchema,
  ResourceRelationshipTypeSchema,
} from '@rally/contracts';
import { z } from 'zod';

const scopeSchema = z.enum(['you', 'workspace']);
const harnessStatusSchema = z.enum(['scheduled', 'running', 'needs_input', 'completed', 'failed', 'stopped']);

export const workspaceMemberSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    email: z.string(),
    avatarUrl: z.string().optional(),
    role: z.string().optional(),
    accent: z.string().optional(),
    viewing: z.boolean().optional(),
  })
  .passthrough();

export const workspaceSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    region: z.enum(['global', 'eu']),
    currentUser: workspaceMemberSchema,
  })
  .passthrough();

export const automationSummarySchema = z
  .object({
    id: z.string(),
    name: z.string(),
    scope: scopeSchema,
    status: z.enum(['active', 'paused', 'draft']),
    nextRunAt: z.string().optional(),
    lastRunAt: z.string().optional(),
    statusMessage: z.string().optional(),
  })
  .passthrough();

export const workstreamSummarySchema = z
  .object({
    id: z.string(),
    title: z.string(),
    objective: z.string().optional(),
    origin: z.enum(['ad_hoc', 'automation']),
    automationName: z.string().optional(),
    harnessStatus: harnessStatusSchema,
    latestAttentionSequenceNumber: z.number().default(0),
    readThroughSequenceNumber: z.number().default(0),
    manualUnreadFromSequenceNumber: z.number().nullable().default(null),
    manualUnreadGeneration: z.number().default(0),
    hasUnread: z.boolean().default(false),
    firstUnreadSequenceNumber: z.number().nullable().default(null),
    lastActivityAt: z.string(),
    plannedFor: z.string().optional(),
    preview: z.string().optional(),
  })
  .passthrough();

export const resourceSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    resourceType: z.string(),
    provider: z.string().optional(),
    mimeType: z.string().optional(),
    canonicalUrl: z.string().optional(),
    refreshSupported: z.boolean().default(false),
    watchEnabled: z.boolean().default(false),
    watchStatus: z.enum(['watching', 'paused', 'unsupported', 'error']).default('paused'),
    updatedAt: z.string().optional(),
    currentVersion: z.number().int().positive().default(1),
    relationshipType: ResourceRelationshipTypeSchema.default('attachment'),
    direction: ResourceDirectionSchema.default('source'),
  })
  .passthrough();

export const connectionSchema = z
  .object({
    id: z.string(),
    connectorType: z.string(),
    displayName: z.string(),
    scope: scopeSchema,
    ownerName: z.string().optional(),
    status: z.enum(['healthy', 'reconnect_required', 'disabled']),
    capabilities: z.array(z.string()).optional(),
  })
  .passthrough();

export const toolEventSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    summary: z.string().optional(),
    status: z.enum(['started', 'completed', 'failed', 'ambiguous']),
    durationMs: z.number().optional(),
    toolType: z.string().optional(),
    plugin: AutomationPluginActivitySchema.optional(),
    input: z.unknown().optional(),
    output: z.unknown().optional(),
  })
  .passthrough();

export const messageSchema = z
  .object({
    id: z.string(),
    workstreamId: z.string(),
    sequenceNumber: z.number(),
    attentionSequenceNumber: z.number().int().positive().nullable().optional(),
    authorType: z.enum(['human', 'external', 'agent', 'system']),
    author: workspaceMemberSchema.optional(),
    externalActor: z.object({
      provider: z.string(),
      providerAccountId: z.string(),
      providerUserId: z.string(),
      displayName: z.string(),
      avatarUrl: z.string().nullable(),
    }).optional(),
    messageType: z.enum([
      'text',
      'tool_event',
      'elicitation',
      'activity_suggestion',
      'system',
    ]),
    text: z.string().optional(),
    createdAt: z.string(),
    streaming: z.boolean().optional(),
    toolEvent: toolEventSchema.optional(),
    elicitation: z
      .object({
        id: z.string(),
        prompt: z.string(),
        responseType: z.enum(['text', 'radio', 'single_select', 'multi_select']),
        options: z
          .array(
            z.object({
              label: z.string(),
              value: z.string(),
              description: z.string().optional(),
            }),
          )
          .optional(),
        minimumSelections: z.number().optional(),
        maximumSelections: z.number().optional(),
        targetUserId: z.string().optional(),
        status: z.enum(['open', 'answered']),
        answer: z.unknown().optional(),
        answeredByName: z.string().optional(),
      })
      .passthrough()
      .optional(),
    activitySuggestion: z
      .object({
        id: z.string(),
        title: z.string(),
        source: z.string().optional(),
        occurredAt: z.string().optional(),
        reason: z.string(),
        status: z.enum(['pending', 'accepted', 'dismissed']),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const participantSchema = workspaceMemberSchema;

export const backgroundTaskSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    type: z.enum(['agent', 'tool', 'connector']),
    status: z.enum(['running', 'completed', 'failed']),
    startedAt: z.string(),
    completedAt: z.string().optional(),
    durationMs: z.number().optional(),
    tokenCount: z.number().optional(),
    toolUses: z.number().optional(),
    transcriptMessageId: z.string().optional(),
  })
  .passthrough();

export const automationRunSchema = z
  .object({
    id: z.string(),
    workstreamId: z.string(),
    title: z.string(),
    status: harnessStatusSchema,
    triggerType: z.string(),
    triggerTime: z.string(),
    resultSummary: z.string().optional(),
    durationMs: z.number().optional(),
    participants: z.array(participantSchema).optional(),
  })
  .passthrough();

export const workstreamDetailSchema = workstreamSummarySchema.extend({
  createdAt: z.string(),
  createdBy: workspaceMemberSchema.optional(),
  participants: z.array(participantSchema).default([]),
  viewers: z.array(participantSchema).default([]),
  resources: z.array(resourceSchema).default([]),
  connections: z.array(connectionSchema).default([]),
  backgroundTasks: z.array(backgroundTaskSchema).default([]),
  automationRuns: z.array(automationRunSchema).default([]),
  automationSubscriptionId: z.string().optional(),
  latestHarnessRunId: z.string().optional(),
});

export const automationDetailSchema = automationSummarySchema.extend({
  description: z.string(),
  overview: z.string().default(''),
  instructions: z.string(),
  triggerSummary: z.string(),
  scheduleSummary: z.string().optional(),
  capabilities: z.array(z.string()).default([]),
  recommendedPlugins: z.array(z.object({
    pluginId: z.string(),
    recommendedTools: z.array(z.string()).default([]),
    reason: z.string(),
  })).default([]),
  defaultPluginIds: z.array(z.string()).default([]),
  activitySourcePluginIds: z.record(z.string(), z.string()).default({}),
  activitySources: z.array(z.object({
    bindingKey: z.string(),
    connectorType: z.string(),
    suggestedPluginId: z.string().optional(),
  })).default([]),
  deliveryTargets: z.array(z.object({
    type: z.enum(['slack_agent_dm', 'email']),
    connectionId: z.string().nullable().default(null),
    displayName: z.string(),
    status: z.enum(['active', 'needs_input', 'disabled']),
  })).default([]),
  executionScope: z.string(),
  owner: workspaceMemberSchema.optional(),
  runs: z.array(automationRunSchema).default([]),
  nextRun: automationRunSchema.optional(),
});

export const automationDraftResponseSchema = z
  .object({
    draftId: z.string(),
    assistantMessage: z.string().optional(),
    question: z
      .object({
        id: z.string(),
        prompt: z.string(),
        placeholder: z.string().optional(),
        responseType: z.enum(['free_text', 'single_select', 'multi_select']).default('free_text'),
        options: z.array(z.object({
          label: z.string(),
          value: z.string(),
          description: z.string().optional(),
        })).default([]),
        minimumSelections: z.number().int().positive().optional(),
        maximumSelections: z.number().int().positive().optional(),
        allowOther: z.boolean().default(false),
      })
      .optional(),
    summary: z
      .object({
        name: z.string(),
        description: z.string(),
        overview: z.string(),
        recommendedPlugins: z.array(z.object({
          pluginId: z.string(),
          recommendedTools: z.array(z.string()).default([]),
          reason: z.string(),
        })).default([]),
        activitySources: z.array(z.object({
          bindingKey: z.string(),
          connectorType: z.string(),
          suggestedPluginId: z.string().optional(),
        })).default([]),
        scope: scopeSchema,
        triggerSummary: z.string(),
        capabilities: z.array(z.string()),
      })
      .optional(),
  })
  .passthrough();

export const workspaceTemplateSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    authorName: z.string(),
    description: z.string(),
    usageCount: z.number(),
    capabilities: z.array(z.string()),
    latestVersion: z.number(),
    activitySources: z.array(z.object({
      bindingKey: z.string(),
      connectorType: z.string(),
      suggestedPluginId: z.string().optional(),
    })).default([]),
  })
  .passthrough();

export const socketTicketSchema = z.object({
  url: z.string(),
  ticket: z.string(),
});

export const desktopSessionResponseSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string().optional(),
  expiresAt: z.string().optional(),
});
