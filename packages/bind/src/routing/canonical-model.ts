import { z } from "zod";

/**
 * Canonical model identity is the OpenRouter-style `vendor/model-slug` id
 * (LLM Provider Routing PRD §4.1). Provider invocation ids (e.g. an Azure
 * deployment name) are a separate concept and must never be parsed with this
 * schema — the regex rejects them because they carry no `/` segment.
 */
export const canonicalModelIdSchema = z
  .string()
  .trim()
  .regex(/^[^/\s]+\/[^/\s]+$/, "expected an OpenRouter-style vendor/model id")
  .brand("CanonicalModelId");

export type CanonicalModelId = z.infer<typeof canonicalModelIdSchema>;

/**
 * Provider ids are lower-case slugs (`openrouter`, `azure`, …). The harness
 * is generic over the set of providers; the host narrows it by which
 * transports it registers. Policy validation rejects ids that name no
 * registered transport at plan time, not here.
 */
export const providerIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_-]*$/, "provider ids are lower-case slugs")
  .brand("ProviderId");

export type ProviderId = z.infer<typeof providerIdSchema>;
