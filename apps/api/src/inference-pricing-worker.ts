import { refreshOpenRouterPricingCache } from "./services/openrouter-pricing-cache";
import { refreshOpenRouterContextWindows } from "./services/openrouter-context-windows";

interface InferencePricingWorkerEnv {
  INFERENCE_PRICING_CACHE: KVNamespace;
}

export const inferencePricingWorker = {
  async scheduled(controller: ScheduledController, env: InferencePricingWorkerEnv): Promise<void> {
    if (controller.cron === "0 * * * *") await refreshOpenRouterPricingCache(env);
    else if (controller.cron === "0 0 * * *") await refreshOpenRouterContextWindows(env);
  },
} satisfies ExportedHandler<InferencePricingWorkerEnv>;

export default inferencePricingWorker;
