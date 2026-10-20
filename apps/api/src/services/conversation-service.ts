import { newId } from "@rally/db";
import { asSubstreamId, asWorkspaceId } from "@rally/contracts";
import type {
  ConversationParentAuthorizeViewerRequest,
  ConversationParentAuthorizeViewerResult,
  ConversationParentKind,
} from "@rally/contracts/conversation-parent";

import { conversationObjectName, workspaceDOName } from "../durable-objects/names";
import type { AuthContext, Env } from "../env";
import { ApiError } from "../lib/api-error";
import { durableObjectStubForWorkspace } from "../lib/durable-object-namespace";
import { logStructuredEvent, logWarn } from "../observability/logger";
import { ObjectPortError } from "../runtime/object-port";
import { createIdentityObjectPort } from "../runtime/identity-port";
import { issueSocketTicket, WORKSTREAM_SOCKET_TICKET_TTL_SECONDS } from "./socket-service";
import { requireWorkstreamIngress } from "./workstream-authority";
import { WorkstreamObjectClient } from "./workstream-object-client";

export interface ResolvedConversationParent {
  kind: ConversationParentKind;
  id: string;
  authorityGeneration: number;
  /** Whether the parent is archived: readers are admitted, writers refused. */
  archived: boolean;
  membershipVersion: number;
}

/**
 * The conversation surface: one parent's substreams, whichever kind of parent.
 *
 * A work stream and an automation are addressed the same way here. The Worker
 * resolves which kind a parent id names, asks that parent whether this person
 * may read its conversations, seats them on the conversation object, and only
 * then hands out a ticket or a client. What differs between the two kinds is
 * inside the parent's own `authorizeViewer`; nothing here branches on it.
 */
export class ConversationService {
  constructor(
    private readonly env: Env,
    private readonly auth: AuthContext,
    private readonly defer?: (promise: Promise<unknown>) => void,
  ) {}

  /**
   * Which kind of parent this id names.
   *
   * The Organization object first: it hosts every Channel and Space parent and
   * says which kind an id is in the same read that returns its authority, so a
   * Channel costs one warm call and nothing is asked of an object that does
   * not hold the id. A Space is not a conversation this route opens. An id
   * neither knows is a 404 rather than a guess.
   */
  async resolveParent(parentId: string): Promise<ResolvedConversationParent> {
    return (await this.resolveParentFor(parentId)).parent;
  }

  /**
   * `resolveParent`, and for a hosted Channel the viewer's decision from the
   * same call when a viewer is named.
   */
  private async resolveParentFor(
    parentId: string,
    viewer?: Omit<ConversationParentAuthorizeViewerRequest, "workspaceId" | "parentId">,
  ): Promise<{ parent: ResolvedConversationParent; decision?: ConversationParentAuthorizeViewerResult }> {
    const workspace = await durableObjectStubForWorkspace(
      this.env,
      this.env.WORKSPACE_DOS,
      this.auth.workspaceId,
      workspaceDOName(this.env.AVALON_REGION, asWorkspaceId(this.auth.workspaceId)),
    );
    const hosted = await workspace.resolveHostedParent({
      workspaceId: this.auth.workspaceId, parentId, ...(viewer ? { viewer } : {}),
    });
    if (hosted.kind === "workstream") {
      return {
        parent: { kind: "workstream", id: parentId, membershipVersion: 0, ...hosted.authority },
        ...(hosted.viewer ? { decision: hosted.viewer } : {}),
      };
    }
    if (hosted.kind === "automation") {
      return {
        parent: { kind: "automation", id: parentId, membershipVersion: 0, ...hosted.authority },
        ...(hosted.viewer ? { decision: hosted.viewer } : {}),
      };
    }
    throw new ApiError(404, "conversation_not_found", "Conversation not found");
  }

