import {
  ConnectorCardsBlockSchema,
  connectorCardsFallbackText,
  connectorOffering,
  type ConnectorCardsBlock,
} from "@avalon/contracts";
import { createDatabase, newId, nowIso } from "@avalon/db";
import type { Env } from "../env";
// `integrations` imports this module back, for the agent tool that calls
// `publishConnectorCards`. The cycle is safe and deliberate: both directions
// resolve to hoisted function declarations that are only called at request
// time, and `publishWorkstreamEvent` lives in `integrations` for every other
// producer of a transcript row too. Do not add module-scope work here that
// reads from `integrations`, which is what would turn it into a real one.
import { publishWorkstreamEvent } from "./integrations";

export interface PublishConnectorCardsInput {
  workspaceId: string;
  workstreamId: string;
  block: ConnectorCardsBlock;
  /**
   * The idempotency key for the row. A producer that can be retried — a queue
   * consumer, a tool call replayed after a run resumed — passes the same key
   * and gets the same single card block rather than a second one stacked under
   * the first.
   */
  clientMessageId: string;
}

export interface PublishedConnectorCards {
  messageId: string;
  /** False when the key already had a row, which is a replay rather than a failure. */
  created: boolean;
}

/**
 * Write one connector-cards block into a work stream's transcript.
 *
 * The row is a `system` message: it is UI state rather than something anybody
 * said, which is also what keeps it out of the model transcript
 * (`buildModelTranscript` skips non-text rows). What the block stores is only
 * *which* offerings are on it — never whether they are connected. See
 * `docs/connector-cards.md`.
 */
export async function publishConnectorCards(
  env: Env,
  input: PublishConnectorCardsInput,
): Promise<PublishedConnectorCards> {
  const block = ConnectorCardsBlockSchema.parse(input.block);
  const messageId = newId();
  const at = nowIso();
  const results = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO messages
       (id, client_message_id, workspace_id, workstream_id, author_type, author_user_id,
        message_type, text_content, structured_content_json, sequence_number, created_at)
       SELECT ?, ?, ?, w.id, 'agent', NULL, 'system', ?, ?, w.next_sequence_number, ?
       FROM workstreams w WHERE w.id = ? AND w.workspace_id = ?
       ON CONFLICT(workstream_id, client_message_id) DO NOTHING`,
    ).bind(
      messageId,
      input.clientMessageId,
      input.workspaceId,
      connectorCardsFallbackText(block),
      JSON.stringify(block),
      at,
      input.workstreamId,
      input.workspaceId,
    ),
    // A card is a request for something only a person can do, so it moves the
    // attention marker exactly like an open question does — a block nobody is
    // told about is a block nobody acts on.
    env.DB.prepare(
      `UPDATE workstreams
       SET next_sequence_number = next_sequence_number + 1,
           latest_attention_sequence_number = next_sequence_number,
           last_activity_at = ?, updated_at = ?
       WHERE id = ? AND workspace_id = ?
         AND EXISTS (SELECT 1 FROM messages WHERE id = ?)`,
    ).bind(at, at, input.workstreamId, input.workspaceId, messageId),
  ]);
  const created = Number(results[0]?.meta.changes ?? 0) > 0;
  const message = await createDatabase(env.DB).workstreams.getMessageByClientId(
    input.workspaceId,
    input.workstreamId,
    input.clientMessageId,
  );
  if (created && message) {
    await publishWorkstreamEvent(env, input.workspaceId, input.workstreamId, {
      type: "message_created",
      message,
    });
  }
  return { messageId: message?.id ?? messageId, created };
}

/**
 * Every distinct card in the block, in the order given, with duplicates dropped.
 *
 * Two cards for the same offering and scope render as two identical cards whose
 * buttons do the same thing, and the second one's Connect is dead the moment the
 * first is used. A producer that names one twice is making a mistake rather than
 * a request, so it is corrected here instead of being refused — the block is
 * still exactly what was asked for, minus the repetition.
 */
export function dedupeConnectorCards(block: ConnectorCardsBlock): ConnectorCardsBlock {
  const seen = new Set<string>();
  const cards = block.cards.filter((card) => {
    const key = `${card.offeringId}:${card.scope ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { ...block, cards };
}

/**
 * Whether every card names a scope its offering actually supports.
 *
 * Returns the offending cards rather than throwing, so a caller can tell a
 * model what it got wrong: "notion has no workspace scope" is a fixable
 * instruction, and a 500 is not.
 */
export function invalidConnectorCardScopes(block: ConnectorCardsBlock): string[] {
  return block.cards.flatMap((card) => {
    if (!card.scope) return [];
    const offering = connectorOffering(card.offeringId);
    return offering.scopes.includes(card.scope)
      ? []
      : [`${offering.id} cannot be connected for the ${card.scope} scope; it supports ${offering.scopes.join(", ")}`];
  });
}
