import { ArtifactLinkSchema, CanvasArtifactVisibilitySchema } from '@rally/contracts/artifact-access';
import { ORGANIZATION_MODEL_NAMES, modelEnum, withModelNames } from '@rally/contracts/model-names';
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/server";
import { z } from "zod";

import {
  AddedCanvasSidekickSchema,
  CanvasAccessDecisionSchema,
  CanvasDetailSchema,
  CanvasListSchema,
  CanvasPublishContentSchema,
  CanvasPublishRequestSchema,
  CanvasPublishedArtifactSchema,
  CanvasUpdateRequestSchema,
  CanvasVisibilitySchema,
  CreateCanvasRequestSchema,
  CreatedCanvasSchema,
  type AddCanvasSidekickRequestSchema,
  type CanvasAccessDecisionRequestSchema,
  type CanvasAudienceUpdateSchema,
} from "@rally/contracts/canvases";
import { COMPONENT_LIBRARIES, COMPONENT_UI_MODULES } from "@rally/contracts/canvas-build";
import {
  ConversationTextPageSchema,
  PickableWorkstreamIconKeySchema,
  PROJECT_COLOR_RING,
  ResourceSchema,
  WorkspaceMemberSchema,
  WorkspaceSchema,
  WorkstreamMessageAdmissionReceiptSchema,
} from "@rally/contracts";
import { ScopeInvitationResultSchema } from "@rally/contracts/scope-grants";
import { isCodeShaped, zodDiagnosticCode } from "@rally/contracts/zod-diagnostics";

import { RallyApiError, type RallyApi } from "./api";
import { RALLY_MCP_SERVER_INSTRUCTIONS } from "@rally/prompts/mcp/server-instructions";
import { renderPublishToRallyPrompt } from "@rally/prompts/mcp/publish-to-rally";
import { renderStartCanvasPrompt } from "@rally/prompts/mcp/start-canvas";
import { renderCatchUpPrompt } from "@rally/prompts/mcp/catch-up";

/** A link to a resource the client can read back (`resources/read`) without another tool call. */
type ResourceLink = { type: "resource_link"; uri: string; name: string; mimeType?: string; description?: string };
type ToolResult = { content: [{ type: "text"; text: string }, ...ResourceLink[]]; isError?: boolean };

/** A tool's value with the resource links it points at. */
class Linked {
  constructor(readonly value: unknown, readonly links: ResourceLink[]) {}
}

const CanvasId = z.string().uuid().describe("The Canvas's id, from list_canvases or create_canvas.");
const OperationId = z.string().uuid().describe(
  "A fresh UUID for this operation. After an uncertain result (no answer, a timeout, or a 409 or 503 from Rally), call again with the same operationId and the same arguments: Rally answers with the first attempt's result rather than doing it twice. Never mint a new operationId for a retry.");

const SidekickOperationId = z.string().uuid().describe(
  "A fresh UUID for the Sidekick, different from every other operationId, the Canvas's among them: it becomes the Sidekick's id. After an uncertain result call again with the same value and the same arguments.");
const SidekickInstructions = z.string().trim().min(1).describe(
  "What the Sidekick should do and when, in plain words, as you would brief a colleague: what starts a run (a schedule, or an event such as a new email or a pull request being merged), which artifact of the Canvas it updates and how, and what it should leave alone. Name the artifact by its title or resourceId from get_canvas.");
/** What a caller is told after a Sidekick is made: making one is not a saved one. */
const SIDEKICK_NEXT = "The Sidekick is made and Rally's setup agent has the instructions. It is a draft until that agent saves it: check its status with get_canvas, and tell the person it may ask them a question in Rally.";

/** A refusal this server makes itself, before or instead of asking Rally, under its own code. */
class ToolRefusal extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ToolRefusal";
  }
}

/** What a tool's failure is logged as: Rally's own refusal code, this server's, a schema rejection's fields, or `tool_failed`. */
function failureCode(error: unknown, tool: string): string {
  if (error instanceof RallyApiError || error instanceof ToolRefusal) return error.code;
  return zodDiagnosticCode(error, tool) ?? (error instanceof Error ? `tool_failed:${error.name}` : "tool_failed");
}

