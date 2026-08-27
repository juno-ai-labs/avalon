import { z } from 'zod';

const OpenRouterEndpointsResponseSchema = z.object({
  data: z.object({
    id: z.string(),
    endpoints: z.array(z.unknown()),
  }),
});

export interface OpenRouterModelValidation {
  modelId: string;
  valid: boolean;
}

function endpointsUrl(modelId: string): string | null {
  const segments = modelId.split('/');
  if (segments.length !== 2 || segments.some((segment) => segment.length === 0)) return null;
  return `https://openrouter.ai/api/v1/models/${segments.map(encodeURIComponent).join('/')}/endpoints`;
}

/**
 * Validate exact OpenRouter ids against the provider's live endpoints API.
 * A catalog entry with no serving endpoints is not safe to save as a route.
 */
export async function validateOpenRouterModel(modelId: string): Promise<OpenRouterModelValidation> {
  const normalized = modelId.trim();
  const url = endpointsUrl(normalized);
  if (url === null) return { modelId: normalized, valid: false };

  const response = await fetch(url, { headers: { Accept: 'application/json' } });
  if (response.status === 404) return { modelId: normalized, valid: false };
  if (!response.ok) throw new Error(`OpenRouter model validation failed (${response.status})`);

  const parsed = OpenRouterEndpointsResponseSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) throw new Error('OpenRouter returned an invalid model validation response');
  return {
    modelId: normalized,
    valid: parsed.data.data.id === normalized && parsed.data.data.endpoints.length > 0,
  };
}

export async function validateOpenRouterModels(modelIds: string[]): Promise<OpenRouterModelValidation[]> {
  const uniqueModelIds = Array.from(new Set(modelIds.map((modelId) => modelId.trim())));
  return Promise.all(uniqueModelIds.map(validateOpenRouterModel));
}
