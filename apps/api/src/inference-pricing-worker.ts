import { refreshOpenRouterPricingCache } from "./services/openrouter-pricing-cache";
import { refreshOpenRouterContextWindowsIfDue } from "./services/openrouter-context-windows";

interface InferencePricingWorkerEnv {
  INFERENCE_PRICING_CACHE: KVNamespace;
}

export const inferencePricingWorker = {
  async scheduled(controller: ScheduledController, env: InferencePricingWorkerEnv): Promise<void> {
    await Promise.all([
      refreshOpenRouterPricingCache(env),
      refreshOpenRouterContextWindowsIfDue(env, { now: () => controller.scheduledTime }),
    ]);
  },
} satisfies ExportedHandler<InferencePricingWorkerEnv>;

export default inferencePricingWorker;
