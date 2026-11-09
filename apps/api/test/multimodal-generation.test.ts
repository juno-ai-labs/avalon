import type { HarnessToolContext } from "@rally/agent-harness";
import {
  asHarnessRunId,
  asUserId,
  asWorkspaceId,
  asWorkstreamId,
  type WorkstreamWorkflowInput,
} from "@rally/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createAzureImageClient } from "../src/services/multimodal-generation/azure-client";
import { createAzureAudioClient } from "../src/services/multimodal-generation/azure-audio-client";
import {
  createMultimodalAudioResourceStore,
  type MultimodalAudioResourceStore,
  type PublishedMultimodalAudio,
} from "../src/services/multimodal-generation/audio-resource-service";
import {
  createMultimodalGenerationPlugin,
  MULTIMODAL_GENERATION_TIMEOUT_MS,
} from "../src/services/multimodal-generation/contract";
import { createAvalonMultimodalGenerationPlugin } from "../src/services/multimodal-generation/plugin";
import {
  createMultimodalGenerationResourceStore,
  type MultimodalGenerationResourceStore,
  type PublishedMultimodalImage,
} from "../src/services/multimodal-generation/resource-service";
import { createCloudflareTestBinding, createTestD1Database, createTestEnv } from "./helpers/cloudflare-test";
import { preRetirementProductSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";
import { applyWorkspaceResourceSchema } from "./helpers/workspace-object-tables";

const WORKSPACE_ID = asWorkspaceId("10000000-0000-4000-8000-000000000001");
const WORKSTREAM_ID = asWorkstreamId("10000000-0000-4000-8000-000000000002");
const RUN_ID = asHarnessRunId("10000000-0000-4000-8000-000000000003");
const USER_ID = asUserId("10000000-0000-4000-8000-000000000004");
const EFFECT_ID = "10000000-0000-4000-8000-000000000005";
const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const PNG_BYTES = new Uint8Array(Buffer.from(PNG_BASE64, "base64"));
const MP3_BYTES = new Uint8Array([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);

const context: HarnessToolContext = {
  workspaceId: WORKSPACE_ID,
  workstreamId: WORKSTREAM_ID,
  harnessRunId: RUN_ID,
  toolCallId: "image-call",
  effectIntentId: EFFECT_ID,
  executionPrincipal: { type: "user", userId: USER_ID },
  signal: new AbortController().signal,
};

const workflowInput: WorkstreamWorkflowInput = {
  region: "global",
  workspaceId: WORKSPACE_ID,
  parentKind: "canvas",
  parentId: WORKSTREAM_ID,
  loopId: `workstream:${WORKSTREAM_ID}:substream:0:loop`,
  harnessRunId: RUN_ID,
  triggerMessageId: null,
  activityId: null,
  executionPrincipal: context.executionPrincipal,
  reason: "Image generation test",
};

const openDatabases: ReturnType<typeof preRetirementProductSqliteDatabase>[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const database of openDatabases.splice(0)) database.close();
});

