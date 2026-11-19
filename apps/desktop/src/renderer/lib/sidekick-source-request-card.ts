import { SidekickSourceRequestViewSchema, type SidekickSourceRequestView } from '@rally/contracts';
import { z } from 'zod';

/** The agent tool that asks people for a source (plugin `rally_sidekicks`, `request_source`). */
export const SIDEKICK_SOURCE_REQUEST_WIRE_NAME = 'sidekick_request_source';

/**
 * A card needs only which requests to read; where each stands is read live.
 * The tool's output is otherwise the asker's view at the moment it asked
 * (`yours` is the asker's, and every state is already old), so nothing else
 * of it is required to draw a card.
 */
const sourceRequestCardEnvelopeSchema = z.object({
  sidekickId: z.string().min(1),
  requests: z.array(z.object({ requestId: z.string().min(1) })).min(1),
});

/**
 * A request as the tool answered it. The tool answers a model, so the
 * Organization's connection reads `organization` there; the view a person's
 * card reads stores `workspace`. An answer recorded before the tool said
 * `organization` already holds the stored word.
 */
const askedRequestSchema = z.preprocess((raw) => {
  if (raw === null || typeof raw !== 'object') return raw;
  const connect = (raw as { connect?: { scope?: unknown } }).connect;
  return connect?.scope === 'organization' ? { ...raw, connect: { ...connect, scope: 'workspace' } } : raw;
}, SidekickSourceRequestViewSchema);

export interface SidekickSourceRequestCardInput {
  sidekickId: string;
  requestIds: string[];
  /**
   * The requests as the tool answered them, when its output is whole: what
   * the card paints until its own read lands. Never authority for a state.
   */
  asked: SidekickSourceRequestView[] | null;
}

/**
 * The card a completed `sidekick_request_source` call draws, from the output
 * its transcript block keeps. A call still running, one that failed, and one
 * whose output did not survive stay ordinary tool activity.
 */
export function sidekickSourceRequestCardFromToolEvent(event: {
  name: string;
  wireName?: string | undefined;
  status?: string | undefined;
  output?: unknown;
} | undefined): SidekickSourceRequestCardInput | null {
  if (!event || (event.wireName ?? event.name) !== SIDEKICK_SOURCE_REQUEST_WIRE_NAME || event.status !== 'completed') return null;
  const parsed = sourceRequestCardEnvelopeSchema.safeParse(event.output);
  if (!parsed.success) return null;
  const asked = z.object({ requests: z.array(askedRequestSchema) }).safeParse(event.output);
  return {
    sidekickId: parsed.data.sidekickId,
    requestIds: parsed.data.requests.map((request) => request.requestId),
    asked: asked.success ? asked.data.requests : null,
  };
}