  /**
   * The parent's answer to "may this person read your conversations", and the
   * seat that follows from it.
   *
   * The conversation object decides reads from its own participant list, so a
   * reader the parent admits is seated there before anything is issued. For a
   * work stream the seat already exists (the room's participants are the
   * conversation's); for an automation the parent's rule is wider than the
   * conversation's list, and this is what carries the parent's decision down.
   */
  async authorizeViewer(parentId: string, substreamId = "0"): Promise<ResolvedConversationParent> {
    const viewer: Omit<ConversationParentAuthorizeViewerRequest, "workspaceId" | "parentId"> = {
      userId: this.auth.userId,
      substreamId: asSubstreamId(substreamId),
      ...(this.auth.role === null ? { requireGrantAuthority: true } : {}),
    };
    const resolved = await this.resolveParentFor(parentId, viewer);
    const parent = resolved.parent;
    // The Organization object answered in the resolve, for every kind it hosts.
    const decision: ConversationParentAuthorizeViewerResult = resolved.decision
      ?? await this.parentStub(parent).then((stub) => stub.authorizeViewer({
        workspaceId: this.auth.workspaceId,
        parentId,
        ...viewer,
      }));
    if (!decision.authorized) throw new ApiError(404, "conversation_not_found", "Conversation not found");
    if (parent.kind === "automation") {
      try {
        await createIdentityObjectPort(this.env, this.auth.workspaceId, parentId, undefined, substreamId)
          .admitParticipant({
            userId: this.auth.userId,
            addedByUserId: this.auth.userId,
            reason: "explicit",
            now: Date.now(),
          });
      } catch (error) {
        // A run's conversation exists once the run alarm provisions it. A
        // reader who arrives in the moment between the run being recorded and
        // the object being bootstrapped gets a typed retry, not a 500.
        if (error instanceof ObjectPortError && substreamId !== "0") {
          throw new ApiError(409, "conversation_not_ready", "This conversation is still being set up; try again shortly");
        }
        throw error;
      }
    }
    return {
      ...parent,
      archived: decision.archived || parent.archived,
      membershipVersion: decision.membershipVersion ?? 0,
    };
  }

  /**
   * The object client for one of the parent's conversations.
   *
   * Defaults to the main conversation, which is what every work-stream-level
   * route wants. A substream is named explicitly and authorized as itself:
   * `authorizeViewer` checks that child's membership, not just the parent's.
   */
  async client(parentId: string, traced = false, substreamId = "0"): Promise<WorkstreamObjectClient> {
    const parent = await this.authorizeViewer(parentId, substreamId);
    // The kind travels with the request. It is already resolved here — the
    // authorization above needed it — and the conversation refuses one that
    // names the wrong kind, which is what stops a Space id being an address
    // for a Channel operation.
    return WorkstreamObjectClient.forParent(
      this.env, this.auth, parent.kind, parentId, substreamId, traced,
    );
  }

  /** A client for a write, refused outright when the conversation is archived. */
  async writableClient(parentId: string, substreamId = "0"): Promise<WorkstreamObjectClient> {
    const parent = await this.authorizeViewer(parentId, substreamId);
    if (parent.archived) {
      throw new ApiError(409, "conversation_parent_archived", "This conversation belongs to something that is archived");
    }
    return WorkstreamObjectClient.forParent(this.env, this.auth, parent.kind, parentId, substreamId);
  }

  /** Canonical child inventory; callers still authorize each returned child. */
  async children(parentId: string): Promise<string[]> {
    const parent = await this.authorizeViewer(parentId);
    const result = await (await this.parentStub(parent)).listChildren({
      workspaceId: this.auth.workspaceId, parentId,
    });
    return result.children.map((child) => child.substreamId);
  }

  async socketTicket(
    parentId: string,
    substreamId = "0",
    afterSequence?: number,
    speculative = false,
    readsResolutionSuggestions = false,
  ) {
    const [parent, authority] = await Promise.all([
      this.authorizeViewer(parentId, substreamId),
      requireWorkstreamIngress(this.env),
    ]);
    // A work stream's own object refuses every read of an archived room, boot
    // included, so a ticket for one would open a socket that never gets a
    // frame. Refuse it the way the boot does. An automation's conversation
    // stays readable after its archive; only its writes are refused.
    if (parent.kind === "workstream" && parent.archived) {
      throw new ApiError(404, "conversation_not_found", "Conversation not found");
    }
    // Minted here rather than inside the issuer so the route can log the id the
    // room will report consuming; see `docs/performance-tracing.md`.
    const ticketId = newId();
    const issuedAt = Math.floor(Date.now() / 1_000);
    const ticket = await issueSocketTicket(
      this.env,
      this.auth,
      { kind: parent.kind, id: parentId },
      substreamId,
      ticketId,
      afterSequence,
      speculative,
      {
        issuedAt,
        readsResolutionSuggestions,
        admission: {
          authorityGeneration: authority.generation,
          role: this.auth.role,
          analyticsWorkspaceId: this.auth.analyticsWorkspaceId ?? null,
          parentArchived: parent.archived,
          membershipVersion: parent.membershipVersion,
        },
      },
    );
    // The main conversation is recorded by its parent's creation. A child is
    // reserved by its parent too, so an arbitrary substream id must not
    // materialize an object merely because its parent is visible; the warm-up
    // is for the main conversation, which every open pays for.
    if (substreamId === "0") {
      this.warmMainSocketSubstream({
        parent,
        ticketId,
        ticketIssuedAt: issuedAt,
        ticketExpiresAt: issuedAt + WORKSTREAM_SOCKET_TICKET_TTL_SECONDS,
        ...(afterSequence === undefined ? {} : { afterSequence }),
        speculative,
        authorityGeneration: authority.generation,
        membershipVersion: parent.membershipVersion,
      });
    }
    const url = new URL(this.env.PUBLIC_API_BASE_URL);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = `/socket/conversations/${parentId}/${substreamId}`;
    url.search = "";
    return {
      url: url.toString(),
      ticket,
      ticketId,
      subscriptionBootstrap: afterSequence !== undefined,
    };
  }

