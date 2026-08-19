/** Node-test stand-in for the runtime-only `cloudflare:workers` base class. */
export class DurableObject<Env = unknown> {
  protected readonly ctx: DurableObjectState;
  protected readonly env: Env;

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}
