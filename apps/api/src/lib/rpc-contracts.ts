import { IdSchema, RegionSchema } from "@rally/contracts";
import { z } from "zod";

import { ApiError } from "./api-error";

/**
 * Runtime contracts for the account-internal RPC surface.
 *
 * Every bridge in `apps/api/src/*-bridge.ts` is a `WorkerEntrypoint` reached
 * over a service binding rather than a URL, and each one declared its input with
 * a TypeScript interface only. Those interfaces are erased at build time, so an
 * argument arriving over the binding was whatever the caller happened to send.
 *
 * That matters most on the deployment pair. `regionalization.md` treats the
 * boundary as the line a workspace's data must not cross, and the value that
 * decides which side a record lands on — `region`, `workspaceId` — was reaching
 * the data plane unchecked. Same account is not the same thing as same
 * guarantee: a caller compiled against a stale copy of the interface, or a
 * binding wired to the wrong entrypoint, produced no error until the write.
 *
 * Schemas live together here, rather than beside each service, so the whole
 * internal surface can be read in one place.
 */

/** A provider's own identifier for a tenant — opaque to Avalon, so bounded rather than shaped. */
const providerId = z.string().min(1).max(200);
const statusFlag = z.enum(["active", "disabled"]);

const headerBag = z.record(z.string().min(1).max(200), z.string().max(8_192));
const rawBody = z.custom<ArrayBuffer>(
  (value) => value instanceof ArrayBuffer,
  { message: "must be an ArrayBuffer" },
);

/** Exact-byte webhook hand-off from a shared Global ingress to a regional data plane. */
export const RegionalWebhookInputSchema = z.object({ rawBody, headers: headerBag });

/**
 * What names a GitHub delivery apart from its bytes: the two headers the parser
 * reads and when the Global receiver took it. The Queue message
 * (`GitHubDeliveryQueueMessageSchema`) and the bridge input below both spread
 * it, so the two hand-offs cannot drift apart.
 */
export const GitHubDeliveryIdentitySchema = z.object({
  deliveryId: z.string().min(1).max(200),
  event: z.string().min(1).max(100),
  receivedAt: z.string().datetime({ offset: true }),
});

/**
 * A GitHub delivery the Global receiver has already verified, on its way from
 * the Global Queue consumer to a regional data plane. It carries no signature:
 * the edge checked it once, and the region parses the same bytes without
 * checking it again.
 */
export const GitHubVerifiedDeliveryInputSchema = GitHubDeliveryIdentitySchema.extend({ rawBody });

export type GitHubVerifiedDeliveryInput = z.infer<typeof GitHubVerifiedDeliveryInputSchema>;

export const GitHubRegionalSetupInputSchema = z.object({
  installationId: providerId,
  state: z.string().min(1).max(4_096),
});

export const GitHubRegionalSetupFailureInputSchema = z.object({
  state: z.string().min(1).max(4_096),
  errorCode: z.string().min(1).max(200),
});

export const GitHubRouteStatusInputSchema = z.object({
  installationId: providerId,
  region: RegionSchema,
  workspaceId: IdSchema,
  status: statusFlag,
});

export const LinearRouteInputSchema = z.object({
  organizationId: providerId,
  region: RegionSchema,
  workspaceId: IdSchema,
  connectionId: IdSchema,
});
export const LinearRouteStatusInputSchema = LinearRouteInputSchema.extend({ status: statusFlag });

export const NotionRouteInputSchema = z.object({
  notionWorkspaceId: providerId,
  region: RegionSchema,
  workspaceId: IdSchema,
  connectionId: IdSchema,
});
export const NotionRouteStatusInputSchema = NotionRouteInputSchema.extend({ status: statusFlag });

/**
 * Notion's single redirect URI puts an authorization code on this hop. The code
 * is short-lived, single-use, and useless without the connection's client
 * secret, but it is still the one credential that crosses the boundary here, so
 * it is bounded and shaped like everything else rather than passed through raw.
 */
