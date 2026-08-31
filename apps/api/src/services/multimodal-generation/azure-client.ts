import { z } from "zod";

import { MULTIMODAL_GENERATION_MODEL, type ImageGenerationSizeSchema } from "./contract";

const ImageUsageSchema = z.object({
  input_tokens: z.number().int().nonnegative(),
  input_tokens_details: z.object({
    image_tokens: z.number().int().nonnegative(),
    text_tokens: z.number().int().nonnegative(),
  }).passthrough(),
  output_tokens: z.number().int().nonnegative(),
  output_tokens_details: z.object({
    image_tokens: z.number().int().nonnegative(),
    text_tokens: z.number().int().nonnegative().optional(),
  }).passthrough().optional(),
  total_tokens: z.number().int().nonnegative(),
}).passthrough();

const ImageResponseSchema = z.object({
  data: z.array(z.object({
    b64_json: z.string().min(1),
    revised_prompt: z.string().nullish(),
  }).passthrough()).length(1),
  usage: ImageUsageSchema.optional(),
  size: z.string().optional(),
  quality: z.string().optional(),
  background: z.string().optional(),
  output_format: z.string().optional(),
}).passthrough();

const ErrorEnvelopeSchema = z.object({
  error: z.object({
    code: z.string().optional(),
    message: z.string().optional(),
  }).passthrough(),
}).passthrough();

export type ImageGenerationSize = z.infer<typeof ImageGenerationSizeSchema>;
export type AzureImageUsage = z.infer<typeof ImageUsageSchema>;

export interface AzureImageSource {
  bytes: Uint8Array;
  mimeType: string;
  fileName: string;
}

export interface AzureImageResult {
  bytes: Uint8Array;
  base64: string;
  usage?: AzureImageUsage;
  providerOperationId?: string;
  actualSize?: string;
}

export interface AzureImageClient {
  generate(input: { prompt: string; size: ImageGenerationSize; signal: AbortSignal }): Promise<AzureImageResult>;
  edit(input: {
    prompt: string;
    size: ImageGenerationSize;
    image: AzureImageSource;
    mask?: AzureImageSource;
    signal: AbortSignal;
  }): Promise<AzureImageResult>;
}

export function createAzureImageClient(input: {
  endpoint: string;
  apiKey: string;
  fetch?: typeof globalThis.fetch;
}): AzureImageClient {
  const endpoint = input.endpoint.replace(/\/+$/u, "");
  const fetcher = input.fetch ?? globalThis.fetch;
  return {
    async generate(request) {
      const response = await fetcher(`${endpoint}/openai/v1/images/generations`, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "api-key": input.apiKey,
        },
        body: JSON.stringify({
          model: MULTIMODAL_GENERATION_MODEL,
          prompt: request.prompt,
          size: request.size,
          moderation: "low",
          quality: "medium",
          background: "auto",
          n: 1,
          output_format: "png",
        }),
        signal: request.signal,
      });
      return readImageResponse(response);
    },
    async edit(request) {
      const body = new FormData();
      body.append("model", MULTIMODAL_GENERATION_MODEL);
      body.append("prompt", request.prompt);
      body.append("size", request.size);
      body.append("moderation", "low");
      body.append("quality", "medium");
      body.append("background", "auto");
      body.append("n", "1");
      body.append("output_format", "png");
      body.append("image[]", new Blob([ownedArrayBuffer(request.image.bytes)], { type: request.image.mimeType }), request.image.fileName);
      if (request.mask) {
        body.append("mask", new Blob([ownedArrayBuffer(request.mask.bytes)], { type: request.mask.mimeType }), request.mask.fileName);
      }
      const response = await fetcher(`${endpoint}/openai/v1/images/edits`, {
        method: "POST",
        headers: { accept: "application/json", "api-key": input.apiKey },
        body,
        signal: request.signal,
      });
      return readImageResponse(response);
    },
  };
}

async function readImageResponse(response: Response): Promise<AzureImageResult> {
  const providerOperationId = response.headers.get("x-request-id")?.trim() || undefined;
  if (!response.ok) {
    const body = await response.clone().json().catch(() => null);
    const parsed = ErrorEnvelopeSchema.safeParse(body);
    const providerCode = parsed.success ? parsed.data.error.code : undefined;
    const retryAfterMs = retryAfterMilliseconds(response.headers.get("retry-after"));
    if (providerCode === "moderation_blocked" || providerCode === "image_generation_user_error") {
      throw new AzureImageProviderError(
        providerCode,
        "The image request was rejected. Revise the prompt or source image and try again.",
        false,
      );
    }
    throw new AzureImageProviderError(
      "azure_image_request_failed",
      response.status === 429
        ? "Azure image generation is temporarily rate limited. Retry later."
        : "Azure image generation is temporarily unavailable. Retry later.",
      response.status === 429 || response.status >= 500,
      retryAfterMs,
    );
  }
  let parsed: z.infer<typeof ImageResponseSchema>;
  try {
    parsed = ImageResponseSchema.parse(await response.json());
  } catch (error) {
    throw new AzureImageProviderError(
      "azure_image_response_invalid",
      "Azure returned an invalid image response. Retry later.",
      true,
      undefined,
      error,
    );
  }
  const base64 = parsed.data[0]!.b64_json;
  let bytes: Uint8Array;
  try {
    bytes = decodeBase64(base64);
  } catch (error) {
    throw new AzureImageProviderError(
      "azure_image_response_invalid",
      "Azure returned image bytes that could not be decoded. Retry later.",
      true,
      undefined,
      error,
    );
  }
  return {
    bytes,
    base64,
    ...(parsed.usage ? { usage: parsed.usage } : {}),
    ...(providerOperationId ? { providerOperationId } : {}),
    ...(parsed.size ? { actualSize: parsed.size } : {}),
  };
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function ownedArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

function retryAfterMilliseconds(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(86_400_000, Math.round(seconds * 1_000));
  const date = Date.parse(value);
  if (!Number.isFinite(date)) return undefined;
  return Math.min(86_400_000, Math.max(0, date - Date.now()));
}

export class AzureImageProviderError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
    readonly retryAfterMs?: number,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "AzureImageProviderError";
  }
}
