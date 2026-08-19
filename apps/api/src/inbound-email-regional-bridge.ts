import { WorkerEntrypoint } from "cloudflare:workers";
import type { Env } from "./env";
import {
  ResendRegionalEmailService,
  serializeResendRegionalRpcResult,
} from "./services/resend-inbound-email-service";
import { ResendRegionalEmailInputSchema, parseRpcInput } from "./lib/rpc-contracts";
import { requireWorkstreamIngress } from "./services/workstream-authority";

/** Account-internal RPC surface used by the Global Resend receiving ingress. */
export class InboundEmailRegionalBridge extends WorkerEntrypoint<Env> {
  ingestResendEmail(input: unknown) {
    return serializeResendRegionalRpcResult(async () => {
      await requireWorkstreamIngress(this.env);
      const { targetType, workstreamId, automationSubscriptionId, ...route } =
        parseRpcInput(ResendRegionalEmailInputSchema, input, "ingestResendEmail");
      // `exactOptionalPropertyTypes` distinguishes an absent key from one set to
      // `undefined`; Zod's `.optional()` produces the latter, so the optional
      // routing targets are re-attached only when they carry a value.
      return new ResendRegionalEmailService(this.env).ingest({
        ...route,
        ...(targetType ? { targetType } : {}),
        ...(workstreamId ? { workstreamId } : {}),
        ...(automationSubscriptionId ? { automationSubscriptionId } : {}),
      });
    });
  }
}
