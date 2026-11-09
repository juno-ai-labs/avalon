import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { CanvasVisibilitySchema } from "@rally/contracts/canvases";
import { PickableWorkstreamIconKeySchema, PROJECT_COLOR_RING } from "@rally/contracts";
import { zodDiagnosticCode } from "@rally/contracts/zod-diagnostics";

import { RallyApiError, type RallyApi } from "./api";

type ToolResult = { content: [{ type: "text"; text: string }]; isError?: boolean };

const CanvasId = z.string().uuid().describe("The Canvas's id, from list_canvases or create_canvas.");
const OperationId = z.string().uuid().describe(
  "A fresh UUID for this operation. After an uncertain result, call again with the same operationId and arguments: Rally answers with the first attempt's result rather than doing it twice.");

/** What a tool's failure is logged as: Rally's own refusal code, a schema rejection's fields, or `tool_failed`. */
function failureCode(error: unknown, tool: string): string {
  if (error instanceof RallyApiError) return error.code;
  return zodDiagnosticCode(error, tool) ?? (error instanceof Error ? `tool_failed:${error.name}` : "tool_failed");
}

async function tool(name: string, operation: () => Promise<unknown>): Promise<ToolResult> {
  try {
    const value = await operation();
    return { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] };
  } catch (error) {
    // The code and nothing else: a message can quote Canvas content.
    console.error(JSON.stringify({ event: "rally_mcp_tool_failed", tool: name, code: failureCode(error, name) }));
    const text = error instanceof RallyApiError
      ? `${error.message} (${error.code})${error.status === 401 ? ". The connection to Rally has ended; reconnect Rally to continue." : ""}`
      : error instanceof Error ? error.message : "The Rally tool failed";
    return { content: [{ type: "text", text }], isError: true };
  }
}

