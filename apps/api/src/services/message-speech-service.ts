import type { Env } from "../env";
import { ApiError } from "../lib/api-error";
import {
  createAzureAudioClient,
  type AzureAudioClient,
} from "./multimodal-generation/azure-audio-client";
import {
  MULTIMODAL_AUDIO_DEFAULT_VOICE,
  MULTIMODAL_AUDIO_MODEL,
} from "./multimodal-generation/contract";
import { markdownToEmailText } from "./email-markdown";
import { splitSpeechText } from "./multimodal-generation/speech-pieces";

export { AZURE_SPEECH_INPUT_CHARACTERS, splitSpeechText } from "./multimodal-generation/speech-pieces";

export interface MessageSpeechStream {
  body: ReadableStream<Uint8Array>;
  chunkCount: number;
  model: typeof MULTIMODAL_AUDIO_MODEL;
}

export async function streamMessageSpeech(input: {
  env: Pick<Env, "AZURE_INFERENCE_ENDPOINT" | "AZURE_INFERENCE_API_KEY">;
  markdown: string;
  signal: AbortSignal;
  client?: AzureAudioClient;
}): Promise<MessageSpeechStream> {
  // Spoken, not read: a link is its name and a bare address its domain (docs/message-speech.md).
  const speech = markdownToEmailText(input.markdown, { linkTargets: "spoken" });
  if (!speech) throw new ApiError(422, "speech_text_required", "This message has no text to speak.");

  const endpoint = input.env.AZURE_INFERENCE_ENDPOINT?.trim();
  const apiKey = input.env.AZURE_INFERENCE_API_KEY?.trim();
  if (!endpoint || !apiKey) {
    throw new ApiError(503, "speech_unavailable", "Speaking is temporarily unavailable.");
  }
  const client = input.client ?? createAzureAudioClient({
    endpoint,
    apiKey,
    // Streaming never collects a response in memory. This bound is required
    // only by the same client's attachment-producing MP3 method.
    maximumBytes: Number.MAX_SAFE_INTEGER,
  });
  const chunks = splitSpeechText(speech);
  const abort = new AbortController();
  const abortProvider = (): void => abort.abort(input.signal.reason);
  if (input.signal.aborted) abortProvider();
  else input.signal.addEventListener("abort", abortProvider, { once: true });

  let index = 0;
  let current = await client.streamPcm({
    text: chunks[0]!,
    voice: MULTIMODAL_AUDIO_DEFAULT_VOICE,
    signal: abort.signal,
  });
  let reader = current.body.getReader();
  // Start the next synthesis while the current PCM is playing. At most one
  // provider request is prefetched, minimizing the audible gap without
  // multiplying requests for the rest of a long message.
  const prefetch = (text: string): ReturnType<AzureAudioClient["streamPcm"]> => {
    const result = client.streamPcm({
      text,
      voice: MULTIMODAL_AUDIO_DEFAULT_VOICE,
      signal: abort.signal,
    });
    // The active stream can fail or be cancelled before this one is awaited.
    // Attaching a rejection observer now prevents a detached provider promise;
    // awaiting `result` below still receives the original rejection.
    void result.catch(() => undefined);
    return result;
  };
  let next = chunks[1] === undefined ? null : prefetch(chunks[1]);

  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        while (true) {
          const read = await reader.read();
          if (!read.done) {
            controller.enqueue(read.value);
            return;
          }
          reader.releaseLock();
          index += 1;
          if (index >= chunks.length) {
            controller.close();
            input.signal.removeEventListener("abort", abortProvider);
            return;
          }
          current = await next!;
          reader = current.body.getReader();
          const following = chunks[index + 1];
          next = following === undefined ? null : prefetch(following);
        }
      } catch (error) {
        abort.abort(error);
        void next?.then((result) => result.body.cancel(error)).catch(() => undefined);
        input.signal.removeEventListener("abort", abortProvider);
        controller.error(error);
      }
    },
    async cancel(reason) {
      abort.abort(reason);
      input.signal.removeEventListener("abort", abortProvider);
      await Promise.all([
        reader.cancel(reason).catch(() => undefined),
        next?.then((result) => result.body.cancel(reason)).catch(() => undefined),
      ]);
    },
  });

  return { body, chunkCount: chunks.length, model: MULTIMODAL_AUDIO_MODEL };
}
