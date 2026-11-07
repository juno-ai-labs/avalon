import { asWorkspaceId, canvasCanonicalUrl, sidekickCanonicalUrl, type Region } from "@rally/contracts";

import type { Env } from "../env";
import { durableObjectStubForWorkspace } from "../lib/durable-object-namespace";
import { workspaceDOName } from "../durable-objects/names";

/**
 * The canonical link for a conversation, from what its parent is: a Canvas's
 * Chat links to the Canvas (onto `artifactId` when one is named), and a
 * Sidekick's conversation or one of its runs links to the Sidekick. A
 * notification, an email or a Slack message about a conversation carries this.
 *
 * `null` for any other parent: a Thread, a Breakout or a Channel has no link
 * form now that their surfaces are gone (`docs/links.md`), and a parent this
 * Organization does not hold names nothing. A caller with nothing to link to
 * sends nothing, or sends its message without the link, and says so.
 */
export async function conversationCanonicalUrl(
  env: Env,
  input: { region: Region; workspaceId: string; parentId: string; artifactId?: string },
): Promise<string | null> {
  return (await conversationLink(env, input)).url;
}

/** A conversation's parent kind (`null` when the Organization holds no such parent) and its link. */
export interface ConversationLink {
  kind: "workstream" | "space" | "automation" | "canvas" | null;
  url: string | null;
}

/**
 * The link and the parent kind it came from, for a caller that logs why it
 * has no link: a deleted Canvas (`kind: null`) reads apart from a Thread.
 */
export async function conversationLink(
  env: Env,
  input: { region: Region; workspaceId: string; parentId: string; artifactId?: string },
): Promise<ConversationLink> {
  const workspaceId = asWorkspaceId(input.workspaceId);
  const workspace = await durableObjectStubForWorkspace(env, env.WORKSPACE_DOS, workspaceId, workspaceDOName(input.region, workspaceId));
  const { kind } = await workspace.resolveHostedParent({ workspaceId, parentId: input.parentId });
  const target = { region: input.region, workspaceId };
  if (kind === "canvas") {
    return { kind, url: canvasCanonicalUrl(env.PUBLIC_WEB_BASE_URL, {
      ...target, canvasId: input.parentId, ...(input.artifactId ? { artifactId: input.artifactId } : {}),
    }) };
  }
  return { kind, url: kind === "automation" ? sidekickCanonicalUrl(env.PUBLIC_WEB_BASE_URL, { ...target, sidekickId: input.parentId }) : null };
}
