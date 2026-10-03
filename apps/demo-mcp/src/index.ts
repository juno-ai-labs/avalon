import { createMcpHandler } from "agents/mcp/server";

import {
  accessFailureMessage,
  readAccessConfiguration,
  type AccessPrincipal,
  verifyAccessRequest,
} from "./access";
import type { Env } from "./env";
import { createDemoMcpServer } from "./server";
import hostedClients from "../hosted-clients.json";

export function createDemoMcpHandler(
  env: Env,
  principal: AccessPrincipal,
  responseMode: "auto" | "json" | "sse" = "auto",
) {
  return createMcpHandler(() => createDemoMcpServer(env, principal), {
    allowedOriginHostnames: hostedClients.originHostnames,
    responseMode,
  });
}

export default {
  async fetch(request, env, context): Promise<Response> {
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
    return createDemoMcpHandler(env, access.principal)(
      request,
      env,
      context,
    );
  },
} satisfies ExportedHandler<Env>;
