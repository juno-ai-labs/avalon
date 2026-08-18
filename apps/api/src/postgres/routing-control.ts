import type { JsonValue, RegionalGlobalCommand } from "@avalon/postgres";
import { z } from "zod";

import type { Env } from "../env";
import { createPostgresClient } from "./runtime";

const bytes = z.instanceof(Uint8Array).refine((value) => value.byteLength === 32);
export const RegionalRoutingCommandSchema = z.object({
  commandId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  routeEpoch: z.number().int().positive(),
  localShardId: z.string().min(1).max(64),
  regionKey: z.enum(["global", "eu"]),
  operationKind: z.enum([
    "create_workspace", "suspend_workspace", "delete_workspace",
    "prepare_move", "activate_move", "apply_invitation", "apply_entitlement",
  ]),
  payload: z.unknown(),
  payloadHash: bytes,
  sourceClosureCursor: z.string().max(1024).optional(),
  sourceClosureHash: bytes.optional(),
}).strict();

export type RegionalRoutingCommandInput = z.infer<typeof RegionalRoutingCommandSchema>;
export type RegionalRoutingResult = {
  receiptId: string;
  resultState: string;
  resultHash: Uint8Array;
};

export interface PostgresRegionalRoutingBridgeBinding {
  applyRoutingCommand(input: RegionalRoutingCommandInput): Promise<RegionalRoutingResult>;
}

function isJsonObject(value: JsonValue): value is { readonly [key: string]: JsonValue | undefined } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeSha256Hex(value: JsonValue | undefined): Uint8Array | undefined {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) return undefined;
  return Uint8Array.from(value.match(/.{2}/gu)!.map((pair: string) => Number.parseInt(pair, 16)));
}

export async function applyRegionalRoutingCommand(
  env: Env,
  rawInput: unknown,
): Promise<RegionalRoutingResult> {
  const input = RegionalRoutingCommandSchema.parse(rawInput);
  if (input.regionKey !== env.AVALON_REGION) throw new Error("routing_command_region_mismatch");
  const client = createPostgresClient(env, "regional_router");
  try {
    const command: RegionalGlobalCommand = {
      commandId: input.commandId,
      workspaceId: input.workspaceId,
      routeEpoch: input.routeEpoch,
      localShardId: input.localShardId,
      regionKey: input.regionKey,
      operationKind: input.operationKind,
      payload: input.payload as JsonValue,
      payloadHash: input.payloadHash,
      ...(input.sourceClosureCursor === undefined
        ? {} : { sourceClosureCursor: input.sourceClosureCursor }),
      ...(input.sourceClosureHash === undefined
        ? {} : { sourceClosureHash: input.sourceClosureHash }),
    };
    return await client.applyGlobalCommand(command);
  } finally {
    await client.close();
  }
}

function safeErrorClass(error: unknown): string {
  if (error instanceof z.ZodError) return "routing_contract_invalid";
  if (error instanceof Error && /^[a-z0-9_]{1,128}$/u.test(error.message)) return error.message;
  return "routing_delivery_failed";
}

/**
 * The Global scheduled Worker drains the durable Postgres outbox. Regional
 * application and Global acknowledgement are independently idempotent, so a
 * crash between them safely replays the exact payload and regional receipt.
 */
export async function drainPostgresRoutingCommands(env: Env): Promise<number> {
  if (env.AVALON_REGION !== "global" || !env.SUPABASE_GLOBAL_ROUTER_DATABASE_URL) return 0;
  const globalClient = createPostgresClient(env, "global_router");
  let delivered = 0;
  try {
    const workflowId = `scheduled/${crypto.randomUUID()}`;
    const commands = await globalClient.claimRoutingCommands(workflowId, 32);
    for (const command of commands) {
      try {
        const payload = isJsonObject(command.payload) ? command.payload : undefined;
        const sourceClosureHash = decodeSha256Hex(payload?.source_closure_hash);
        const input: RegionalRoutingCommandInput = RegionalRoutingCommandSchema.parse({
          commandId: command.commandId,
          workspaceId: command.workspaceId,
          routeEpoch: command.routeEpoch,
          localShardId: command.targetShardId,
          regionKey: command.regionKey,
          operationKind: command.operationKind,
          payload: command.payload,
          payloadHash: command.payloadHash,
          ...(typeof payload?.source_closure_cursor === "string"
            ? { sourceClosureCursor: payload.source_closure_cursor }
            : {}),
          ...(sourceClosureHash === undefined
            ? {}
            : { sourceClosureHash }),
        });
        const result = command.regionKey === "global"
          ? await applyRegionalRoutingCommand(env, input)
          : await env.EU_POSTGRES_ROUTING_BRIDGE?.applyRoutingCommand(input);
        if (!result) throw new Error("eu_postgres_routing_bridge_unavailable");
        await globalClient.acknowledgeRoutingCommand({
          commandId: command.commandId,
          attemptNo: command.attemptNo,
          workspaceId: command.workspaceId,
          routeEpoch: command.routeEpoch,
          targetShardId: command.targetShardId,
          payloadHash: command.payloadHash,
          regionalReceiptId: result.receiptId,
          regionalState: result.resultState,
          responseHash: result.resultHash,
        });
        delivered += 1;
      } catch (error) {
        await globalClient.failRoutingCommandAttempt({
          commandId: command.commandId,
          attemptNo: command.attemptNo,
          errorClass: safeErrorClass(error),
        });
      }
    }
  } finally {
    await globalClient.close();
  }
  return delivered;
}
