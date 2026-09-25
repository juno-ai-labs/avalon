import type { Env } from "../env";
import { SPACE_ROLE } from "./conversation-parent-role";
import { WorkstreamDO } from "./workstream-do";

/**
 * A Space's legacy parent object: `WorkstreamDO` under the Space role, kept
 * deployed only so its rows can move into the Organization object that now
 * hosts every Space (`docs/hosted-conversation-parents.md`).
 *
 * A separate class only because Cloudflare binds a namespace to a class name.
 */
export class SpaceDO extends WorkstreamDO {
  constructor(state: DurableObjectState, env: Env) {
    super(state, env, SPACE_ROLE);
  }
}
