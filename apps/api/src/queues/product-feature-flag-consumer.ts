import { configuredRegions } from "@rally/contracts/regions";
import {
  asWorkspaceId,
  ProductFeatureFlagFanoutMessageSchema,
  type ProductFeatureFlagFanoutMessage,
} from "@rally/contracts";

import { workspaceDOName } from "../durable-objects/names";
import type { Env } from "../env";
import {
  durableObjectStubForWorkspace,
  workspacePlacementAffinity,
} from "../lib/durable-object-namespace";
import { isRetirementRefusal } from "../durable-objects/object-retirement";
import { logInfo, logWarn } from "../observability/logger";

const QUEUES = new Set(configuredRegions.map((region) => `avalon-${region}-product-feature-flags`));

export function isProductFeatureFlagQueue(queue: string): boolean {
  return QUEUES.has(queue);
}

export async function applyProductFeatureFlagChange(
  env: Env,
  message: ProductFeatureFlagFanoutMessage,
): Promise<void> {
  const workspaceId = asWorkspaceId(message.workspaceId);
  const placementAffinity = await workspacePlacementAffinity(env, workspaceId);
  const workspace = await durableObjectStubForWorkspace(
    env,
    env.WORKSPACE_DOS,
    workspaceId,
    workspaceDOName(env.AVALON_REGION, workspaceId),
    placementAffinity,
  );
  await workspace.notifyProductFeatureFlagChanged(
    message.flagKey,
    workspaceId,
    placementAffinity,
  );
}

export async function consumeProductFeatureFlagQueue(
  batch: MessageBatch<unknown>,
  env: Env,
): Promise<void> {
  await Promise.all(batch.messages.map(async (message) => {
    const parsed = ProductFeatureFlagFanoutMessageSchema.safeParse(message.body);
    if (!parsed.success) {
      logWarn(env, "product_feature_flag_message_invalid", {
        errors: parsed.error.issues.slice(0, 4).map((issue) =>
          `${issue.path.join(".") || "(root)"}: ${issue.code}`),
      });
      message.ack();
      return;
    }
    try {
      await applyProductFeatureFlagChange(env, parsed.data);
      message.ack();
    } catch (error) {
      // Ace's fan-out skips a closed workspace, but a message already in the
      // queue when the tombstone landed still arrives, and the object refuses
      // it the same way on every redelivery. Nobody is connected to a retired
      // workspace to receive the flag, so the message is done.
      if (isRetirementRefusal(error)) {
        logInfo(env, "product_feature_flag_fanout_terminal", {
          workspace_id: parsed.data.workspaceId,
          flag_key: parsed.data.flagKey,
          outcome: "workspace_retired",
        });
        message.ack();
        return;
      }
      logWarn(env, "product_feature_flag_fanout_failed", {
        workspace_id: parsed.data.workspaceId,
        flag_key: parsed.data.flagKey,
        error: error instanceof Error ? error.message : "unknown",
      });
      message.retry();
    }
  }));
}
