import { createMcpHandler } from "agents/mcp/server";

import {
  accessFailureMessage,
  readAccessConfiguration,
  verifyAccessRequest,
} from "./access";
import type { Env } from "./env";
import { createEngineeringMcpServer } from "./server";

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
    return createMcpHandler(() => createEngineeringMcpServer(env, access.principal))(
      request,
      env,
      context,
    );
  },
} satisfies ExportedHandler<Env>;
