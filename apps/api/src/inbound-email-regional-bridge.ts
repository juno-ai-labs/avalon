import { WorkerEntrypoint } from "cloudflare:workers";
import type { Env } from "./env";
import {
  ResendRegionalEmailService,
  serializeResendRegionalRpcResult,
  type ResendRegionalEmailInput,
} from "./services/resend-inbound-email-service";

/** Account-internal RPC surface used by the Global Resend receiving ingress. */
export class InboundEmailRegionalBridge extends WorkerEntrypoint<Env> {
  ingestResendEmail(input: ResendRegionalEmailInput) {
    return serializeResendRegionalRpcResult(() =>
      new ResendRegionalEmailService(this.env).ingest(input));
  }
}
