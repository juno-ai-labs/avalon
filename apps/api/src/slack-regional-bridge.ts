import { WorkerEntrypoint } from "cloudflare:workers";
import type { Env } from "./env";
import { SlackAgentService } from "./services/slack-agent-service";
import { serializeSlackRpcResult } from "./services/slack-routing-service";
import {
  SlackCommandRpcInputSchema,
  SlackEventRpcInputSchema,
  SlackInteractionRpcInputSchema,
  parseRpcInput,
} from "./lib/rpc-contracts";
import { requireWorkstreamIngress } from "./services/workstream-authority";

export class SlackRegionalBridge extends WorkerEntrypoint<Env> {
  processSlackEvent(input: unknown) {
    return serializeSlackRpcResult(async () => {
      await requireWorkstreamIngress(this.env);
      const parsed = parseRpcInput(SlackEventRpcInputSchema, input, "processSlackEvent");
      return new SlackAgentService(this.env).processEvent(parsed.payload, parsed.bodyHash);
    });
  }

  processSlackInteraction(input: unknown) {
    return serializeSlackRpcResult(async () => {
      await requireWorkstreamIngress(this.env);
      const parsed = parseRpcInput(SlackInteractionRpcInputSchema, input, "processSlackInteraction");
      return new SlackAgentService(this.env).processInteraction(parsed.payload, parsed.bodyHash);
    });
  }

  processSlackCommand(input: unknown) {
    return serializeSlackRpcResult(async () => {
      await requireWorkstreamIngress(this.env);
      const parsed = parseRpcInput(SlackCommandRpcInputSchema, input, "processSlackCommand");
      return new SlackAgentService(this.env).processCommand(parsed.form, parsed.bodyHash);
    });
  }
}
