import { agentAddressForId, asAutomationId, asSubstreamId, asWorkspaceId, type AutomationActivationV1, type WorkstreamWorkflowInput } from "@rally/contracts";
import type { Env } from "../env";
import { durableObjectStubForWorkspace } from "../lib/durable-object-namespace";
import { conversationObjectName, workspaceDOName } from "../durable-objects/names";

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
export type WizardCard = Pick<AutomationActivationV1, "sourceRequests" | "question">;

/**
 * The Canvas whose Chat started this wizard turn, or null for any other loop:
 * an agent's message from a Canvas's Chat to the Sidekick's wizard.
 */
export function wizardTurnCanvasId(input: Pick<WorkstreamWorkflowInput, "sidekickWizard" | "agentExchange">): string | null {
  if (input.sidekickWizard !== true || !input.agentExchange) return null;
  const sender = agentAddressForId(input.agentExchange.senderAgentId);
  return sender.parentKind === "canvas" && sender.substreamId === "0" ? sender.parentId : null;
}

/**
 * Post a card into a Canvas's Chat as the Sidekick, once per `clientMessageId`.
 * The post's text is what the Chat's agent reads; its card is what the client
 * draws. `content` is given the Sidekick's name.
 */
export async function postWizardCard(env: Env, input: WorkstreamWorkflowInput, canvasId: string, clientMessageId: string,
  content: (sidekickName: string) => { text: string; card: WizardCard }): Promise<void> {
  const workspaceId = asWorkspaceId(input.workspaceId);
  const sidekickId = input.parentId;
  const workspace = await durableObjectStubForWorkspace(env, env.WORKSPACE_DOS, workspaceId, workspaceDOName(env.AVALON_REGION, workspaceId));
  const name = await workspace.sidekickDisplayName({ workspaceId, sidekickId });
  const { text, card } = content(name);
  const chat = await durableObjectStubForWorkspace(env, env.SUBSTREAM_AGENTS, workspaceId,
    conversationObjectName(env.AVALON_REGION, workspaceId, canvasId, asSubstreamId("0")));
  const appended = await chat.appendConversationPost({
    schemaVersion: 1, workspaceId, parentKind: "canvas", workstreamId: canvasId, substreamId: "0", clientMessageId, text,
    post: { type: "automation_activation", schemaVersion: 1, automationId: asAutomationId(sidekickId), automationName: name,
      runId: input.harnessRunId, deliveryId: clientMessageId, occurredAt: Date.now(), ...card },
  });
  if (appended.outcome === "refused") throw new Error(`wizard_card_refused:${appended.code}`);
}