  /**
   * Use ticket transit to prepare the exact room admission and first snapshot.
   *
   * The signed ticket and durable one-use receipt remain the authorization
   * boundary. This in-memory work is deliberately best effort: an unavailable
   * preparation leaves the later upgrade on its existing regional fallback,
   * never turns a usable ticket into an API failure. `defer` is request-owned
   * `waitUntil`, so the Worker keeps the binding call alive after sending the
   * ticket without adding the preparation to ticket latency.
   */
  private warmMainSocketSubstream(input: {
    parent: ResolvedConversationParent;
    ticketId: string;
    ticketIssuedAt: number;
    ticketExpiresAt: number;
    afterSequence?: number;
    speculative: boolean;
    authorityGeneration: number;
    membershipVersion: number;
  }): void {
    if (!this.defer) return;
    const startedAt = Date.now();
    this.defer((async () => {
      try {
        const stub = await durableObjectStubForWorkspace(
          this.env,
          this.env.SUBSTREAM_AGENTS,
          this.auth.workspaceId,
          conversationObjectName(this.env.AVALON_REGION, this.auth.workspaceId, input.parent.id),
        );
        const prepared = await stub.prepareSocketAdmission({
          workspaceId: this.auth.workspaceId,
          parentKind: input.parent.kind,
          workstreamId: input.parent.id,
          substreamId: asSubstreamId("0"),
          userId: this.auth.userId,
          sessionId: this.auth.sessionId,
          ticketId: input.ticketId,
          ticketIssuedAt: input.ticketIssuedAt,
          ticketExpiresAt: input.ticketExpiresAt,
          authorityGeneration: input.authorityGeneration,
          membershipVersion: input.membershipVersion,
          role: this.auth.role,
          analyticsWorkspaceId: this.auth.analyticsWorkspaceId ?? null,
          ...(input.afterSequence === undefined ? {} : { afterSequence: input.afterSequence }),
          speculative: input.speculative,
        });
        logStructuredEvent(this.env, "info", "workstream_socket_ticket_warm_finished", {
          workspace_id: this.auth.workspaceId,
          workstream_id: input.parent.id,
          parent_kind: input.parent.kind,
          substream_id: "0",
          ticket_id: input.ticketId,
          duration_ms: Math.max(0, Date.now() - startedAt),
          outcome: "success",
          preparation_outcome: prepared.outcome,
        });
      } catch (error) {
        logWarn(this.env, "workstream_socket_ticket_warm_finished", {
          workspace_id: this.auth.workspaceId,
          workstream_id: input.parent.id,
          parent_kind: input.parent.kind,
          substream_id: "0",
          ticket_id: input.ticketId,
          duration_ms: Math.max(0, Date.now() - startedAt),
          outcome: "failure",
          error_name: error instanceof Error ? error.name : "UnknownError",
        });
      }
    })());
  }

  private async parentStub(parent: ResolvedConversationParent) {
    void parent;
    const workspaceId = asWorkspaceId(this.auth.workspaceId);
    return durableObjectStubForWorkspace(
      this.env,
      this.env.WORKSPACE_DOS,
      workspaceId,
      workspaceDOName(this.env.AVALON_REGION, asWorkspaceId(workspaceId)),
    );
  }
}