/**
 * The sentence a refusal is reported in. Some of Rally's refusals carry only
 * their diagnostic code as the message (`canvas_publish_content_invalid:
 * files.0.content:base64`), which names the field but says nothing a person
 * reads, so the status supplies the sentence and the code follows it.
 */
function refusalText(error: RallyApiError): string {
  if (!isCodeShaped(error.message)) return `${error.message} (${error.code})`;
  const sentence = error.status === 400 || error.status === 422
    ? "Rally could not accept what was sent; the code names the part to correct"
    : error.status === 403 ? "The person is not allowed to do this in Rally"
      : error.status === 404 ? "Rally found nothing by that id that the person can open"
        : "Rally refused this request";
  return `${sentence} (${error.message})`;
}

/**
 * A value as a client's model reads it, for every tool result and resource: a
 * Canvas's audiences are stored as `workspace` for the Organization and read
 * `organization`. One function, so a tool and a resource cannot drift apart.
 */
function modelJson(value: unknown): string {
  return JSON.stringify(withModelNames(value, ORGANIZATION_MODEL_NAMES, ["visibility", "artifactVisibility"]), null, 2);
}

async function tool(name: string, operation: () => Promise<unknown>): Promise<ToolResult> {
  try {
    const result = await operation();
    const value = result instanceof Linked ? result.value : result;
    const links = result instanceof Linked ? result.links : [];
    return { content: [{ type: "text", text: typeof value === "string" ? value : modelJson(value) }, ...links] };
  } catch (error) {
    // The code and nothing else: a message can quote Canvas content.
    console.error(JSON.stringify({ event: "rally_mcp_tool_failed", tool: name, code: failureCode(error, name) }));
    const text = error instanceof RallyApiError
      ? `${refusalText(error)}${error.status === 401 ? ". The connection to Rally has ended; reconnect Rally to continue." : ""}`
      : error instanceof ToolRefusal ? `${error.message} (${error.code})`
        : error instanceof Error ? error.message : "The Rally tool failed";
    return { content: [{ type: "text", text }], isError: true };
  }
}

/** A request body as the route's own schema reads it, before its brands and defaults. */
type Body<S extends z.ZodType> = z.input<S>;

/** `GET /workspace/members`, as the API's route answers it. */
const MemberPageSchema = z.object({ items: z.array(WorkspaceMemberSchema) });

/**
 * The URI a client can read an artifact version back from
 * (`rally://canvas/<canvasId>/artifact/<id>/v<n>`). It names the Canvas
 * because Rally serves an MCP client an artifact only as one of a Canvas's.
 */
export function artifactUri(canvasId: string, resourceId: string, version: number): string {
  return `rally://canvas/${canvasId}/artifact/${resourceId}/v${version}`;
}

/** The subtypes whose bytes are text whatever their top-level type says. */
const TEXT_SUBTYPES = new Set(["json", "xml", "csv", "markdown", "javascript"]);

/**
 * Whether a content type's bytes are text: any `text/*`, a subtype that is
 * exactly one of `TEXT_SUBTYPES`, or a structured suffix of `+json` or `+xml`
 * (`image/svg+xml`). Matched on the parsed subtype, never a substring, so an
 * Office document (`application/vnd.openxmlformats-officedocument.*`, a zip)
 * is not mistaken for XML.
 */
export function isTextualType(contentType: string): boolean {
  const [top = "", subtype = ""] = (contentType.split(";")[0] ?? "").trim().toLowerCase().split("/");
  return top === "text" || TEXT_SUBTYPES.has(subtype) || subtype.endsWith("+json") || subtype.endsWith("+xml");
}

/**
 * One artifact version as text: Rally's extracted text once it exists, else
 * the original when that is already text, else a sentence saying it is not
 * ready. A version whose text has not been extracted yet reads as its
 * original when that is text.
 */
async function readArtifactText(api: RallyApi, canvasId: string, resourceId: string, version: number): Promise<string> {
  const read = async (representation: "model-content" | "content") => {
    const response = await api.send("GET", `/canvases/${canvasId}/artifacts/${resourceId}/versions/${version}/${representation}`);
    const type = response.headers.get("content-type") ?? "application/octet-stream";
    if (isTextualType(type)) return await response.text();
    await response.body?.cancel();
    return null;
  };
  const unavailable = (error: unknown) => error instanceof RallyApiError && error.code === "resource_version_content_unavailable";
  const model = await read("model-content").catch((error: unknown) => { if (unavailable(error)) return null; throw error; });
  if (model !== null) return model;
  const original = await read("content");
  return original ?? "This version has no text form to read yet. Try again later, or open the Canvas in Rally to see it.";
}

