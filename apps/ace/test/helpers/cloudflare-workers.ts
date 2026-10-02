/** Node-test stand-in for the runtime-only `cloudflare:workers` module. */
export class WorkerEntrypoint<Env = unknown> {
  constructor(protected ctx: ExecutionContext, protected env: Env) {}
}
