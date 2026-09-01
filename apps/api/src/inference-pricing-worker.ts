import { refreshOpenRouterPricingCache } from "./services/openrouter-pricing-cache";

interface InferencePricingWorkerEnv {
  INFERENCE_PRICING_CACHE: KVNamespace;
}

export const inferencePricingWorker = {
  async scheduled(controller: ScheduledController, env: InferencePricingWorkerEnv): Promise<void> {
    void controller;
    await refreshOpenRouterPricingCache(env);
  },
} satisfies ExportedHandler<InferencePricingWorkerEnv>;

export default inferencePricingWorker;
