import { z } from "zod";
import type { HarnessTool } from "@rally/agent-harness";
import {
  IdSchema, SIDEKICK_DELEGATION_ERRORS,
  SidekickMyDelegationsInputSchema, SidekickDelegatesInputSchema, SidekickSetDelegationInputSchema,
  type UserId, type WorkstreamWorkflowInput,
} from "@rally/contracts";
import type { Env } from "../env";
import { ApiError } from "../lib/api-error";
import { SidekickDelegationService } from "./sidekick-delegation-service";

export function sidekickDelegationGuidance(): string {
  const name = (local: string) => `sidekick_${local}`;
  return `Use ${name("delegates_list")} to inspect a Sidekick's allowed users. Use ${name("set_delegation")} with a Sidekick ID and an Organization userId to add or withdraw that user's delegation. This is available during autonomous work too. For your own withdrawal after access loss, use ${name("my_delegations_list")} or a known Sidekick ID. Changing delegation starts no run. The harness handles eligible-account fallback after definite access refusals.`;
}

/** The execution user supplies authority; the tool selects an Organization user. */
export function sidekickDelegationTools(env: Env, input: WorkstreamWorkflowInput, userId: UserId, room: boolean): HarnessTool[] {
  const service = new SidekickDelegationService(env, input.workspaceId, userId);
  const name = (local: string) => room ? `sidekick_${local}` : local;
  const definitions = [
    {
      name: name("my_delegations_list"),
      description: "List your own Sidekick delegations, in this Organization, including unavailable Sidekicks. Use their sidekickId to inspect or withdraw your own grant.",
      capability: "rally.sidekick.delegation.own_list", mode: "read" as const, idempotency: "safe" as const,
      inputSchema: z.toJSONSchema(SidekickMyDelegationsInputSchema),
    },
    {
      name: name("delegates_list"),
      description: "Find a Sidekick you can view and list its allowed users. Supply its UUID, Rally URL or exact visible name. Returns its sidekickId for delegation changes; does not require definition-edit permission.",
      capability: "rally.sidekick.delegation.list", mode: "read" as const, idempotency: "safe" as const,
      inputSchema: z.toJSONSchema(SidekickDelegatesInputSchema),
    },
    {
      name: name("set_delegation"),
      description: "Add or withdraw delegation for an Organization user. Supply their userId and the Sidekick ID. Available in direct conversations and autonomous runs; starts no run. Use sidekick_my_delegations_list to find your own grants after losing Sidekick access.",
      capability: "rally.sidekick.delegation.set", mode: "write" as const, idempotency: "record_before_execute" as const,
      inputSchema: z.toJSONSchema(SidekickSetDelegationInputSchema),
    },
  ];
  return [{
    definition: definitions[0]!,
    validateInput: (raw) => SidekickMyDelegationsInputSchema.safeParse(raw).error ?? null,
    execute: async (raw) => {
      SidekickMyDelegationsInputSchema.parse(raw);
      return { output: await service.listOwn(), summary: "Listed your Sidekick delegations in this Organization" };
    },
  }, {
    definition: definitions[1]!,
    validateInput: (raw) => SidekickDelegatesInputSchema.safeParse(raw).error ?? null,
    execute: async (raw) => ({ output: await service.listDelegates(SidekickDelegatesInputSchema.parse(raw).sidekick), summary: "Listed Sidekick delegates" }),
  }, {
    definition: definitions[2]!, serial: true, reenterable: true,
    validateInput: (raw) => SidekickSetDelegationInputSchema.safeParse(raw).error ?? null,
    reconcileEffect: async (raw, context) => {
      const args = SidekickSetDelegationInputSchema.parse(raw);
      const receipt = await service.readReceipt(args.sidekickId, args.userId, args.allowed, IdSchema.parse(context.effectIntentId), "agent_request");
      if (receipt.outcome === "accepted") return { outcome: "landed", result: { output: receipt.result,
        summary: args.allowed ? "Allowed this Sidekick to act as the selected user" : "Withdrew delegation for the selected user" } };
      // Missing acceptance proves no consent to recover, not permission to
      // prepare this old intent again at a newer generation.
      const code = receipt.outcome === "unavailable" ? "sidekick_delegation_unavailable" : "sidekick_delegation_stale_action";
      throw new ApiError(409, code, SIDEKICK_DELEGATION_ERRORS[code]);
    },
    validateCompletedReplay: async (raw, context) => {
      const args = SidekickSetDelegationInputSchema.parse(raw);
      const receipt = await service.readReceipt(args.sidekickId, args.userId, args.allowed, IdSchema.parse(context.effectIntentId), "agent_request");
      if (receipt.outcome === "accepted") return { allowed: true };
      const code = receipt.outcome === "unavailable" ? "sidekick_delegation_unavailable" : "sidekick_delegation_stale_action";
      return { allowed: false, code, message: SIDEKICK_DELEGATION_ERRORS[code] };
    },
    execute: async (raw, context) => {
      const args = SidekickSetDelegationInputSchema.parse(raw);
      // Every retry uses the durable effect receipt's identity; never mint a new intent here.
      const operationId = IdSchema.parse(context.effectIntentId);
      return { output: await service.setFor(args.sidekickId, args.userId, args.allowed, operationId, "agent_request"),
        summary: args.allowed ? "Allowed this Sidekick to act as the selected user" : "Withdrew delegation for the selected user" };
    },
  }];
}