describe("multimodal generation contract", () => {
  it("exposes a dedicated deferred plugin with the confirmed strict tool shapes", () => {
    const execute = vi.fn();
    const plugin = createMultimodalGenerationPlugin({
      generate_image: execute,
      edit_image: execute,
      generate_audio: execute,
    });

    expect(plugin).toMatchObject({
      canonicalId: "rally:multimodal-generation",
      modelId: "rally_multimodal_generation",
      // No wire prefix, so a canonical name is also the model-facing one.
      shortWireName: "",
      preload: false,
      explicit: false,
    });
    expect(plugin.tools.map((tool) => ({
      name: tool.definition.name,
      timeoutMs: tool.definition.timeoutMs,
      idempotency: tool.definition.idempotency,
    }))).toEqual([
      { name: "generate_image", timeoutMs: MULTIMODAL_GENERATION_TIMEOUT_MS, idempotency: "record_before_execute" },
      { name: "edit_image", timeoutMs: MULTIMODAL_GENERATION_TIMEOUT_MS, idempotency: "record_before_execute" },
      { name: "generate_audio", timeoutMs: MULTIMODAL_GENERATION_TIMEOUT_MS, idempotency: "record_before_execute" },
    ]);
    expect(plugin.tools[1]!.definition.description).toContain("new version of that same resource");
    expect(plugin.tools.filter((tool) => tool.definition.longRunning).map((tool) => tool.definition.name))
      .toEqual(["generate_image", "edit_image"]);
    expect(plugin.tools[0]!.validateInput?.({ prompt: "Draw a lighthouse", extra: true })).not.toBeNull();
    expect(plugin.tools[0]!.validateInput?.({ prompt: "Draw a lighthouse", size: "1536x1024" })).toBeNull();
    expect(plugin.tools[1]!.validateInput?.({
      resourceId: WORKSPACE_ID,
      prompt: "Make it nocturnal",
      maskResourceId: WORKSTREAM_ID,
      size: "auto",
    })).toBeNull();
    expect(plugin.tools[2]!.validateInput?.({
      text: "Welcome to Rally",
      voice: "marin",
      instructions: "Speak warmly and clearly.",
    })).toBeNull();
    expect(plugin.tools[2]!.validateInput?.({ text: "x".repeat(4_097) })).not.toBeNull();
  });
});

describe("Azure GPT-4o mini TTS client", () => {
  it("locks speech generation to the deployed model and one MP3 response", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(MP3_BYTES, {
      headers: { "content-type": "audio/mpeg", "x-request-id": "azure-audio-1" },
    }));
    const client = createAzureAudioClient({
      endpoint: "https://monad-prod-resource.services.ai.azure.com/",
      apiKey: "secret-key",
      maximumBytes: 25_000_000,
      fetch: fetcher,
    });

    const result = await client.generate({
      text: "Welcome to Rally",
      voice: "marin",
      instructions: "Speak warmly and clearly.",
      signal: context.signal,
    });

    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe("https://monad-prod-resource.services.ai.azure.com/openai/v1/audio/speech");
    expect(init?.headers).toEqual({
      accept: "audio/mpeg",
      "content-type": "application/json",
      "api-key": "secret-key",
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      model: "gpt-4o-mini-tts",
      input: "Welcome to Rally",
      voice: "marin",
      instructions: "Speak warmly and clearly.",
      response_format: "mp3",
    });
    expect(result).toMatchObject({ bytes: MP3_BYTES, providerOperationId: "azure-audio-1" });
  });

  it("requests raw PCM and returns the provider body before it completes", async () => {
    const providerBody = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(Uint8Array.of(0x00, 0x40));
    } });
    const fetcher = vi.fn<typeof fetch>(async () => new Response(providerBody));
    const client = createAzureAudioClient({
      endpoint: "https://monad-prod-resource.services.ai.azure.com",
      apiKey: "secret-key",
      maximumBytes: 25_000_000,
      fetch: fetcher,
    });

    const result = await client.streamPcm({
      text: "Start immediately",
      voice: "marin",
      signal: context.signal,
    });

    const [, init] = fetcher.mock.calls[0]!;
    expect(init?.headers).toEqual({
      accept: "application/octet-stream",
      "content-type": "application/json",
      "api-key": "secret-key",
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      model: "gpt-4o-mini-tts",
      input: "Start immediately",
      voice: "marin",
      response_format: "pcm",
      stream_format: "audio",
    });
    expect(await result.body.getReader().read()).toEqual({
      done: false,
      value: Uint8Array.of(0x00, 0x40),
    });
  });

  it("stops reading a streamed response once it exceeds Rally's attachment limit", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(new Uint8Array(11)));
    const client = createAzureAudioClient({
      endpoint: "https://monad-prod-resource.services.ai.azure.com",
      apiKey: "secret-key",
      maximumBytes: 10,
      fetch: fetcher,
    });

    await expect(client.generate({
      text: "Too large",
      voice: "marin",
      signal: context.signal,
    })).rejects.toMatchObject({ code: "resource_limit_exceeded", retryable: false });
  });
});

