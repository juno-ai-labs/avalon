import { SPACE_ROLE } from "./conversation-parent-role";
import { applyRetirementGate, retiredObjectResponse } from "./object-retirement";
import { WorkstreamDO } from "./workstream-do";

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
 * The same policy `WorkstreamDO` declares, declared again.
 *
 * Retirement dispositions are resolved per instance from the class's own
 * prototype, so a subclass that declares nothing is a class that opted out:
 * every gated door would answer before the tombstone read and a retired Space
 * would keep serving. The gate wraps each method where it is *defined*, so
 * these wrappers are already installed by `WorkstreamDO`'s call — what this one
 * adds is the entry that says how `SpaceDO` classifies them.
 */
applyRetirementGate(SpaceDO, {
  drop: {
    canReadWorkstream: () => false,
    fetch: () => retiredObjectResponse(),
    webSocketMessage: () => Promise.resolve(),
    webSocketClose: () => Promise.resolve(),
    webSocketError: () => Promise.resolve(),
    alarm: () => Promise.resolve(),
  },
});
