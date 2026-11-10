import type { AgentModelRole, ClientFeatureFlags } from "./index";

/** Deployment-wide defaults. Environment overrides are optional. */
export const FEATURE_FLAGS = {
  developerSettings: false,
  multipleWorkspacesEnabled: false,
  pushNotificationsEnabled: true,
} as const satisfies ClientFeatureFlags;

export const FEATURE_FLAG_ENV_KEYS = {
  developerSettings: "FEATURE_FLAG_DEVELOPER_SETTINGS",
  multipleWorkspacesEnabled: "FEATURE_FLAG_MULTIPLE_WORKSPACES_ENABLED",
  pushNotificationsEnabled: "FEATURE_FLAG_PUSH_NOTIFICATIONS_ENABLED",
} as const satisfies Record<keyof ClientFeatureFlags, string>;

export type FeatureFlagEnvironment = Partial<Record<
  (typeof FEATURE_FLAG_ENV_KEYS)[keyof ClientFeatureFlags], string
>>;

/** Canonical model identities shared by runtime selection, routing and presentation. */
export const MODEL_IDS = {
  GPT_6_1_SOL: "openai/gpt-6.1-sol",
  GPT_5_6_SOL: "openai/gpt-5.6-sol",
  GPT_5_6_TERRA: "openai/gpt-5.6-terra",
  GPT_5_6_LUNA: "openai/gpt-5.6-luna",
  GROK_4_6: "x-ai/grok-4.6",
  GROK_4_5: "x-ai/grok-4.5",
  GROK_4_3: "x-ai/grok-4.3",
  GEMINI_3_8_FLASH: "google/gemini-3.8-flash",
  GEMINI_3_7_FLASH: "google/gemini-3.7-flash",
  GEMINI_3_6_FLASH: "google/gemini-3.6-flash",
  GEMINI_3_5_FLASH: "google/gemini-3.5-flash",
  GEMINI_3_FLASH_PREVIEW: "google/gemini-3-flash-preview",
  GEMINI_2_5_FLASH_LITE: "google/gemini-2.5-flash-lite",
  DEEPSEEK_V4_PRO: "deepseek/deepseek-v4-pro",
  DEEPSEEK_V4_FLASH: "deepseek/deepseek-v4-flash-0731",
  DEEPSEEK_V4_1_FLASH: "deepseek/deepseek-v4.1-flash",
  QWEN3_EMBEDDING_8B: "qwen/qwen3-embedding-8b",
  TEXT_EMBEDDING_3_LARGE: "openai/text-embedding-3-large",
  GPT_IMAGE_2: "openai/gpt-image-2",
  GPT_4O_MINI_TTS: "openai/gpt-4o-mini-tts",
  FLUX_2_FLEX: "black-forest-labs/flux.2-flex",
  JEV_LATEST: "jev-latest",
  JEV_1_14_0: "jev-1.14.0",
} as const;

/** Reviewed model pins, ordered newest first within each provider. */
export const AGENT_MODEL_OVERRIDES = [
  MODEL_IDS.GROK_4_6,
  MODEL_IDS.GROK_4_5,
  MODEL_IDS.GROK_4_3,
  MODEL_IDS.GEMINI_3_8_FLASH,
  MODEL_IDS.GEMINI_3_7_FLASH,
  MODEL_IDS.GEMINI_3_6_FLASH,
  MODEL_IDS.GEMINI_3_5_FLASH,
  MODEL_IDS.GEMINI_3_FLASH_PREVIEW,
  MODEL_IDS.GPT_5_6_SOL,
  MODEL_IDS.GPT_5_6_TERRA,
  MODEL_IDS.GPT_5_6_LUNA,
  MODEL_IDS.DEEPSEEK_V4_PRO,
  MODEL_IDS.DEEPSEEK_V4_FLASH,
] as const;

export const AGENT_MODEL_DEFAULTS = {
  OPENROUTER_PRIMARY_MODEL: MODEL_IDS.GPT_5_6_TERRA,
  OPENROUTER_SMARTER_MODEL: MODEL_IDS.GPT_6_1_SOL,
  OPENROUTER_FALLBACK_MODEL: MODEL_IDS.GEMINI_3_8_FLASH,
  OPENROUTER_FASTER_MODEL: MODEL_IDS.GPT_5_6_TERRA,
} as const;

