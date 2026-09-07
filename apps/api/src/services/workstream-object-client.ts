import { SearchLinkSchema } from '../durable-objects/conversation-link-search';
import {
  ElicitationSchema,
  ParticipantSchema,
  WorkstreamResourceSchema,
  type ResourceRelationshipType,
  WorkstreamDetailSchema,
  WorkstreamTranscriptSnapshotSchema,
  WorkstreamSchema,
  TranscriptTurnSchema,
  WorkstreamMessageAdmissionReceiptSchema,
  type Elicitation,
  asSubstreamId,
  asWorkspaceId,
  asWorkstreamId,
  type WorkstreamResource,
  type Workstream,
  type WorkstreamDetail,
  type WorkstreamTranscriptSnapshot,
  type WorkstreamMessageAdmissionReceipt,
} from "@rally/contracts";
import type {
  AcknowledgeWorkstreamReadRequestSchema,
  AnswerElicitationRequestSchema,
  UpdateWorkstreamRequestSchema,
} from "@rally/contracts";
import { z } from "zod";

import { conversationObjectName } from "../durable-objects/names";
import type {
  SubstreamAgent,
  SubstreamProductRequest,
} from "../durable-objects/substream-agent";
import { rpcResultBody, type DurableObjectRpcResult } from "../durable-objects/rpc-result";
import type {
  InitializeWorkstreamObjectRequest,
  WorkstreamObjectCreateMessageInput,
} from "../durable-objects/workstream-object-product";
import type { AuthContext, Env } from "../env";
import { ApiError } from "../lib/api-error";
import {
  WorkstreamReaderAudienceSchema,
  type WorkstreamReaderAudience,
} from "../lib/audience-containment";
import { durableObjectStubForWorkspace } from "../lib/durable-object-namespace";

const BootPayloadSchema = z.object({
  workstream: WorkstreamDetailSchema,
  transcript: WorkstreamTranscriptSnapshotSchema,
});
const CreatedMessageSchema = WorkstreamMessageAdmissionReceiptSchema;
const AnsweredElicitationSchema = z.strictObject({
  elicitation: ElicitationSchema.optional(),
});
const InitializedWorkstreamSchema = z.strictObject({
  workstream: WorkstreamSchema,
  turnId: z.string().uuid(),
  harnessRunId: z.string().uuid(),
});

async function objectStub(
  env: Env,
  workspaceId: string,
  workstreamId: string,
  substreamId = "0",
): Promise<DurableObjectStub<SubstreamAgent>> {
  return durableObjectStubForWorkspace(
    env,
    env.SUBSTREAM_AGENTS,
    workspaceId,
    conversationObjectName(env.AVALON_REGION, asWorkspaceId(workspaceId), asWorkstreamId(workstreamId), asSubstreamId(substreamId)),
  );
}

export async function attachWorkstreamRuntimeResource(
  env: Env,
  input: WorkstreamRuntimeResourceAttachment,
): Promise<void> {
  const { substreamId, ...attachment } = input;
  const response = await (await objectStub(env, input.workspaceId, input.workstreamId, substreamId))
    .attachRuntimeResource(attachment);
  if (response.status < 200 || response.status >= 300) {
    const body = rpcResultBody(response) as { error?: unknown } | null;
    throw new Error(typeof body?.error === "string" ? body.error : "runtime_resource_attach_failed");
  }
}

export interface WorkstreamRuntimeResourceAttachment {
  workspaceId: string;
  workstreamId: string;
  /** Which of the parent's conversations; the main one by default. */
  substreamId?: string;
  resourceId: string;
  attachedByUserId: string | null;
  relationshipType?: ResourceRelationshipType;
}

export type WorkstreamRuntimeResourceAttacher = (
  input: WorkstreamRuntimeResourceAttachment,
) => Promise<void>;

/** Read audience from the work stream that owns participant and scope state. */
export async function readWorkstreamRuntimeAudience(
  env: Env,
  workspaceId: string,
  workstreamId: string,
): Promise<WorkstreamReaderAudience | null> {
  return WorkstreamReaderAudienceSchema.nullable().parse(
    await (await objectStub(env, workspaceId, workstreamId)).readerAudience({
      workspaceId,
      workstreamId,
    }),
  );
}

function decode(response: DurableObjectRpcResult): unknown {
  const body = rpcResultBody(response) as {
    error?: unknown;
    message?: unknown;
    details?: unknown;
  } | null;
  if (response.status >= 200 && response.status < 300) return body;
  throw new ApiError(
    apiStatus(response.status),
    typeof body?.error === "string" ? body.error : "workstream_object_request_failed",
    typeof body?.message === "string" ? body.message : "The work stream could not be loaded",
    body?.details && typeof body.details === "object"
      ? body.details as Record<string, unknown>
      : undefined,
  );
}

function apiStatus(status: number): 400 | 401 | 403 | 404 | 409 | 413 | 422 | 426 | 429 | 500 | 502 | 503 {
  switch (status) {
    case 400: case 401: case 403: case 404: case 409: case 413:
    case 422: case 426: case 429: case 502: case 503: return status;
    default: return 500;
  }
}