describe("Azure GPT Image client", () => {
  it("locks generation to low moderation, medium quality, auto background, one PNG", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => imageResponse());
    const client = createAzureImageClient({
      endpoint: "https://monad-prod-resource.services.ai.azure.com/",
      apiKey: "secret-key",
      fetch: fetcher,
    });

    await client.generate({
      prompt: "A precise architectural sketch",
      size: "1024x1536",
      signal: context.signal,
    });

    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe("https://monad-prod-resource.services.ai.azure.com/openai/v1/images/generations");
    expect(init?.headers).toEqual({
      accept: "application/json",
      "content-type": "application/json",
      "api-key": "secret-key",
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      model: "gpt-image-2",
      prompt: "A precise architectural sketch",
      size: "1024x1536",
      moderation: "low",
      quality: "medium",
      background: "auto",
      n: 1,
      output_format: "png",
    });
  });

  it("sends one source image and an optional PNG mask as multipart edit inputs", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => imageResponse());
    const client = createAzureImageClient({
      endpoint: "https://monad-prod-resource.services.ai.azure.com",
      apiKey: "secret-key",
      fetch: fetcher,
    });

    await client.edit({
      prompt: "Replace the sky",
      size: "auto",
      image: { bytes: PNG_BYTES, mimeType: "image/png", fileName: "source.png" },
      mask: { bytes: PNG_BYTES, mimeType: "image/png", fileName: "mask.png" },
      signal: context.signal,
    });

    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe("https://monad-prod-resource.services.ai.azure.com/openai/v1/images/edits");
    expect(init?.headers).toEqual({ accept: "application/json", "api-key": "secret-key" });
    const body = init?.body as FormData;
    expect(Object.fromEntries([...body.entries()].filter(([, value]) => typeof value === "string"))).toEqual({
      model: "gpt-image-2",
      prompt: "Replace the sky",
      size: "auto",
      moderation: "low",
      quality: "medium",
      background: "auto",
      n: "1",
      output_format: "png",
    });
    expect(body.getAll("image[]")).toHaveLength(1);
    expect(body.getAll("mask")).toHaveLength(1);
  });
});

