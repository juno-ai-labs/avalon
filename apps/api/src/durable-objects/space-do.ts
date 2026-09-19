import { SPACE_ROLE } from "./conversation-parent-role";
import { applyRetirementGate } from "./object-retirement";
import { WORKSTREAM_RETIREMENT_POLICY, WorkstreamDO } from "./workstream-do";

import type { Env } from "../env";

/**
 * A Space: the Organization's grouping of Channels.
 *
 * It is `WorkstreamDO` and nothing else. Everything a Space does — presentation,
 * participants, resources, Sidekick recommendations, receipts, retirement,
 * lifecycle — a Channel already did, and the two differ only in the ways
 * {@link SPACE_ROLE} enumerates. This class exists because Cloudflare binds a
 * namespace to a *class name*, so a second namespace needs a second class; it
 * deliberately adds no method of its own, and a change that wants one belongs
 * in the role instead, where the base class reads it and where the difference
 * is visible beside the other seven.
 *
 * `docs/workstream-durable-object.md` owns the object hierarchy and the role.
 */
export class SpaceDO extends WorkstreamDO {
  constructor(state: DurableObjectState, env: Env) {
    super(state, env, SPACE_ROLE);
  }
}

/**
 * The same policy object `WorkstreamDO` registers, registered again for this
 * class.
 *
 * Not redundant, and not a second copy. A disposition resolves up the prototype
 * chain, so every door `SpaceDO` inherits is already classified — what this call
 * adds is the wrapping of any method `SpaceDO` comes to define *itself*. The
 * class defines none today, which is exactly the shape in which the omission
 * would be invisible: an override added later would be the one function on this
 * object with no tombstone check in front of it, and a retired Space would go on
 * serving through it.
 */
applyRetirementGate(SpaceDO, WORKSTREAM_RETIREMENT_POLICY);
