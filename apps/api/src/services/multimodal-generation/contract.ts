import {
  AVALON_MULTIMODAL_GENERATION_PLUGIN_ID,
  type HarnessPlugin,
  type HarnessTool,
  type HarnessToolContext,
  type HarnessToolResult,
} from "@rally/agent-harness";
import type { ToolDefinition } from "@rally/contracts";
import { z } from "zod";

export const MULTIMODAL_GENERATION_MODEL = "gpt-image-2";
export const MULTIMODAL_GENERATION_PRICING_MODEL_ID = "openai/gpt-image-2";
export const MULTIMODAL_AUDIO_MODEL = "gpt-4o-mini-tts";
export const MULTIMODAL_AUDIO_PRICING_MODEL_ID = "openai/gpt-4o-mini-tts";
export const MULTIMODAL_AUDIO_DEFAULT_VOICE = "marin";
export const MULTIMODAL_GENERATION_TIMEOUT_MS = 300_000;

export const ImageGenerationSizeSchema = z.enum([
  "auto",
  "1024x1024",
  "1536x1024",
  "1024x1536",
]);

export const GenerateImageArgumentsSchema = z.strictObject({
  prompt: z.string().trim().min(1).max(32_000),
  title: z.string().trim().min(1).max(300).optional(),
  size: ImageGenerationSizeSchema.optional(),
});

export const EditImageArgumentsSchema = z.strictObject({
  resourceId: z.string().uuid(),
  prompt: z.string().trim().min(1).max(32_000),
  title: z.string().trim().min(1).max(300).optional(),
  size: ImageGenerationSizeSchema.optional(),
  maskResourceId: z.string().uuid().optional(),
});

export const AudioVoiceSchema = z.enum([
  "alloy",
  "ash",
  "ballad",
  "coral",
  "echo",
  "fable",
  "nova",
  "onyx",
  "sage",
  "shimmer",
  "verse",
  "marin",
  "cedar",
]);

export const GenerateAudioArgumentsSchema = z.strictObject({
  text: z.string().trim().min(1).max(4_096),
  voice: AudioVoiceSchema.optional(),
  instructions: z.string().trim().min(1).optional(),
  title: z.string().trim().min(1).max(300).optional(),
});

export type GenerateImageArguments = z.infer<typeof GenerateImageArgumentsSchema>;
export type EditImageArguments = z.infer<typeof EditImageArgumentsSchema>;
export type GenerateAudioArguments = z.infer<typeof GenerateAudioArgumentsSchema>;
export type AudioVoice = z.infer<typeof AudioVoiceSchema>;

export type MultimodalGenerationToolExecutors = {
  generate_image(input: GenerateImageArguments, context: HarnessToolContext): Promise<HarnessToolResult>;
  edit_image(input: EditImageArguments, context: HarnessToolContext): Promise<HarnessToolResult>;
  generate_audio(input: GenerateAudioArguments, context: HarnessToolContext): Promise<HarnessToolResult>;
};

const definitions = {
  generate_image: {
    name: "generate_image",
    description: "Generate one new PNG image from a text prompt and attach it to the current workstream as a durable resource.",
    capability: "multimodal.generate",
    mode: "write",
    idempotency: "record_before_execute",
    timeoutMs: MULTIMODAL_GENERATION_TIMEOUT_MS,
    inputSchema: z.toJSONSchema(GenerateImageArgumentsSchema) as Record<string, unknown>,
  },
  edit_image: {
    name: "edit_image",
    description: "Edit one attached image, optionally using an attached PNG mask, and publish the single resulting PNG as a new version of that same resource.",
    capability: "multimodal.edit",
    mode: "write",
    idempotency: "record_before_execute",
    timeoutMs: MULTIMODAL_GENERATION_TIMEOUT_MS,
    inputSchema: z.toJSONSchema(EditImageArgumentsSchema) as Record<string, unknown>,
  },
  generate_audio: {
    name: "generate_audio",
    description: "Turn text into one AI-generated MP3 voice recording and attach it to the current workstream as a durable audio resource.",
    capability: "multimodal.generate",
    mode: "write",
    idempotency: "record_before_execute",
    timeoutMs: MULTIMODAL_GENERATION_TIMEOUT_MS,
    inputSchema: z.toJSONSchema(GenerateAudioArgumentsSchema) as Record<string, unknown>,
  },
} as const satisfies Record<keyof MultimodalGenerationToolExecutors, ToolDefinition>;

export function createMultimodalGenerationPlugin(
  executors: MultimodalGenerationToolExecutors,
): HarnessPlugin {
  const tools = (Object.keys(definitions) as Array<keyof typeof definitions>).map((name): HarnessTool => {
    const schema = name === "generate_image"
      ? GenerateImageArgumentsSchema
      : name === "edit_image"
        ? EditImageArgumentsSchema
        : GenerateAudioArgumentsSchema;
    return {
      definition: definitions[name],
      serial: true,
      validateInput: (input) => {
        const result = schema.safeParse(input);
        return result.success ? null : result.error;
      },
      execute: async (input, context) => {
        if (name === "generate_image") {
          return executors.generate_image(GenerateImageArgumentsSchema.parse(input), context);
        }
        if (name === "edit_image") {
          return executors.edit_image(EditImageArgumentsSchema.parse(input), context);
        }
        return executors.generate_audio(GenerateAudioArgumentsSchema.parse(input), context);
      },
    };
  });
  return {
    canonicalId: AVALON_MULTIMODAL_GENERATION_PLUGIN_ID,
    modelId: "rally_multimodal_generation",
    shortWireName: "multimodal_generation",
    displayName: "Multimodal generation",
    searchAliases: ["image", "generate image", "edit image", "illustration", "picture", "visual", "audio", "speech", "voice", "text to speech"],
    description: "Generate a new image, edit an attached image, or turn text into an AI voice recording.",
    systemMessage: "Generate exactly one media resource per call. Use generate_image for a prompt-only image, edit_image when an attached image must be transformed, and generate_audio to turn text into an AI-generated voice recording. Image output is fixed to low moderation, medium quality, auto background, and PNG. Audio output is fixed to MP3 and defaults to the marin voice. Generated media is attached as a workstream resource; refer to the returned resource ID or resource URI in the final response, and clearly disclose that generated speech uses an AI voice.",
    tools,
    preload: false,
    explicit: false,
  };
}

export class MultimodalGenerationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
    options?: { cause?: unknown },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "MultimodalGenerationError";
  }
}