describe("multimodal generation runtime", () => {
  it("creates one AI audio resource with the default voice and does not charge without pricing", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const publish = vi.fn<MultimodalAudioResourceStore["publish"]>(async (_context, input) => ({
      ...publishedAudio(),
      metadata: { voice: input.voice, billing: input.billing },
    }));
    const audioResources: MultimodalAudioResourceStore = {
      findPublished: vi.fn(async () => null),
      publish,
    };
    const audioClient = {
      generate: vi.fn(async () => ({ bytes: MP3_BYTES, providerOperationId: "audio-request-1" })),
      streamPcm: vi.fn(),
    };
    const plugin = createAvalonMultimodalGenerationPlugin(runtimeEnv(), workflowInput, undefined, {
      audioResources,
      audioClient,
      loadAudioPricing: vi.fn(async () => { throw new Error("pricing record missing"); }),
    });
    const tool = plugin?.tools.find((candidate) => candidate.definition.name === "generate_audio");

    const result = await tool!.execute({ text: "Welcome to Rally" }, context);

    expect(audioClient.generate).toHaveBeenCalledWith(expect.objectContaining({
      text: "Welcome to Rally",
      voice: "marin",
    }));
    expect(publish).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      bytes: MP3_BYTES,
      voice: "marin",
      billing: {
        costUsd: null,
        pricingSourceFingerprint: "unavailable",
        usage: null,
      },
    }));
    expect(result.output).toMatchObject({
      attachmentKind: "audio",
      mimeType: "audio/mpeg",
      model: "gpt-4o-mini-tts",
      outputFormat: "mp3",
      aiGenerated: true,
      billing: { costUsd: null },
    });
    expect(result).not.toHaveProperty("contentParts");
    expect(errorLog).toHaveBeenCalledWith(expect.objectContaining({
      event: "multimodal_generation_pricing_unavailable",
      model: "gpt-4o-mini-tts",
      pricing_model_id: "openai/gpt-4o-mini-tts",
    }));
  });

  it("continues without charging when cached pricing is unavailable and logs the pricing failure", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const publish = vi.fn<MultimodalGenerationResourceStore["publish"]>(async (_context, input) => ({
      ...publishedImage(),
      metadata: { requestedSize: input.requestedSize, billing: input.billing },
    }));
    const resources: MultimodalGenerationResourceStore = {
      findPublished: vi.fn(async () => null),
      loadEditSources: vi.fn(),
      publish,
    };
    const client = {
      generate: vi.fn(async () => ({ bytes: PNG_BYTES, base64: PNG_BASE64 })),
      edit: vi.fn(),
    };
    const plugin = createAvalonMultimodalGenerationPlugin(runtimeEnv(), workflowInput, undefined, {
      resources,
      client,
      loadPricing: vi.fn(async () => { throw new Error("pricing record missing"); }),
    });
    const tool = plugin?.tools.find((candidate) => candidate.definition.name === "generate_image");

    const result = await tool!.execute({ prompt: "A rally point at dawn" }, context);

    expect(client.generate).toHaveBeenCalledOnce();
    expect(publish.mock.calls[0]![1].billing).toEqual({
      costUsd: null,
      pricingSourceFingerprint: "unavailable",
      usage: null,
    });
    expect(result.output).toMatchObject({
      resourceId: "10000000-0000-4000-8000-000000000006",
      operation: "generate",
      requestedSize: "auto",
      billing: { costUsd: null, pricingSourceFingerprint: "unavailable" },
    });
    expect(errorLog).toHaveBeenCalledWith(expect.objectContaining({
      event: "multimodal_generation_pricing_unavailable",
      reason: "pricing record missing",
    }));
  });

  it("publishes edits as a fenced new version of the same source resource", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const source = {
      resourceId: WORKSPACE_ID,
      bytes: PNG_BYTES,
      mimeType: "image/png",
      fileName: "source.png",
      contentRef: "global/source.png",
      storedSha256: "b".repeat(64),
    };
    const publish = vi.fn<MultimodalGenerationResourceStore["publish"]>(async (_context, input) => ({
      ...publishedImage(),
      resourceId: WORKSPACE_ID,
      title: "source.png",
      metadata: { requestedSize: input.requestedSize, billing: input.billing },
    }));
    const resources: MultimodalGenerationResourceStore = {
      findPublished: vi.fn(async () => null),
      loadEditSources: vi.fn(async () => ({ image: source })),
      publish,
    };
    const client = {
      generate: vi.fn(),
      edit: vi.fn(async () => ({ bytes: PNG_BYTES, base64: PNG_BASE64 })),
    };
    const plugin = createAvalonMultimodalGenerationPlugin(runtimeEnv(), workflowInput, undefined, {
      resources,
      client,
      loadPricing: vi.fn(async () => { throw new Error("pricing record missing"); }),
    });
    const tool = plugin?.tools.find((candidate) => candidate.definition.name === "edit_image");

    const result = await tool!.execute({ resourceId: WORKSPACE_ID, prompt: "Make it nocturnal" }, context);

    expect(client.edit).toHaveBeenCalledWith(expect.objectContaining({ image: source, size: "auto" }));
    expect(publish).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      operation: "edit",
      sourceResourceId: WORKSPACE_ID,
      sourceContentRef: source.contentRef,
      sourceContentSha256: source.storedSha256,
    }));
    expect(result.output).toMatchObject({ resourceId: WORKSPACE_ID, operation: "edit" });
    expect(result.summary).toContain("without changing its resource ID");
  });

  it("stores a generated PNG once under the durable effect identity and reuses it on replay", async () => {
    const database = preRetirementProductSqliteDatabase();
    openDatabases.push(database);
    database.exec(`
      INSERT INTO users (id, google_subject, email, name, created_at, updated_at)
      VALUES ('${USER_ID}', 'image-user', 'image@example.com', 'Image', '2026-08-30', '2026-08-30');
      INSERT INTO workspaces (id, name, slug, region, created_by_user_id, created_at, updated_at)
      VALUES ('${WORKSPACE_ID}', 'Image', 'image', 'global', '${USER_ID}', '2026-08-30', '2026-08-30');
    `);
    applyWorkspaceResourceSchema(database, WORKSPACE_ID);
    const objects = new Map<string, Uint8Array>();
    const put = vi.fn(async (key: string, value: Uint8Array | string) => {
      objects.set(key, typeof value === "string" ? new TextEncoder().encode(value) : value);
    });
    const attach = vi.fn(async () => undefined);
    const env = createTestEnv({
      ...runtimeEnv(),
      DB: sqliteD1(database),
      PAYLOADS: createCloudflareTestBinding<R2Bucket>({
        put,
        get: vi.fn(async (key: string) => {
          const bytes = objects.get(key);
          return bytes ? {
            size: bytes.byteLength,
            arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
          } : null;
        }),
      }),
      SESSION_SIGNING_KEY: "test-resource-slug-key",
      MAX_ATTACHMENT_BYTES: "25000000",
    });
    const store = createMultimodalGenerationResourceStore(env, attach);
    const resourceContext = {
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
      harnessRunId: RUN_ID,
      effectIntentId: EFFECT_ID,
      executionPrincipal: context.executionPrincipal,
      onBehalfOfUserId: USER_ID,
    };

    const created = await store.publish(resourceContext, {
      bytes: PNG_BYTES,
      title: "Rally image",
      operation: "generate",
      requestedSize: "1024x1024",
      billing: { costUsd: "0.12", pricingSourceFingerprint: "openrouter-test", usage: null },
    });
    const replayed = await store.findPublished(resourceContext, "generate");

    expect(replayed).toMatchObject({ resourceId: created.resourceId, title: "Rally image", mimeType: "image/png" });
    expect(put).toHaveBeenCalledOnce();
    expect(database.prepare("SELECT COUNT(*) AS count FROM resources").get()).toEqual({ count: 1 });
    expect(attach).toHaveBeenCalledWith(expect.objectContaining({
      resourceId: created.resourceId,
      relationshipType: "generated",
    }));
    expect(JSON.stringify(database.prepare("SELECT metadata_json FROM resources").get())).not.toContain("prompt");

    const source = database.prepare(
      "SELECT content_ref, content_sha256 FROM resources WHERE id = ?",
    ).get(created.resourceId) as { content_ref: string; content_sha256: string };
    const editContext = {
      ...resourceContext,
      effectIntentId: "10000000-0000-4000-8000-000000000007",
    };
    const edited = await store.publish(editContext, {
      bytes: PNG_BYTES,
      operation: "edit",
      requestedSize: "auto",
      sourceResourceId: created.resourceId,
      sourceContentRef: source.content_ref,
      sourceContentSha256: source.content_sha256,
      billing: { costUsd: null, pricingSourceFingerprint: "unavailable", usage: null },
    });
    const editReplay = await store.findPublished(editContext, "edit", created.resourceId);

    expect(edited.resourceId).toBe(created.resourceId);
    expect(editReplay?.resourceId).toBe(created.resourceId);
    expect(database.prepare("SELECT COUNT(*) AS count FROM resources").get()).toEqual({ count: 1 });
    expect(Number((database.prepare("SELECT COUNT(*) AS count FROM resource_versions").get() as { count: number }).count)).toBeGreaterThan(0);
    // The edit names the person whose run made it, so it is not news to them.
    expect(database.prepare(
      "SELECT cause, on_behalf_of_user_id FROM resource_versions WHERE cause = 'replaced'",
    ).all()).toEqual([{ cause: "replaced", on_behalf_of_user_id: USER_ID }]);
  });

  it("stores a generated MP3 once under the durable effect identity and reuses it on replay", async () => {
    const database = preRetirementProductSqliteDatabase();
    openDatabases.push(database);
    database.exec(`
      INSERT INTO users (id, google_subject, email, name, created_at, updated_at)
      VALUES ('${USER_ID}', 'audio-user', 'audio@example.com', 'Audio', '2026-08-30', '2026-08-30');
      INSERT INTO workspaces (id, name, slug, region, created_by_user_id, created_at, updated_at)
      VALUES ('${WORKSPACE_ID}', 'Audio', 'audio', 'global', '${USER_ID}', '2026-08-30', '2026-08-30');
    `);
    applyWorkspaceResourceSchema(database, WORKSPACE_ID);
    const objects = new Map<string, Uint8Array>();
    const put = vi.fn(async (key: string, value: Uint8Array | string) => {
      objects.set(key, typeof value === "string" ? new TextEncoder().encode(value) : value);
    });
    const attach = vi.fn(async () => undefined);
    const env = createTestEnv({
      ...runtimeEnv(),
      DB: sqliteD1(database),
      PAYLOADS: createCloudflareTestBinding<R2Bucket>({
        put,
        get: vi.fn(async (key: string) => {
          const bytes = objects.get(key);
          return bytes ? {
            size: bytes.byteLength,
            arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
          } : null;
        }),
      }),
      SESSION_SIGNING_KEY: "test-resource-slug-key",
      MAX_ATTACHMENT_BYTES: "25000000",
    });
    const store = createMultimodalAudioResourceStore(env, attach);
    const resourceContext = {
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
      harnessRunId: RUN_ID,
      effectIntentId: EFFECT_ID,
      executionPrincipal: context.executionPrincipal,
      onBehalfOfUserId: USER_ID,
    };

    const created = await store.publish(resourceContext, {
      bytes: MP3_BYTES,
      voice: "marin",
      billing: { costUsd: null, pricingSourceFingerprint: "unavailable", usage: null },
    });
    const replayed = await store.findPublished(resourceContext);

    expect(replayed).toMatchObject({
      resourceId: created.resourceId,
      title: "Generated audio.mp3",
      mimeType: "audio/mpeg",
      derivativeStatus: "unsupported",
    });
    expect(put).toHaveBeenCalledOnce();
    expect(database.prepare("SELECT COUNT(*) AS count FROM resources").get()).toEqual({ count: 1 });
    expect(attach).toHaveBeenCalledWith(expect.objectContaining({
      resourceId: created.resourceId,
      relationshipType: "generated",
    }));
    const metadata = database.prepare("SELECT metadata_json FROM resources").get() as { metadata_json: string };
    expect(metadata.metadata_json).not.toContain("Welcome to Rally");
    expect(JSON.parse(metadata.metadata_json)).toMatchObject({
      attachmentKind: "audio",
      aiGenerated: true,
      model: "gpt-4o-mini-tts",
      voice: "marin",
    });
  });
});

