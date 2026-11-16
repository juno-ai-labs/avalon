import { agentAddressForId, asAutomationId, asSubstreamId, asWorkspaceId, type AutomationActivationV1, type WorkstreamWorkflowInput } from "@rally/contracts";
import type { Env } from "../env";
import { durableObjectStubForWorkspace } from "../lib/durable-object-namespace";
import { conversationObjectName, workspaceDOName } from "../durable-objects/names";
import { diagnosticErrorCode, logWarn } from "../observability/logger";

/**
 * A card the wizard draws in the Canvas's Chat that started its turn.
 *
 * A Canvas's Chat hands a Sidekick's setup to its wizard in a message, and the
 * person who asked is reading the Chat, not the Sidekick's conversation. What
 * the wizard asks of a person on that turn (a source request, a question) is
 * drawn in both: its own block in the wizard's conversation, and a post of the
 * Sidekick's in the Chat that carries what the card reads. The card reads the
 * request or the question live from where it lives, so the post copies no
 * state. `docs/sidekick-sources.md#where-the-card-is-drawn`.
 */

/**
 * The Canvas whose Chat started this wizard turn, or null for any other loop:
 * a message to the Sidekick's wizard from a Canvas's Chat or one of its
 * background agents, or an answer to a question such a turn asked there
 * (`wizardCanvasId`). The person is reading the Chat either way.
 */
export function wizardTurnCanvasId(input: Pick<WorkstreamWorkflowInput, "sidekickWizard" | "agentExchange" | "wizardCanvasId">): string | null {
  if (input.sidekickWizard !== true) return null;
  // Answering a question the Chat drew continues in that Chat.
  if (input.wizardCanvasId) return input.wizardCanvasId;
  // A message that acts for the Chat's person: not a host notice.
  if (input.agentExchange?.fromPersonTurn !== true) return null;
  const sender = agentAddressForId(input.agentExchange.senderAgentId);
  return sender.parentKind === "canvas" ? sender.parentId : null;
}

/**
 * Post a card into a Canvas's Chat as the Sidekick, once per `clientMessageId`.
 * The post's text is what the Chat's agent reads; its card is what the client
 * draws. Best-effort: the question or the request it mirrors already exists,
 * so a failed post is logged by name and never fails the tool that made it.
 */
export async function postWizardCard(env: Env, input: WorkstreamWorkflowInput, canvasId: string, clientMessageId: string,
  post: { text: string; card: Pick<AutomationActivationV1, "sourceRequests" | "question">; sidekickId?: string }): Promise<void> {
  const workspaceId = asWorkspaceId(input.workspaceId);
  // The Sidekick the card is about: the wizard's own, unless it asked for another's sources.
  const sidekickId = post.sidekickId ?? input.parentId;
  const failed = (code: string) => logWarn(env, "wizard_card_post_failed", { workspace_id: workspaceId, automation_id: sidekickId,
    workstream_id: canvasId, client_message_id: clientMessageId, code });
  try {
    const workspace = await durableObjectStubForWorkspace(env, env.WORKSPACE_DOS, workspaceId, workspaceDOName(env.AVALON_REGION, workspaceId));
    const name = await workspace.sidekickDisplayName({ workspaceId, sidekickId });
    const chat = await durableObjectStubForWorkspace(env, env.SUBSTREAM_AGENTS, workspaceId,
      conversationObjectName(env.AVALON_REGION, workspaceId, canvasId, asSubstreamId("0")));
    const appended = await chat.appendConversationPost({
      schemaVersion: 1, workspaceId, parentKind: "canvas", workstreamId: canvasId, substreamId: "0", clientMessageId, text: post.text,
      post: { type: "automation_activation", schemaVersion: 1, automationId: asAutomationId(sidekickId), automationName: name,
        runId: input.harnessRunId, deliveryId: clientMessageId, occurredAt: Date.now(), ...post.card },
    });
    if (appended.outcome === "refused") failed(appended.code);
  } catch (error) {
    failed(diagnosticErrorCode(error, "wizard_card_post_failed"));
  }
}