interface CanvasRow {
  id: string; title: string; visibility: string; updatedAt: string; createdByUserId: string;
  artifactKind: string | null; unread: boolean; pinnedPosition: number | null; sharedWithMe: boolean;
  writerSidekickId: string | null;
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
    description: "Create, update, share and maintain Rally Canvases: shared conversations with Rally and the documents, sheets, sites and other artifacts they generate.",
  }, {
    instructions: [
      "Rally is a shared workspace. A Canvas is a conversation with Rally (its Chat) that everyone in the Canvas can read and join, plus the artifacts that conversation generates. You act in one Organization, as the person who connected Rally, with exactly their permissions.",
      "To make or change an artifact, send a message to the Canvas's Chat with send_canvas_message describing what you want; Rally (the agent in the Canvas) does the work and publishes the artifact. Then read_canvas_chat to follow its answer and get_canvas to see the artifacts and their versions. Rally works asynchronously: a reply can take a while, so read again rather than resending.",
      "To bring in something already made elsewhere (an artifact, a file, a page), publish it with publish_file or publish_site rather than pasting it into a message: it lands as the Canvas's artifact, exactly as written, and the same name updates it.",
      "Start with list_canvases to find a Canvas by title before creating a new one. Use list_people to turn names into user ids before changing who can open a Canvas.",
      "Every write takes the person's own permissions: only a Canvas's managers (its creator, the Organization's owners and admins) can change its audience or decide access requests. Report a refusal as Rally gave it rather than retrying.",
      "Writes that take an operationId are safe to retry with the same operationId and arguments after an uncertain result. Never invent a new operationId for a retry.",
    ].join("\n\n"),
  });

  server.registerTool("list_canvases", {
    title: "List Canvases",
    description: "List the Canvases the person can open in their Organization, most recently active first: id, title, who can open it (visibility), the kind of its newest artifact, whether it has unread activity, and whether it is pinned. Optionally filter by a case-insensitive title substring.",
    inputSchema: { query: z.string().optional().describe("Only Canvases whose title contains this text.") },
    annotations: read,
  }, ({ query }) => tool("list_canvases", async () => {
    const { items } = await api.json<{ items: CanvasRow[] }>("GET", "/canvases");
    const needle = query?.trim().toLowerCase();
    return items.filter((row) => !needle || row.title.toLowerCase().includes(needle)).map((row) => ({
      id: row.id, title: row.title, visibility: row.visibility, updatedAt: row.updatedAt, createdByUserId: row.createdByUserId,
      newestArtifactKind: row.artifactKind, unread: row.unread, pinned: row.pinnedPosition !== null,
      sharedWithMe: row.sharedWithMe, writtenBySidekickId: row.writerSidekickId,
    }));
  }));

  server.registerTool("get_canvas", {
    title: "Get a Canvas",
    description: "One Canvas as the person sees it: title, appearance, visibility, the participant user ids, its artifacts at their current versions (resourceId, title, kind, version), whether the person can manage it, and for a manager the access requests waiting on a decision.",
    inputSchema: { canvasId: CanvasId },
    annotations: read,
  }, ({ canvasId }) => tool("get_canvas", () => api.json("GET", `/canvases/${canvasId}`)));

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
  }, ({ canvasId, afterSequence, throughSequence, limit }) => tool("read_canvas_chat", async () => {
    const query = new URLSearchParams();
    if (afterSequence !== undefined) query.set("afterSequence", String(afterSequence));
    if (throughSequence !== undefined) query.set("throughSequence", String(throughSequence));
    if (limit !== undefined) query.set("limit", String(limit));
    const page = await api.json<{ kind: string; title: string; text: string; throughSequence: number; nextAfterSequence: number | null }>(
      "GET", `/conversations/${canvasId}/text${query.size > 0 ? `?${query}` : ""}`);
    if (page.kind !== "canvas") throw new Error("That id names a Sidekick, not a Canvas");
    const more = page.nextAfterSequence === null ? ""
      : `\n\nMore history: call again with afterSequence=${page.nextAfterSequence} and throughSequence=${page.throughSequence}.`;
    return `Canvas: ${page.title}\n\n${page.text || "No messages yet."}${more}`;
  }));

  server.registerTool("list_people", {
    title: "List people",
    description: "Everyone active in the Organization, guests included: user id, name, email and role. Use it to find the user ids set_canvas_audience takes.",
    inputSchema: {},
    annotations: read,
  }, () => tool("list_people", async () => {
    const { items } = await api.json<{ items: Array<{ user: { id: string; name: string; email: string }; role: string | null; accessClass?: string }> }>(
      "GET", "/workspace/members");
    return items.map((member) => ({ userId: member.user.id, name: member.user.name, email: member.user.email,
      role: member.role, guest: member.accessClass === "guest" }));
  }));

  server.registerTool("read_artifact", {
    title: "Read an artifact",
    description: "Read one version of an artifact a Canvas generated, as the text Rally itself reads it (a document's text, a sheet's cells, a site's source). Take resourceId and version from get_canvas. Binary content is described rather than returned.",
    inputSchema: { resourceId: z.string().uuid(), version: z.number().int().positive() },
    annotations: read,
  }, ({ resourceId, version }) => tool("read_artifact", async () => {
    const response = await api.send("GET", `/resources/${resourceId}/versions/${version}/model-content`);
    const type = response.headers.get("content-type") ?? "application/octet-stream";
    if (/^text\/|json|xml|csv|markdown|javascript/u.test(type)) return await response.text();
    await response.body?.cancel();
    return `This version is ${type} content, which has no text form to read here. Open the Canvas in Rally to see it.`;
  }));

  server.registerTool("create_canvas", {
    title: "Create a Canvas",
    description: "Create a Canvas in the person's Organization. With a prompt, it is sent to the new Canvas's Chat as the person's first message and Rally starts working on it; without one the Canvas starts empty. Without a title Rally names it from its first message. Only the creator can open a new Canvas until its audience is changed. Guests cannot create Canvases.",
    inputSchema: {
      operationId: OperationId,
      title: z.string().trim().min(1).max(300).optional(),
      prompt: z.string().trim().min(1).optional().describe("What Rally should make or do in the new Canvas."),
    },
    annotations: write,
  }, ({ operationId, title, prompt }) => tool("create_canvas", async () => {
    // The operation id is the Canvas's id and the first message's, so a retry
    // answers with the Canvas the first attempt made and sends its prompt once.
    const created = await api.json<{ canvasId: string; turnId: string | null }>("POST", "/canvases", {
      canvasId: operationId, ...(title ? { title } : {}),
      ...(prompt ? { prompt: { text: prompt, clientMessageId: operationId } } : {}),
    });
    return { ...created, next: prompt ? "Rally is working on the prompt; read_canvas_chat to follow its answer." : "Send a message with send_canvas_message to start." };
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
    api.json("POST", `/conversations/${canvasId}/substreams/0/messages`, {
      text, clientMessageId: operationId, ...(runMode ? { runMode } : {}),
    })));

  server.registerTool("update_canvas", {
    title: "Update a Canvas",
    description: "Retitle a Canvas, or set its icon or colour. Pass null for icon or color to return it to the default. Anyone who can open the Canvas can do this.",
    inputSchema: {
      canvasId: CanvasId,
      title: z.string().trim().min(1).max(300).optional(),
      icon: PickableWorkstreamIconKeySchema.nullable().optional(),
      color: z.enum(PROJECT_COLOR_RING).nullable().optional(),
    },
    annotations: write,
  }, ({ canvasId, title, icon, color }) => tool("update_canvas", () => api.json("PATCH", `/canvases/${canvasId}`, {
    ...(title ? { title } : {}),
    ...(icon !== undefined || color !== undefined ? { appearance: {
      ...(icon !== undefined ? { icon } : {}), ...(color !== undefined ? { color } : {}),
    } } : {}),
  })));

  server.registerTool("set_canvas_audience", {
    title: "Change who can open a Canvas",
    description: "Replace who can open a Canvas. visibility 'creator' is its creator alone (userIds empty); 'participants' is the creator and the people named in userIds (at least one); 'workspace' is every member of the Organization plus anyone named. userIds is the whole list, not an addition: read get_canvas first and send the full list. Everyone named must already be in the Organization; invite outsiders with invite_canvas_guests. Only the Canvas's managers can do this.",
    inputSchema: {
      canvasId: CanvasId,
      visibility: CanvasVisibilitySchema,
      userIds: z.array(z.string().uuid()).default([]),
    },
    annotations: { ...write, destructiveHint: true },
  }, ({ canvasId, visibility, userIds }) => tool("set_canvas_audience", () =>
    api.json("POST", `/canvases/${canvasId}/audience`, { visibility, userIds })));

  server.registerTool("invite_canvas_guests", {
    title: "Invite guests to a Canvas",
    description: "Share a Canvas with people outside the Organization by email. Each becomes a guest who can open this Canvas only; someone with a Rally account gets it at once, anyone else when they first sign in. Only the Canvas's managers can share.",
    inputSchema: {
      canvasId: CanvasId,
      operationId: OperationId,
      emails: z.array(z.string().trim().email()).min(1),
    },
    annotations: { ...write, openWorldHint: true },
  }, ({ canvasId, operationId, emails }) => tool("invite_canvas_guests", async () => {
    const workspace = await api.json<{ id: string }>("GET", "/workspace");
    return api.json("POST", "/sharing", {
      operationId, parentId: canvasId, emails, expiresAt: null,
      targets: [{ kind: "workstream", workspaceId: workspace.id, parentId: canvasId }],
    });
  }));

  server.registerTool("decide_canvas_access_request", {
    title: "Decide an access request",
    description: "Approve or deny a person's request to open a Canvas. The waiting requests are in get_canvas's pendingAccessRequests. Approving adds them to its participants. Only the Canvas's managers can decide.",
    inputSchema: { canvasId: CanvasId, userId: z.string().uuid(), decision: z.enum(["approve", "deny"]) },
    annotations: write,
  }, ({ canvasId, userId, decision }) => tool("decide_canvas_access_request", () =>
    api.json("POST", `/canvases/${canvasId}/access-requests/${userId}/decision`, { decision })));

  server.registerTool("pin_canvas", {
    title: "Pin or unpin a Canvas",
    description: "Pin a Canvas to the top of the person's own Canvas list in Rally, or unpin it. Only the person sees their pins.",
    inputSchema: { canvasId: CanvasId, pinned: z.boolean() },
    annotations: write,
  }, ({ canvasId, pinned }) => tool("pin_canvas", async () => {
    await api.json("POST", `/canvases/${canvasId}/pin`, { pinned });
    return { canvasId, pinned };
  }));

  server.registerTool("rename_artifact", {
    title: "Rename an artifact",
    description: "Rename an artifact a Canvas generated. Every Canvas that shows it reads the new title.",
    inputSchema: { canvasId: CanvasId, resourceId: z.string().uuid(), title: z.string().trim().min(1).max(300) },
    annotations: write,
  }, ({ canvasId, resourceId, title }) => tool("rename_artifact", async () => {
    await api.json("PATCH", `/conversations/${canvasId}/resources/${resourceId}`, { title });
    return { resourceId, title };
  }));

  const Content = {
    content: z.string().describe("The content: the text itself, or base64 when encoding is base64."),
    encoding: z.enum(["text", "base64"]).default("text").describe("text for anything textual; base64 for images, PDFs, spreadsheets and other bytes."),
  };
  const Name = z.string().min(1).max(1024).describe(
    "The artifact's name in this Canvas, as a relative path such as launch-plan.md or reports/q3.csv. Publishing the same name again makes a new version of the same artifact; a new name makes a new artifact.");

  server.registerTool("publish_file", {
    title: "Publish a file to a Canvas",
    description: "Publish a document, spreadsheet, image, PDF or other file you made (a Claude or ChatGPT artifact, a file in an OpenCode workspace) into a Canvas as one of its artifacts, as the person. Everyone who can open the Canvas sees it, and Rally can read and work on it there. Publish under the same name again to update it: the Canvas keeps each version. Publishing content that has not changed does nothing. Give the file's extension in the name so Rally knows its type.",
    inputSchema: {
      canvasId: CanvasId,
      name: Name,
      title: z.string().trim().min(1).max(300).optional().describe("The title people see; the name by default."),
      description: z.string().trim().min(1).max(2000).optional(),
      mimeType: z.string().max(160).optional().describe("The content type, when the name's extension does not say it."),
      ...Content,
    },
    annotations: write,
  }, ({ canvasId, name, title, description, mimeType, content, encoding }) => tool("publish_file", () =>
    api.json("POST", `/canvases/${canvasId}/artifacts`, {
      kind: "file", name, ...(title ? { title } : {}), ...(description ? { description } : {}), ...(mimeType ? { mimeType } : {}),
      content: { encoding, data: content },
    })));

  server.registerTool("publish_site", {
    title: "Publish a site to a Canvas",
    description: "Publish a static web page or site you made (an HTML artifact, a built front end) into a Canvas as a live site Rally serves at its own address, for everyone who can open the Canvas. files must include index.html, its entry page; other files (CSS, scripts, images) are served beside it at their paths. A self-contained HTML page is one file, index.html. Publish under the same name again to update the site at the same address. Server code (index.js) is not accepted here; ask Rally in the Canvas to build a site that needs one.",
    inputSchema: {
      canvasId: CanvasId,
      name: Name,
      title: z.string().trim().min(1).max(300).optional(),
      description: z.string().trim().min(1).max(2000).optional(),
      files: z.array(z.object({ path: z.string().min(1).max(1024), ...Content })).min(1),
    },
    annotations: write,
  }, ({ canvasId, name, title, description, files }) => tool("publish_site", () =>
    api.json("POST", `/canvases/${canvasId}/artifacts`, {
      kind: "site", name, ...(title ? { title } : {}), ...(description ? { description } : {}),
      files: files.map((file) => ({ path: file.path, content: { encoding: file.encoding, data: file.content } })),
    })));

  return server;
}