export const NotionCallbackInputSchema = z.object({
  code: z.string().min(1).max(4_096),
  state: z.string().min(1).max(4_096),
});
export const NotionCallbackStateInputSchema = z.object({
  state: z.string().min(1).max(4_096),
});
export const NotionCallbackFailureInputSchema = z.object({
  state: z.string().min(1).max(4_096),
  errorCode: z.string().min(1).max(200),
});
export const NotionChallengeInputSchema = z.object({
  verificationToken: z.string().min(1).max(1_000),
  setupGeneration: z.number().int().positive().safe(),
});

export const SlackRouteInputSchema = z.object({
  teamId: providerId,
  region: RegionSchema,
  workspaceId: IdSchema,
  connectionId: IdSchema,
});
export const SlackRouteStatusInputSchema = SlackRouteInputSchema.extend({ status: statusFlag });

/**
 * Slack payloads stay `unknown`/`Record` here on purpose: the shared ingress has
 * already verified the signature over the exact bytes, and the regional service
 * parses the envelope itself with `SlackIngressEnvelopeSchema`. What this adds
 * is the hand-off's own shape — that a payload and its body hash both arrived.
 */
export const SlackEventRpcInputSchema = z.object({
  payload: z.unknown(),
  bodyHash: z.string().min(1).max(200),
});
export const SlackInteractionRpcInputSchema = z.object({
  payload: z.record(z.string(), z.unknown()),
  bodyHash: z.string().min(1).max(200),
});
export const SlackCommandRpcInputSchema = z.object({
  form: z.record(z.string(), z.string()),
  bodyHash: z.string().min(1).max(200),
});

export const ResendRegionalEmailInputSchema = z.object({
  resendEmailId: z.string().min(1).max(200),
  svixId: z.string().min(1).max(200),
  receivedAt: z.string().datetime({ offset: true }),
  region: RegionSchema,
  workspaceId: IdSchema,
  targetType: z.enum(["workstream", "automation"]).optional(),
  workstreamId: IdSchema.optional(),
  automationSubscriptionId: IdSchema.optional(),
  localPart: z.string().min(1).max(200),
  emailAddress: z.string().email().max(254),
});

export const AutomationEmailRouteInputSchema = z.object({
  region: RegionSchema,
  workspaceId: IdSchema,
  automationSubscriptionId: IdSchema,
});
export const AutomationEmailAddressClaimSchema = AutomationEmailRouteInputSchema.extend({
  emailAddress: z.string().email().max(254),
});
/**
 * The registry's batch methods take arrays. Bounding them is part of the
 * contract: an unbounded batch is a way to hold one Global invocation open on
 * behalf of a regional caller.
 *
 * This is the bound `WorkstreamEmailRoutingService.assertBulkSize` already
 * enforces, and it is defined here so there is one number rather than two. A
 * second, tighter bound on the same path would mean a batch that succeeds on
 * Global comes back from a regional caller as a 400 — a deployment behavioural
 * divergence introduced by the guard meant to prevent one.
 */
export const RPC_BATCH_LIMIT = 512;
export function rpcBatch<T extends z.ZodTypeAny>(schema: T) {
  return z.array(schema).max(RPC_BATCH_LIMIT);
}

/**
 * Parse an RPC argument, or fail as a business error the caller already knows
 * how to read.
 *
 * Every bridge wraps its work in a `serialize*RpcResult` helper that turns an
 * `ApiError` into the `{ ok: false, error }` envelope on the wire. Throwing one
 * here means a malformed argument comes back as a typed 400 the caller can
 * surface, rather than an opaque RPC exception with no code on it. Only the
 * offending field paths travel — never the values, which on this surface
 * include OAuth state and provider identifiers.
 */
export function parseRpcInput<T extends z.ZodTypeAny>(
  schema: T,
  input: unknown,
  method: string,
): z.infer<T> {
  const parsed = schema.safeParse(input);
  if (parsed.success) return parsed.data;
  throw new ApiError(400, "invalid_rpc_input", `Invalid ${method} input`, {
    method,
    issues: parsed.error.issues.slice(0, 25).map((issue) => ({
      path: issue.path.map(String).join(".") || "(root)",
      code: issue.code,
    })),
  });
}