/** Typed Worker-side access to the product authority for one work stream. */
export class WorkstreamObjectClient {
  constructor(
    private readonly env: Env,
    private readonly auth: AuthContext,
    private readonly workstreamId: string,
    private readonly substreamId = "0",
    /**
     * Whether the caller is tracing one of the three work-stream flows. The
     * object's own spans nest under the caller's automatically — a Durable
     * Object call is a traced binding call — so nothing is propagated by hand;
     * this only tells the object whether to name its steps at all, so a
     * background path does not pay for spans nobody will read.
     */
    private readonly traced = false,
  ) {}

  private async request(body: Record<string, unknown>): Promise<unknown> {
    const response = await (await objectStub(
      this.env,
      this.auth.workspaceId,
      this.workstreamId,
      this.substreamId,
    )).handleProductRequest(
      // The auth payload is narrowed rather than spread: `AuthContext` now also
      // carries the analytics surrogates, `ProductRequestSchema` is strict, and
      // the object re-resolves both from its own session query anyway. Sending
      // them would be a field the room must reject or learn to ignore, for a
      // value it already has.
      {
        ...body,
        auth: {
          sessionId: this.auth.sessionId,
          userId: this.auth.userId,
          workspaceId: this.auth.workspaceId,
          region: this.auth.region,
          role: this.auth.role,
          // Spread conditionally so a session-principal payload never gains a
          // key it did not carry before connector principals existed: absence
          // is the wire's way of saying "verify my session". (Not a schema
          // necessity — the room declares the key as optional and JSON would
          // drop an `undefined` anyway; the point is the contract.)
          ...(this.auth.principal === "connector" ? { principal: "connector" } : {}),
        },
      } as SubstreamProductRequest,
      this.traced,
    );
    return decode(response);
  }

  async get(): Promise<WorkstreamDetail> {
    return WorkstreamDetailSchema.parse(await this.request({ operation: "get" }));
  }

  async searchLinks(links: Array<{ turnId: string; linkId: string }>) {
    return z.object({ title: z.string(), links: z.array(z.object({ linkId: z.string(), link: SearchLinkSchema.nullable() })) }).parse(
      await this.request({ operation: "search_links", links }),
    );
  }

  async searchLink(turnId: string, linkId: string) {
    return z.object({ title: z.string(), link: SearchLinkSchema.nullable() }).parse(
      await this.request({ operation: "search_link", turnId, linkId }),
    );
  }

  async searchTurns(turnIds: string[]) {
    return z.object({ title: z.string(), turns: z.array(TranscriptTurnSchema) }).parse(
      await this.request({ operation: "search_turns", turnIds }),
    );
  }

  /** Detail plus its canonical ordered transcript opening snapshot. */
  async boot(): Promise<{
    workstream: WorkstreamDetail;
    transcript: WorkstreamTranscriptSnapshot;
  }> {
    return BootPayloadSchema.parse(await this.request({ operation: "boot" }));
  }

  async initialize(input: InitializeWorkstreamObjectRequest): Promise<{
    workstream: Workstream;
    turnId: string;
    harnessRunId: string;
  }> {
    return InitializedWorkstreamSchema.parse(await this.request({ operation: "initialize", input }));
  }


  async update(input: z.infer<typeof UpdateWorkstreamRequestSchema>): Promise<Workstream> {
    return WorkstreamSchema.parse(await this.request({ operation: "update", input }));
  }

  async acknowledgeRead(
    input: z.infer<typeof AcknowledgeWorkstreamReadRequestSchema>,
  ): Promise<Workstream> {
    return WorkstreamSchema.parse(await this.request({ operation: "acknowledge_read", input }));
  }

  async markUnread(): Promise<Workstream> {
    return WorkstreamSchema.parse(await this.request({ operation: "mark_unread" }));
  }

  async createMessage(
    input: WorkstreamObjectCreateMessageInput,
  ): Promise<WorkstreamMessageAdmissionReceipt> {
    return CreatedMessageSchema.parse(await this.request({ operation: "create_message", input }));
  }

  async addParticipant(userId: string): Promise<WorkstreamDetail["participants"][number]> {
    return ParticipantSchema.parse(await this.request({ operation: "add_participant", userId }));
  }

  async removeParticipant(userId: string): Promise<void> {
    await this.request({ operation: "remove_participant", userId });
  }

  async attachResource(resourceId: string): Promise<WorkstreamResource> {
    return WorkstreamResourceSchema.parse(await this.request({ operation: "attach_resource", resourceId }));
  }

  async detachResource(resourceId: string): Promise<void> {
    await this.request({ operation: "detach_resource", resourceId });
  }

  async answerElicitation(
    elicitationId: string,
    input: z.infer<typeof AnswerElicitationRequestSchema>,
  ): Promise<{ elicitation: Elicitation | undefined }> {
    const parsed = AnsweredElicitationSchema.parse(await this.request({
      operation: "answer_elicitation",
      elicitationId,
      input,
    }));
    return { elicitation: parsed.elicitation };
  }

}
