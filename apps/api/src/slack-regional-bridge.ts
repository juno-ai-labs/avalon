import { WorkerEntrypoint } from "cloudflare:workers";
import type { Env } from "./env";
import { SlackAgentService } from "./services/slack-agent-service";
import { serializeSlackRpcResult } from "./services/slack-routing-service";

export class SlackRegionalBridge extends WorkerEntrypoint<Env> {
  processSlackEvent(input: { payload: unknown; bodyHash: string }) {
    return serializeSlackRpcResult(() => new SlackAgentService(this.env).processEvent(input.payload, input.bodyHash));
  }

  processSlackInteraction(input: { payload: Record<string, unknown>; bodyHash: string }) {
    return serializeSlackRpcResult(() => new SlackAgentService(this.env).processInteraction(input.payload, input.bodyHash));
  }

  processSlackCommand(input: { form: Record<string, string>; bodyHash: string }) {
    return serializeSlackRpcResult(() => new SlackAgentService(this.env).processCommand(input.form, input.bodyHash));
  }
}