function imageResponse(): Response {
  return Response.json({
    data: [{ b64_json: PNG_BASE64 }],
    usage: {
      input_tokens: 10,
      input_tokens_details: { image_tokens: 0, text_tokens: 10 },
      output_tokens: 100,
      output_tokens_details: { image_tokens: 100 },
      total_tokens: 110,
    },
    size: "1024x1024",
    quality: "medium",
    background: "opaque",
    output_format: "png",
  }, { headers: { "x-request-id": "azure-request-1" } });
}

function runtimeEnv() {
  return createTestEnv({
    DB: createTestD1Database({}),
    AVALON_REGION: "global",
    APP_ENV: "test",
    LOG_LEVEL: "info",
    AZURE_INFERENCE_ENDPOINT: "https://monad-prod-resource.services.ai.azure.com",
    AZURE_INFERENCE_API_KEY: "secret-key",
  });
}

function publishedImage(): PublishedMultimodalImage {
  return {
    resourceId: "10000000-0000-4000-8000-000000000006",
    resourceType: "generated_file",
    provider: "avalon_generated",
    title: "Generated image",
    mimeType: "image/png",
    bytes: PNG_BYTES,
    base64: PNG_BASE64,
    sourceSha256: "a".repeat(64),
    createdAt: "2026-08-30T00:00:00.000Z",
    derivativeStatus: "pending",
    metadata: {},
  };
}

function publishedAudio(): PublishedMultimodalAudio {
  return {
    resourceId: "10000000-0000-4000-8000-000000000008",
    resourceType: "generated_file",
    provider: "avalon_generated",
    title: "Generated audio.mp3",
    mimeType: "audio/mpeg",
    bytes: MP3_BYTES,
    sourceSha256: "c".repeat(64),
    createdAt: "2026-08-30T00:00:00.000Z",
    derivativeStatus: "unsupported",
    metadata: {},
  };
}
