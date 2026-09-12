import { WorkerEntrypoint } from 'cloudflare:workers';
import type { Env } from './env';
import { AshbyIngressSchema, AshbyIngestionResultSchema, serializeAshbyRpcResult } from './services/ashby-routing-service';
import { ConnectionService } from './services/connection-service';
import { requireWorkstreamIngress } from './services/workstream-authority';

/** Exact signed bytes reach credential and event authority only in their owning region. */
export class AshbyRegionalBridge extends WorkerEntrypoint<Env> {
  ingest(input: unknown) {
    return serializeAshbyRpcResult(async () => {
      await requireWorkstreamIngress(this.env);
      const request = AshbyIngressSchema.parse(input);
      return AshbyIngestionResultSchema.parse(await new ConnectionService(this.env).ingestAshbyWebhook(request.connectionId,
        new Uint8Array(request.rawBody), new Headers(request.signature ? { 'Ashby-Signature': request.signature } : {})));
    });
  }
}
