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

export function createEngineeringMcpHandler(
  env: Env,
  principal: AccessPrincipal,
  responseMode: "json" = "json",
) {
  const handler = createMcpHandler(() => createEngineeringMcpServer(env, principal), {
    allowedOriginHostnames: hostedClients.originHostnames,
    responseMode,
  });
  return {
    async fetch(request: Request) {
      const headerMethod = request.headers.get("Mcp-Method");
      const mayCreateTask = headerMethod === "tools/call"
        && ["query_data_lake", "retire_org"].includes(request.headers.get("Mcp-Name") ?? "");
      if (request.method === "POST" && TASK_METHODS.some((method) => method === headerMethod)) {
        const body = await request.text();
        let parsed: unknown;
        try { parsed = JSON.parse(body); } catch { /* The SDK reports malformed JSON. */ }
        const taskRequest = TaskRequestSchema.safeParse(parsed);
        if (taskRequest.success && taskRequest.data.method === headerMethod
          && request.headers.get("Mcp-Name") === taskRequest.data.params.taskId) {
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
      if (!mayCreateTask || !response.ok || !response.headers.get("content-type")?.includes("application/json")) return response;
      const body: unknown = await response.json();
      const carrier = TaskCarrierResponseSchema.safeParse(body);
      if (!carrier.success) return Response.json(body, { status: response.status, headers: response.headers });
      const { [TASK_CARRIER]: task, ...meta } = carrier.data.result._meta;
      return Response.json({
        jsonrpc: "2.0", id: carrier.data.id,
        result: { ...task, resultType: "task", _meta: meta },
      }, { status: response.status, headers: response.headers });
    },
  };
}

export default {
  async fetch(request, env): Promise<Response> {
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
    return createEngineeringMcpHandler(env, access.principal).fetch(request);
  },
} satisfies ExportedHandler<Env>;