/** Publish into a Canvas, answering with the version it made and a link to it. */
async function publish(api: RallyApi, canvasId: string, body: Body<typeof CanvasPublishRequestSchema>): Promise<Linked> {
  const artifact = await api.json(CanvasPublishedArtifactSchema, "POST", `/canvases/${canvasId}/artifacts`, body);
  return new Linked(artifact, [{ type: "resource_link", uri: artifactUri(canvasId, artifact.resourceId, artifact.version), name: artifact.title }]);
}

/** One page of a Canvas's Chat as text, refusing a Sidekick's conversation. */
async function readChatPage(api: RallyApi, canvasId: string, page: { afterSequence?: number; throughSequence?: number; limit?: number } = {}): Promise<string> {
  const query = new URLSearchParams();
  if (page.afterSequence !== undefined) query.set("afterSequence", String(page.afterSequence));
  if (page.throughSequence !== undefined) query.set("throughSequence", String(page.throughSequence));
  if (page.limit !== undefined) query.set("limit", String(page.limit));
  const result = await api.json(ConversationTextPageSchema, "GET", `/conversations/${canvasId}/text${query.size > 0 ? `?${query}` : ""}`);
  if (result.kind !== "canvas") throw new ToolRefusal("conversation_not_canvas", "That id names a Sidekick, not a Canvas");
  const more = result.nextAfterSequence === null ? ""
    : `\n\nMore history: call again with afterSequence=${result.nextAfterSequence} and throughSequence=${result.throughSequence}.`;
  return `Canvas: ${result.title}\n\n${result.text || "No messages yet."}${more}`;
}

/**
 * An invitation as a client's model reads it. What it opens is stored as a
 * `workstream` in a `workspace`; the client is told the Canvas, and the one
 * conversation in it when the invitation is narrower than the Canvas.
 */
function invitationsForClient(result: z.infer<typeof ScopeInvitationResultSchema>) {
  const invitation = ({ targets, ...rest }: Extract<typeof result, { status: "revoked" }>["invitation"]) => ({
    ...rest,
    opens: targets.map((target) => target.kind === "workstream"
      ? { kind: "canvas" as const, canvasId: target.parentId }
      : { kind: "conversation" as const, canvasId: target.parentId, conversationId: target.substreamId }),
  });
  return result.status === "created" ? { status: result.status, invitations: result.invitations.map(invitation) }
    : result.status === "revoked" ? { status: result.status, invitation: invitation(result.invitation) }
      : result;
}

const read = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const write = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

/**
 * The tools a person's MCP client uses to create, change, share and look
 * after their Canvases, each one a call to the route the app itself makes.
 * `docs/rally-mcp.md#tools`.
 */