export const AGENT_MODEL_ENV_KEYS = {
  canvas: "OPENROUTER_PRIMARY_MODEL",
  memory_sweep: "OPENROUTER_SMARTER_MODEL",
  sidekick_wizard: "OPENROUTER_SMARTER_MODEL",
  sidekick_run: "OPENROUTER_PRIMARY_MODEL",
  canvas_naming: "OPENROUTER_FASTER_MODEL",
} as const satisfies Record<AgentModelRole, keyof typeof AGENT_MODEL_DEFAULTS>;

/** Model choices for inference paths with their own persistence or provider contracts. */
// The model participates in the search namespace identity; changing it requires reindexing.
export const MEMORY_EMBEDDING_MODEL = MODEL_IDS.QWEN3_EMBEDDING_8B;
export const JEV_LATEST_MODEL = MODEL_IDS.JEV_LATEST;
export const TYPESAFE_ADDRESSING_MODEL = JEV_LATEST_MODEL;
export const COMPLETION_VERIFICATION_MODEL = MODEL_IDS.JEV_1_14_0;
export const ADDRESSING_FALLBACK_MODEL = MODEL_IDS.DEEPSEEK_V4_FLASH;
export const MESSAGE_CONTINUATION_FALLBACK_MODEL = MODEL_IDS.GPT_6_1_SOL;

/** Azure model/deployment names differ from their canonical pricing identities. */
export const MULTIMODAL_GENERATION_MODEL = "gpt-image-2";
export const MULTIMODAL_GENERATION_PRICING_MODEL_ID = MODEL_IDS.GPT_IMAGE_2;
export const MULTIMODAL_AUDIO_MODEL = "gpt-4o-mini-tts";
export const MULTIMODAL_AUDIO_PRICING_MODEL_ID = MODEL_IDS.GPT_4O_MINI_TTS;
export const REALTIME_TRANSCRIPTION_MODEL_ENV_KEY = "AZURE_OPENAI_REALTIME_DEPLOYMENT";

export const AZURE_MODEL_DEPLOYMENTS = {
  [MODEL_IDS.GPT_5_6_SOL]: "gpt-5.6-sol",
  [MODEL_IDS.GROK_4_3]: "grok-4.3",
  [MODEL_IDS.GROK_4_6]: "grok-4.6",
} as const;

/** Azure deployments whose prices are available under canonical OpenRouter identities. */
export const AZURE_DEPLOYED_OPENROUTER_MODEL_IDS = [
  MODEL_IDS.GROK_4_3,
  MODEL_IDS.GROK_4_6,
  MODEL_IDS.GPT_5_6_SOL,
  MODEL_IDS.GPT_5_6_TERRA,
  MODEL_IDS.DEEPSEEK_V4_PRO,
  MODEL_IDS.DEEPSEEK_V4_FLASH,
  MODEL_IDS.TEXT_EMBEDDING_3_LARGE,
  MODEL_IDS.GPT_IMAGE_2,
  MODEL_IDS.FLUX_2_FLEX,
] as const;
export const OPENROUTER_IMAGE_MODEL_IDS = [MODEL_IDS.GPT_IMAGE_2, MODEL_IDS.FLUX_2_FLEX] as const;
export const OPENROUTER_PRICING_MODEL_IDS = Array.from(new Set([
  ...AGENT_MODEL_OVERRIDES,
  ...AZURE_DEPLOYED_OPENROUTER_MODEL_IDS,
]));

export type ModelReasoningEffort = "low" | "medium" | "high";
export interface ModelInferenceDefaults {
  readonly reasoningEffort?: ModelReasoningEffort;
  /** Caller-requested `none` uses the default when the provider requires reasoning. */
  readonly reasoningRequired?: true;
}

/** Unlisted models keep their provider-defined reasoning defaults. */
export const MODEL_INFERENCE_DEFAULTS: Readonly<Record<string, ModelInferenceDefaults>> = {
  [MODEL_IDS.GROK_4_6]: { reasoningEffort: "low", reasoningRequired: true },
  [MODEL_IDS.GEMINI_3_7_FLASH]: { reasoningEffort: "low", reasoningRequired: true },
  [MODEL_IDS.GEMINI_3_8_FLASH]: { reasoningEffort: "low", reasoningRequired: true },
};
