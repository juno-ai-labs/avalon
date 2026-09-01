import { z } from "zod/v3";

import {
  MULTIMODAL_AUDIO_MODEL,
  type AudioVoice,
} from "./contract";

const ErrorEnvelopeSchema = z.object({
  error: z.object({
    code: z.string().optional(),
    message: z.string().optional(),
  }).passthrough(),
}).passthrough();

export interface AzureAudioResult {
  bytes: Uint8Array;
  providerOperationId?: string;
}

export interface AzureAudioStreamResult {
  body: ReadableStream<Uint8Array>;
  providerOperationId?: string;
}

export interface AzureAudioClient {
  generate(input: {
    text: string;
    voice: AudioVoice;
    instructions?: string;
    signal: AbortSignal;
  }): Promise<AzureAudioResult>;
  streamPcm(input: {
    text: string;
    voice: AudioVoice;
    instructions?: string;
    signal: AbortSignal;
  }): Promise<AzureAudioStreamResult>;
}

export function createAzureAudioClient(input: {
  endpoint: string;
  apiKey: string;
  maximumBytes: number;
  fetch?: typeof globalThis.fetch;
}): AzureAudioClient {
  const endpoint = input.endpoint.replace(/\/+$/u, "");
  const fetcher = input.fetch ?? globalThis.fetch;
  const requestAudio = async (
    request: {
      text: string;
      voice: AudioVoice;
      instructions?: string;
      signal: AbortSignal;
    },
    responseFormat: "mp3" | "pcm",
  ): Promise<Response> => {
    const response = await fetcher(`${endpoint}/openai/v1/audio/speech`, {
      method: "POST",
      headers: {
        accept: responseFormat === "pcm" ? "application/octet-stream" : "audio/mpeg",
        "content-type": "application/json",
        "api-key": input.apiKey,
      },
      body: JSON.stringify({
        model: MULTIMODAL_AUDIO_MODEL,
        input: request.text,
        voice: request.voice,
        ...(request.instructions ? { instructions: request.instructions } : {}),
        response_format: responseFormat,
        ...(responseFormat === "pcm" ? { stream_format: "audio" } : {}),
      }),
      signal: request.signal,
    });
    await assertAudioResponse(response);
    return response;
  };
  return {
    async generate(request): Promise<AzureAudioResult> {
      const response = await requestAudio(request, "mp3");
      return readAudioResponse(response, input.maximumBytes);
    },
    async streamPcm(request): Promise<AzureAudioStreamResult> {
      const response = await requestAudio(request, "pcm");
      if (!response.body) {
        throw new AzureAudioProviderError(
          "azure_audio_response_invalid",
          "Azure returned no audio stream. Retry later.",
          true,
        );
      }
      const providerOperationId = response.headers.get("x-request-id")?.trim() || undefined;
      return {
        body: response.body,
        ...(providerOperationId ? { providerOperationId } : {}),
      };
    },
  };
}

async function readAudioResponse(
  response: Response,
  maximumBytes: number,
): Promise<AzureAudioResult> {
  const providerOperationId = response.headers.get("x-request-id")?.trim() || undefined;
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw audioTooLarge(declaredLength, maximumBytes);
  }
  const bytes = await readBoundedBody(response, maximumBytes);
  if (bytes.byteLength === 0) {
    throw new AzureAudioProviderError(
      "azure_audio_response_invalid",
      "Azure returned an empty audio response. Retry later.",
      true,
    );
  }
  return {
    bytes,
    ...(providerOperationId ? { providerOperationId } : {}),
  };
}

async function assertAudioResponse(response: Response): Promise<void> {
  if (!response.ok) {
    const body = await response.clone().json().catch(() => null);
    const parsed = ErrorEnvelopeSchema.safeParse(body);
    const providerCode = parsed.success ? parsed.data.error.code : undefined;
    const retryAfterMs = retryAfterMilliseconds(response.headers.get("retry-after"));
    if (response.status === 400 || response.status === 422) {
      throw new AzureAudioProviderError(
        providerCode ?? "azure_audio_request_rejected",
        "The speech request was rejected. Revise the text, voice, or instructions and try again.",
        false,
      );
    }
    throw new AzureAudioProviderError(
      "azure_audio_request_failed",
      response.status === 429
        ? "Azure speech generation is temporarily rate limited. Retry later."
        : "Azure speech generation is temporarily unavailable. Retry later.",
      response.status === 429 || response.status >= 500,
      retryAfterMs,
    );
  }
}

async function readBoundedBody(response: Response, maximumBytes: number): Promise<Uint8Array> {
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maximumBytes) throw audioTooLarge(bytes.byteLength, maximumBytes);
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel("generated audio exceeds Rally attachment limit");
        throw audioTooLarge(total, maximumBytes);
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function audioTooLarge(actual: number, maximum: number): AzureAudioProviderError {
  return new AzureAudioProviderError(
    "resource_limit_exceeded",
    `The generated audio is ${actual} bytes; Rally accepts at most ${maximum} bytes. Shorten the text and try again.`,
    false,
  );
}

function retryAfterMilliseconds(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(86_400_000, Math.round(seconds * 1_000));
  const date = Date.parse(value);
  if (!Number.isFinite(date)) return undefined;
  return Math.min(86_400_000, Math.max(0, date - Date.now()));
}

export class AzureAudioProviderError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
    readonly retryAfterMs?: number,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "AzureAudioProviderError";
  }
}