export function createRallyMcpServer(api: RallyApi): McpServer {
  const server = new McpServer({
    name: "Rally",
    version: "1.0.0",
    description: "Create, update, share and maintain Rally Canvases: shared conversations with Rally, each with the one artifact it makes, such as a document, a sheet or a site.",
  }, {
    instructions: RALLY_MCP_SERVER_INSTRUCTIONS,
  });

  server.registerTool("list_canvases", {
    title: "List Canvases",
    description: "List the Canvases the person can open in their Organization, most recently active first: id, title, who can open it (visibility), the kind of its newest artifact, whether it has unread activity, and whether it is pinned. Optionally filter by a case-insensitive title substring.",
    inputSchema: { query: z.string().optional().describe("Only Canvases whose title contains this text.") },
    annotations: read,
  }, ({ query }) => tool("list_canvases", async () => {
    // Rally filters, so a title is found among every Canvas, not only the most recent page.
    const needle = query?.trim();
    const { items } = await api.json(CanvasListSchema, "GET", needle ? `/canvases?${new URLSearchParams({ query: needle })}` : "/canvases");
    return items.map((row) => ({
      id: row.id, title: row.title, visibility: row.visibility, updatedAt: row.updatedAt, createdByUserId: row.createdByUserId,
      newestArtifactKind: row.artifactKind, unread: row.unread, pinned: row.pinnedPosition !== null,
      sharedWithMe: row.sharedWithMe, writtenBySidekickId: row.writerSidekickId,
    }));
  }));

  server.registerTool("get_canvas", {
    title: "Get a Canvas",
    description: "One Canvas as the person sees it: title, appearance, editor visibility and participant user ids, artifactVisibility and artifactUserIds, sharingRevision for concurrent-save protection, its artifacts at their current versions (resourceId, title, kind, version), the Sidekicks attached to it (id, name, status, and madeHere for one made for this Canvas), whether the person can manage it, and for a manager the access requests waiting on a decision.",
    inputSchema: { canvasId: CanvasId },
    annotations: read,
  }, ({ canvasId }) => tool("get_canvas", async () => {
    const detail = await api.json(CanvasDetailSchema, "GET", `/canvases/${canvasId}`);
    return new Linked(detail, detail.artifacts.map((artifact) => ({
      type: "resource_link" as const, uri: artifactUri(canvasId, artifact.resourceId, artifact.version), name: artifact.title,
      ...(artifact.mimeType ? { mimeType: artifact.mimeType } : {}),
    })));
  }));

  server.registerTool("read_canvas_chat", {
    title: "Read a Canvas's Chat",
    description: "Read a Canvas's Chat as text: what people and Rally said, with authors, attachment names and answered questions, oldest first. Tool calls and Rally's private reasoning are left out. Omit afterSequence for the first page; when the result says there is more, call again with the afterSequence and throughSequence it gives.",
    inputSchema: {
      canvasId: CanvasId,
      afterSequence: z.number().int().nonnegative().optional(),
      throughSequence: z.number().int().nonnegative().optional(),
      limit: z.number().int().positive().optional().describe("Turns per page; omit for Rally's default."),
    },
    annotations: read,
  }, ({ canvasId, afterSequence, throughSequence, limit }) => tool("read_canvas_chat", () =>
    readChatPage(api, canvasId, {
      ...(afterSequence === undefined ? {} : { afterSequence }),
      ...(throughSequence === undefined ? {} : { throughSequence }),
      ...(limit === undefined ? {} : { limit }),
    })));

  server.registerTool("list_people", {
    title: "List people",
    description: "Everyone active in the Organization, guests included: user id, name, email and role. Use it to find the user ids set_canvas_audience takes.",
    inputSchema: {},
    annotations: read,
  }, () => tool("list_people", async () => {
    const { items } = await api.json(MemberPageSchema, "GET", "/workspace/members");
    return items.map((member) => ({ userId: member.user.id, name: member.user.name, email: member.user.email,
      role: member.role, guest: member.accessClass === "guest" }));
  }));

  server.registerTool("read_artifact", {
    title: "Read an artifact",
    description: "For Canvas editors: read one artifact version as the text Rally itself reads it (a document's text, a sheet's cells, a site's source). Take canvasId, resourceId and version from get_canvas. Binary content is described rather than returned. Artifact-only users should use get_artifact_link to open the published output; artifact access does not grant source or version-history access.",
    inputSchema: { canvasId: CanvasId, resourceId: z.string().uuid(), version: z.number().int().positive() },
    annotations: read,
  }, ({ canvasId, resourceId, version }) => tool("read_artifact", () => readArtifactText(api, canvasId, resourceId, version)));

  server.registerTool("create_canvas", {
    title: "Create a Canvas",
    description: "Create a Canvas in the person's Organization. With a prompt, it is sent to the new Canvas's Chat as the person's first message and Rally starts working on it; without one the Canvas starts empty. With sidekick, a Sidekick is also made for the new Canvas to keep it up to date (see add_canvas_sidekick). Without a title Rally names it from its first message. A new Canvas opens to the Organization's default editor audience, everyone in the Organization unless an admin chose the creator only; get_canvas shows its visibility. Guests cannot create Canvases.",
    inputSchema: {
      operationId: OperationId,
      title: CreateCanvasRequestSchema.shape.title,
      prompt: z.string().trim().min(1).optional().describe("What Rally should make or do in the new Canvas."),
      sidekick: z.strictObject({ operationId: SidekickOperationId, instructions: SidekickInstructions }).optional()
        .describe("Also make a Sidekick for the new Canvas. Omit for a Canvas nothing updates on its own."),
    },
    annotations: write,
  }, ({ operationId, title, prompt, sidekick }) => tool("create_canvas", async () => {
    // The operation id is the Canvas's id and the first message's, so a retry
    // answers with the Canvas the first attempt made and sends its prompt once.
    const created = await api.json(CreatedCanvasSchema, "POST", "/canvases", {
      canvasId: operationId, ...(title ? { title } : {}),
      ...(prompt ? { prompt: { text: prompt, clientMessageId: operationId } } : {}),
      ...(sidekick ? { sidekick: { sidekickId: sidekick.operationId, instructions: { text: sidekick.instructions, clientMessageId: sidekick.operationId } } } : {}),
    } satisfies Body<typeof CreateCanvasRequestSchema>);
    return { ...created, next: [
      prompt ? "Rally is working on the prompt; read_canvas_chat to follow its answer." : "Send a message with send_canvas_message to start.",
      ...(sidekick ? [SIDEKICK_NEXT] : []),
    ].join(" ") };
  }));

  server.registerTool("add_canvas_sidekick", {
    title: "Add a Sidekick to a Canvas",
    description: "Make a Sidekick for a Canvas the person can open, so the Canvas is kept up to date on a schedule or on events without anyone asking. The Sidekick is attached to this Canvas: its runs can read and post in the Canvas's Chat and update its artifact, everyone in the Canvas can change or archive it by asking in the Chat, and archiving the Canvas archives it. It runs as the person, with their connected accounts. This call makes the Sidekick and hands your instructions to Rally's setup agent for it, which chooses the trigger and saves it; until then get_canvas shows it as draft. It is not a way to change an existing Sidekick: for that, ask in the Canvas's Chat.",
    inputSchema: { canvasId: CanvasId, operationId: SidekickOperationId, instructions: SidekickInstructions },
    annotations: { ...write, openWorldHint: true },
  }, ({ canvasId, operationId, instructions }) => tool("add_canvas_sidekick", async () => {
    // The operation id is the Sidekick's id and the instructions' message id,
    // so a retry answers with the Sidekick the first attempt made and sends
    // its instructions once.
    const added = await api.json(AddedCanvasSidekickSchema, "POST", `/canvases/${canvasId}/sidekicks`, {
      sidekickId: operationId, instructions: { text: instructions, clientMessageId: operationId },
    } satisfies Body<typeof AddCanvasSidekickRequestSchema>);
    return { ...added, next: SIDEKICK_NEXT };
  }));

  server.registerTool("send_canvas_message", {
    title: "Send a message to a Canvas",
    description: "Send a message to a Canvas's Chat as the person, exactly as typing it in Rally would. Rally answers in the Chat when the message is for it, and creates or edits the Canvas's artifacts when asked. Other people in the Canvas see the message. Returns the admission receipt; follow the answer with read_canvas_chat.",
    inputSchema: {
      canvasId: CanvasId,
      operationId: OperationId,
      text: z.string().trim().min(1),
      runMode: z.enum(["queue", "steer"]).optional().describe("While Rally is still working: queue waits for it to finish (the default), steer redirects it at its next step."),
    },
    annotations: { ...write, openWorldHint: true },
  }, ({ canvasId, operationId, text, runMode }) => tool("send_canvas_message", () =>
    api.json(WorkstreamMessageAdmissionReceiptSchema, "POST", `/conversations/${canvasId}/substreams/0/messages`, {
      text, clientMessageId: operationId, ...(runMode ? { runMode } : {}),
    })));

  server.registerTool("update_canvas", {
    title: "Update a Canvas",
    description: "Retitle a Canvas, or set its icon or colour. Pass null for icon or color to return it to the default. Anyone who can open the Canvas can do this.",
    inputSchema: {
      canvasId: CanvasId,
      title: CanvasUpdateRequestSchema.shape.title,
      icon: PickableWorkstreamIconKeySchema.nullable().optional(),
      color: z.enum(PROJECT_COLOR_RING).nullable().optional(),
    },
    annotations: write,
  }, ({ canvasId, title, icon, color }) => tool("update_canvas", () => api.json(CanvasDetailSchema, "PATCH", `/canvases/${canvasId}`, {
    ...(title ? { title } : {}),
    ...(icon !== undefined || color !== undefined ? { appearance: {
      ...(icon !== undefined ? { icon } : {}), ...(color !== undefined ? { color } : {}),
    } } : {}),
  } satisfies Body<typeof CanvasUpdateRequestSchema>)));

  server.registerTool("set_canvas_audience", {
    title: "Change Canvas editors and artifact access",
    description: "Replace Canvas editors and optionally artifact access. visibility/userIds controls who can read the conversation, send messages and change artifacts: creator, participants, or organization. userIds is required and replaces the whole editor list besides the creator. Read get_canvas first; for an artifact-only change, keep its visibility and copy participantUserIds into userIds so existing editors, including guests, retain access. Send [] only to remove all explicitly selected editors. artifactVisibility controls published artifacts only: editors, participants, organization, or public (anonymous). Editors always have artifact access. With organization editors, editors and participants artifact access are stored as organization (the whole Organization already reaches the artifacts), and any artifactUserIds are kept. This is one-way: moving editors off organization does not narrow artifact access, so send artifactVisibility explicitly when making a Canvas more private. The returned Canvas shows the stored value. artifactUserIds names additional artifact recipients, who may also be editors; it does not grant conversation access. Each supplied list replaces that audience. Use list_people to resolve names; pass sharingRevision as expectedRevision to avoid overwriting concurrent edits. Omitted artifact settings are preserved. Public access applies to all published artifacts in the Canvas. Propagation is asynchronous over Cloudflare Queues. Only Canvas managers can change sharing.",
    inputSchema: {
      canvasId: CanvasId,
      visibility: modelEnum(CanvasVisibilitySchema.unwrap().options, ORGANIZATION_MODEL_NAMES),
      userIds: z.array(z.string().uuid()),
      artifactVisibility: modelEnum(CanvasArtifactVisibilitySchema.unwrap().options, ORGANIZATION_MODEL_NAMES).optional(),
      artifactUserIds: z.array(z.string().uuid()).optional(),
      expectedRevision: z.number().int().nonnegative().optional(),
    },
    annotations: { ...write, destructiveHint: true },
  }, ({ canvasId, ...update }) => tool("set_canvas_audience", () =>
    api.json(CanvasDetailSchema, "POST", `/canvases/${canvasId}/audience`, update satisfies Body<typeof CanvasAudienceUpdateSchema>)));

  server.registerTool('get_artifact_link', {
    title: 'Get an artifact link',
    description: 'Get the stable shareable URL of a published file or website. resourceId comes from get_canvas or publishing. The Canvas artifact audience governs who can use the link; getting a link does not change access. Artifact-only users can get their artifact links without conversation access when they already know the resourceId. A newly published file may need a moment for background propagation before its link is ready.',
    inputSchema: {resourceId:z.string().uuid()},
    annotations: read,
  }, ({resourceId})=>tool('get_artifact_link',()=>api.json(ArtifactLinkSchema,'GET',`/resources/${resourceId}/artifact/link`)));

  server.registerTool("invite_canvas_guests", {
    title: "Invite guests to a Canvas",
    description: "Share a Canvas with people outside the Organization by email. Each becomes a guest editor who can read and converse in this Canvas; someone with a Rally account gets it at once, anyone else when they first sign in. Only the Canvas's managers can share.",
    inputSchema: {
      canvasId: CanvasId,
      operationId: OperationId,
      emails: z.array(z.string().trim().email()).min(1),
    },
    annotations: { ...write, openWorldHint: true },
  }, ({ canvasId, operationId, emails }) => tool("invite_canvas_guests", async () => {
    const workspace = await api.json(WorkspaceSchema, "GET", "/workspace");
    return invitationsForClient(await api.json(ScopeInvitationResultSchema, "POST", "/sharing", {
      operationId, parentId: canvasId, emails, expiresAt: null,
      targets: [{ kind: "workstream", workspaceId: workspace.id, parentId: canvasId }],
    }));
  }));

  server.registerTool("decide_canvas_access_request", {
    title: "Decide an access request",
    description: "Approve or deny a person's request to open a Canvas. The waiting requests are in get_canvas's pendingAccessRequests. Approving adds them to its participants. Only the Canvas's managers can decide.",
    inputSchema: { canvasId: CanvasId, userId: z.string().uuid(), decision: z.enum(["approve", "deny"]) },
    annotations: write,
  }, ({ canvasId, userId, decision }) => tool("decide_canvas_access_request", () =>
    api.json(CanvasAccessDecisionSchema, "POST", `/canvases/${canvasId}/access-requests/${userId}/decision`, { decision } satisfies Body<typeof CanvasAccessDecisionRequestSchema>)));

  server.registerTool("pin_canvas", {
    title: "Pin or unpin a Canvas",
    description: "Pin a Canvas to the top of the person's own Canvas list in Rally, or unpin it. Only the person sees their pins.",
    inputSchema: { canvasId: CanvasId, pinned: z.boolean() },
    annotations: write,
  }, ({ canvasId, pinned }) => tool("pin_canvas", async () => {
    await api.empty("POST", `/canvases/${canvasId}/pin`, { pinned });
    return { canvasId, pinned };
  }));

  server.registerTool("rename_artifact", {
    title: "Rename an artifact",
    description: "Rename an artifact a Canvas generated. Every Canvas that shows it reads the new title.",
    inputSchema: { canvasId: CanvasId, resourceId: z.string().uuid(), title: ResourceSchema.shape.title },
    annotations: write,
  }, ({ canvasId, resourceId, title }) => tool("rename_artifact", async () => {
    await api.empty("PATCH", `/conversations/${canvasId}/resources/${resourceId}`, { title });
    return { resourceId, title };
  }));

  // The publish route's own field schemas, so a bound is set in one place
  // (`CanvasPublishRequestSchema`) and refused here before the upload.
  const [FilePublish, SitePublish] = CanvasPublishRequestSchema.options;
  const Content = {
    content: CanvasPublishContentSchema.shape.data.describe("The content: the text itself, or base64 when encoding is base64."),
    encoding: CanvasPublishContentSchema.shape.encoding.default("text").describe("text for anything textual; base64 for images, PDFs, spreadsheets and other bytes, and for any file over 1 MB, text included: escaping can make large text several times longer and push the request past Rally's size limit, while base64 grows by exactly a third."),
  };
  const Name = FilePublish.shape.name.describe(
    "The artifact's name in this Canvas, as a relative path such as launch-plan.md or reports/q3.csv. Publishing under the same name again makes a new version of the same artifact, which the Canvas keeps alongside the earlier ones; publishing unchanged content does nothing, so a publish is safe to repeat. A new name makes a new artifact.");

  server.registerTool("publish_file", {
    title: "Publish a file to a Canvas",
    description: "Publish a document, spreadsheet, image, PDF or other file you made (a Claude or ChatGPT artifact, a file in an OpenCode workspace) into a Canvas as its artifact, as the person. A Canvas holds one artifact: the same name again is a new version of it, and another name takes the place of the artifact the Canvas held. Its Canvas artifact audience controls who can use it; editors can ask Rally to change it. Use get_artifact_link for the shareable URL after background propagation. Give the file's extension in the name so Rally knows its type.",
    inputSchema: {
      canvasId: CanvasId,
      name: Name,
      title: FilePublish.shape.title.describe("The title people see; the name by default."),
      description: FilePublish.shape.description,
      mimeType: FilePublish.shape.mimeType.describe("The content type, when the name's extension does not say it."),
      ...Content,
    },
    annotations: write,
  }, ({ canvasId, name, title, description, mimeType, content, encoding }) => tool("publish_file", () => publish(api, canvasId, {
    kind: "file", name, ...(title ? { title } : {}), ...(description ? { description } : {}), ...(mimeType ? { mimeType } : {}),
    content: { encoding, data: content },
  })));

  server.registerTool("publish_site", {
    title: "Publish a site to a Canvas",
    description: `Publish something that runs in a browser into a Canvas as a reactive site Rally serves at its own address, governed by the Canvas artifact audience. Editors can change the site; public artifact access never opens the conversation. Use get_artifact_link for its shareable URL. Send any of: (1) files ready to serve, with an index.html entry page, such as a self-contained HTML artifact; (2) a React component exactly as Claude or ChatGPT writes it, one .jsx or .tsx file with a default export, which may use Tailwind classes, ${COMPONENT_LIBRARIES.join(", ")} and shadcn/ui's ${COMPONENT_UI_MODULES.join(", ")}; (3) a project with a package.json build script, which only the Organization's members (not guests) may publish. Rally builds a component or project in the Canvas's sandbox, opens it in a browser, and refuses it with the reason if it throws or shows nothing. Building can take from a few seconds to a minute. A new version of a site is served at the same address. Server code (index.js) is not accepted here.`,
    inputSchema: {
      canvasId: CanvasId,
      name: Name,
      title: SitePublish.shape.title,
      description: SitePublish.shape.description,
      files: z.array(z.object({ path: SitePublish.shape.files.element.shape.path, ...Content })).min(1),
    },
    annotations: write,
  }, ({ canvasId, name, title, description, files }) => tool("publish_site", () => publish(api, canvasId, {
    kind: "site", name, ...(title ? { title } : {}), ...(description ? { description } : {}),
    files: files.map((file) => ({ path: file.path, content: { encoding: file.encoding, data: file.content } })),
  })));

  // Resources: what a person or client attaches as context, and what tool
  // results link to. Templates only: listing Canvases is `list_canvases`.
  const uuid = z.string().uuid();
  const one = (value: string | string[] | undefined) => uuid.parse(Array.isArray(value) ? value[0] : value);
  server.registerResource("canvas", new ResourceTemplate("rally://canvas/{canvasId}", { list: undefined }), {
    title: "Canvas", description: "A Canvas as the person sees it: title, who can open it, and its artifacts at their current versions.", mimeType: "application/json",
  }, async (uri, variables) => ({ contents: [{ uri: uri.href, mimeType: "application/json",
    text: modelJson(await api.json(CanvasDetailSchema, "GET", `/canvases/${one(variables.canvasId)}`)) }] }));
  server.registerResource("canvas-chat", new ResourceTemplate("rally://canvas/{canvasId}/chat", { list: undefined }), {
    title: "Canvas Chat", description: "The first page of a Canvas's Chat as text; read_canvas_chat pages further.", mimeType: "text/plain",
  }, async (uri, variables) => ({ contents: [{ uri: uri.href, mimeType: "text/plain", text: await readChatPage(api, one(variables.canvasId)) }] }));
  server.registerResource("artifact", new ResourceTemplate("rally://canvas/{canvasId}/artifact/{resourceId}/v{version}", { list: undefined }), {
    title: "Artifact version", description: "One version of one of a Canvas's artifacts as text, as read_artifact reads it.", mimeType: "text/plain",
  }, async (uri, variables) => {
    const version = z.coerce.number().int().positive().parse(Array.isArray(variables.version) ? variables.version[0] : variables.version);
    return { contents: [{ uri: uri.href, mimeType: "text/plain", text: await readArtifactText(api, one(variables.canvasId), one(variables.resourceId), version) }] };
  });

  // Prompts: what a person starts by name (Claude shows them as slash commands).
  const ask = (text: string) => ({ messages: [{ role: "user" as const, content: { type: "text" as const, text } }] });
  server.registerPrompt("publish_to_rally", {
    title: "Publish this to Rally",
    description: "Publish what was just made here into a Rally Canvas, exactly as it is.",
    argsSchema: { canvas: z.string().optional().describe("The Canvas to publish into; Rally finds or creates one if omitted.") },
  }, ({ canvas }) => ask(renderPublishToRallyPrompt(canvas)));
  server.registerPrompt("start_canvas", {
    title: "Start a Canvas from this conversation",
    description: "Create a Rally Canvas seeded with a summary of this conversation.",
    argsSchema: { title: z.string().optional().describe("The Canvas's title; Rally names it if omitted.") },
  }, ({ title }) => ask(renderStartCanvasPrompt(title)));
  server.registerPrompt("catch_up", {
    title: "Catch me up on a Canvas",
    description: "Summarize what happened in a Rally Canvas: its Chat and its artifact's latest version.",
    argsSchema: { canvas: z.string().describe("The Canvas's title, or words from it.") },
  }, ({ canvas }) => ask(renderCatchUpPrompt(canvas)));

  return server;
}
