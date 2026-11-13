import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";

import {
  accessFailureMessage,
  readAccessConfiguration,
  type AccessPrincipal,
  verifyAccessRequest,
} from "./access";
import type { Env } from "./env";
import { createEngineeringMcpServer } from "./server";
import hostedClients from "../hosted-clients.json";
import { TASK_CARRIER, TASK_METHODS, TaskSnapshotSchema, taskDispatchMethod } from "./tasks";

const TaskRequestSchema = z.object({
  id: z.union([z.string(), z.number()]), method: z.enum(TASK_METHODS),
  params: z.object({ taskId: z.string() }).passthrough(),
}).passthrough();

const TaskCarrierResponseSchema = z.object({
  jsonrpc: z.literal("2.0"), id: z.union([z.string(), z.number()]),
  result: z.object({ _meta: z.object({ [TASK_CARRIER]: TaskSnapshotSchema }).passthrough() }),
});

// SEP-2243 permits UTF-8 Base64 sentinels in Mcp-Name. The SDK validates
// ordinary tool headers; private task dispatch must preserve the same check.
function taskNameHeader(request: Request): string | undefined {
  const value = request.headers.get("Mcp-Name")?.trim();
  if (!value?.startsWith("=?base64?") || !value.endsWith("?=")) return value;
  const encoded = value.slice(9, -2);
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) return undefined;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0)));
  } catch { return undefined; }
}

export function createEngineeringMcpHandler(
  env: Env,
  principal: AccessPrincipal,
  ctx?: Pick<ExecutionContext, "waitUntil">,
) {
  return {
    async fetch(request: Request) {
      let createdTask = false;
      const handler = createMcpHandler(() => createEngineeringMcpServer(env, principal, () => { createdTask = true; }, ctx && ((promise) => ctx.waitUntil(promise))), {
        allowedOriginHostnames: hostedClients.originHostnames,
      });
      const headerMethod = request.headers.get("Mcp-Method");
      if (request.method === "POST" && TASK_METHODS.some((method) => method === headerMethod)) {
        const body = await request.text();
        let parsed: unknown;
        try { parsed = JSON.parse(body); } catch { /* The SDK reports malformed JSON. */ }
        const taskRequest = TaskRequestSchema.safeParse(parsed);
        if (taskRequest.success && taskRequest.data.method === headerMethod
          && taskNameHeader(request) === taskRequest.data.params.taskId) {
          const method = taskDispatchMethod(taskRequest.data.method);
          const headers = new Headers(request.headers);
          headers.set("Mcp-Method", method);
          request = new Request(request, { headers, body: JSON.stringify({ ...taskRequest.data, method }) });
        } else {
          request = new Request(request, { body });
        }
      }
      const response = await handler.fetch(request);
      // Polls may carry large results. Only task-creating tool responses need
      // inspection; leave every other SDK response body untouched.
      if (!createdTask || !response.ok || !response.headers.get("content-type")?.includes("application/json")) return response;
      const body = await response.text();
      // Task creation emits no notifications, so auto mode returns JSON.
      const carrier = TaskCarrierResponseSchema.parse(JSON.parse(body));
      const { [TASK_CARRIER]: task, ...meta } = carrier.result._meta;
      return Response.json({
        jsonrpc: "2.0", id: carrier.id,
        result: { ...task, resultType: "task", _meta: meta },
      }, { status: response.status, headers: response.headers });
    },
  };
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    if (new URL(request.url).pathname !== "/mcp") {
      return new Response("Not found", { status: 404 });
    }
    const access = await verifyAccessRequest(request, readAccessConfiguration(env));
    if (!access.ok) {
      return Response.json({
        error: access.reason,
        message: accessFailureMessage(access.reason),
      }, { status: 403 });
    }
    return createEngineeringMcpHandler(env, access.principal, ctx).fetch(request);
  },
} satisfies ExportedHandler<Env>;
