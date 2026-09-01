/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * One deterministic OpenRouter boundary, shared by every real-workerd suite
 * that needs a live agent run.
 *
 * Each object in a Vitest worker shares one `globalThis` inside the Durable
 * Object isolate — including a finished test's object that is still draining —
 * so an install gives its own object a unique OpenRouter key and attributes
 * every captured request by the bearer token it arrived with, rather than by
 * whatever is next in a file-wide queue. That is what lets two suites install
 * against different objects at the same time without stealing each other's
 * scripted turns.
 *
 * This replaces only the external system workerd cannot own. The production
 * harness, its RPC and storage ports, and the object's own alarm all run.
 */

import { runInDurableObject } from "cloudflare:test";

import type { Env } from "../../src/env";

export interface CapturedProviderRequest {
  url: string;
  body: Record<string, unknown>;
}

/** One scripted turn: the stream's events, or a terminal provider refusal. */
export type ScriptedProviderTurn = readonly unknown[] | "refuse";

interface ProviderCaptureEntry {
  requests: CapturedProviderRequest[];
  scripts: (unknown[] | "refuse")[];
  models: string[];
  /**
   * Holds the first provider call open until the test opens it, so the loop is
   * genuinely executing while a follow-up is admitted. `null` for the installs
   * that want no gate at all.
   */
  gate: { open: boolean } | null;
}

type ProviderCaptureGlobal = typeof globalThis & {
  __rallyPipelineOriginalFetch?: typeof fetch;
  __rallyPipelineProviderState?: Map<string, ProviderCaptureEntry>;
};

/**
 * Every object in this file shares one `globalThis` inside the Durable Object
 * isolate, so the `fetch` a live test installs also serves a finished test's
 * still-draining object. Each install therefore gives its own object a unique
 * OpenRouter key and keys its captured requests and script queue by that
 * object's id, and the installed `fetch` attributes a request by the bearer
 * token it arrived with instead of taking whatever is next in a file-wide queue.
 */
const PROVIDER_KEY_PREFIX = "workerd-pipeline-provider-key:";

export async function installProviderCapture(
  stub: DurableObjectStub,
  model: string,
): Promise<void> {
  await runInDurableObject(stub, (instance, state) => {
    const objectId = state.id.toString();
    const target = instance as unknown as { env: Env };
    target.env = new Proxy(target.env, {
      get: (current, property, receiver) => {
        if (property === "OPENROUTER_API_KEY") return `${PROVIDER_KEY_PREFIX}${objectId}`;
        if (property === "OPENROUTER_PRIMARY_MODEL") return model;
        if (property === "OPENROUTER_FALLBACK_MODELS") return "";
        return Reflect.get(current, property, receiver);
      },
    });
    const scope = globalThis as ProviderCaptureGlobal;
    scope.__rallyPipelineOriginalFetch ??= scope.fetch;
    const objects = scope.__rallyPipelineProviderState ??= new Map<string, ProviderCaptureEntry>();
    objects.set(objectId, { requests: [], scripts: [], models: [model], gate: null });
    scope.fetch = (async (request: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof request === "string"
        ? request
        : request instanceof URL
          ? request.toString()
          : request.url;
      if (url === "https://openrouter.ai/api/v1/models") return providerCatalog(objects);
      const entry = providerCaller(objects, request, init);
      if (!entry) return unattributedProviderResponse();
      if (url === "https://openrouter.ai/api/v1/chat/completions") {
        const text = typeof init?.body === "string"
          ? init.body
          : request instanceof Request
            ? await request.clone().text()
            : "";
        entry.requests.push({
          url,
          body: JSON.parse(text) as Record<string, unknown>,
        });
        return Response.json(
          { error: { code: "test_provider_rejection", message: "test provider rejection" } },
          { status: 401 },
        );
      }
      throw new Error(`unexpected_pipeline_provider_request:${url}`);
    }) as typeof fetch;
  });
}

/**
 * The models catalog is fetched without an Authorization header, so it cannot be
 * attributed to one object; every registered object's models answer it, which is
 * all any of them reads out of it.
 */
function providerCatalog(objects: Map<string, ProviderCaptureEntry>): Response {
  const ids = [...new Set([...objects.values()].flatMap((entry) => entry.models))];
  return Response.json({ data: ids.map((id) => ({ id, context_length: 131_072 })) });
}

/** The entry of the object whose per-object key signed this request, if any. */
function providerCaller(
  objects: Map<string, ProviderCaptureEntry>,
  request: RequestInfo | URL,
  init?: RequestInit,
): ProviderCaptureEntry | null {
  const authorization = request instanceof Request
    ? request.headers.get("authorization")
    : new Headers(init?.headers).get("authorization");
  const prefix = `Bearer ${PROVIDER_KEY_PREFIX}`;
  return (authorization?.startsWith(prefix)
    ? objects.get(authorization.slice(prefix.length))
    : undefined) ?? null;
}

/**
 * A request signed by no live install belongs to an object this file has
 * already finished with — a drain outliving its test. It is refused with the
 * provider's own terminal status rather than a thrown transport failure, which
 * the harness would retry: that keeps the zombie's work out of the running
 * test's captured requests and script queue *and* off its machine.
 */
function unattributedProviderResponse(): Response {
  return Response.json(
    {
      error: {
        code: "unattributed_pipeline_provider_request",
        message: "no live provider install owns this key",
      },
    },
    { status: 401 },
  );
}

export function providerStream(events: readonly unknown[]): Response {
  const encoder = new TextEncoder();
  const chunks = [
    ...events.map((event) => `data: ${JSON.stringify(event)}\n\n`),
    "data: [DONE]\n\n",
  ];
  let index = 0;
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[index];
      index += 1;
      if (chunk === undefined) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(chunk));
    },
  }), { headers: { "content-type": "text/event-stream" } });
}

/** Replace only the external provider with deterministic streaming turns. */
export async function installScriptedProvider(
  stub: DurableObjectStub,
  scripts: readonly ScriptedProviderTurn[],
  routing: {
    primaryModel: string;
    fallbackModels: readonly string[];
    /**
     * Hold the first provider call until `openProviderGate`. The run is then
     * observably executing while the test admits a follow-up, instead of the
     * test racing a stream that answers in microseconds.
     */
    gateFirstCall?: boolean;
  },
): Promise<void> {
  await runInDurableObject(stub, (instance, state) => {
    const objectId = state.id.toString();
    const target = instance as unknown as { env: Env };
    target.env = new Proxy(target.env, {
      get: (current, property, receiver) => {
        if (property === "OPENROUTER_API_KEY") return `${PROVIDER_KEY_PREFIX}${objectId}`;
        if (property === "OPENROUTER_PRIMARY_MODEL") return routing.primaryModel;
        if (property === "OPENROUTER_FALLBACK_MODELS") {
          return routing.fallbackModels.join(",");
        }
        return Reflect.get(current, property, receiver);
      },
    });
    const scope = globalThis as ProviderCaptureGlobal;
    scope.__rallyPipelineOriginalFetch ??= scope.fetch;
    const objects = scope.__rallyPipelineProviderState ??= new Map<string, ProviderCaptureEntry>();
    objects.set(objectId, {
      requests: [],
      scripts: scripts.map((events) => events === "refuse" ? "refuse" : [...events]),
      models: [routing.primaryModel, ...routing.fallbackModels],
      gate: routing.gateFirstCall === true ? { open: false } : null,
    });
    scope.fetch = (async (request: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof request === "string"
        ? request
        : request instanceof URL
          ? request.toString()
          : request.url;
      if (url === "https://openrouter.ai/api/v1/models") return providerCatalog(objects);
      const entry = providerCaller(objects, request, init);
      if (!entry) return unattributedProviderResponse();
      if (url !== "https://openrouter.ai/api/v1/chat/completions") {
        throw new Error(`unexpected_pipeline_provider_request:${url}`);
      }
      const text = typeof init?.body === "string"
        ? init.body
        : request instanceof Request
          ? await request.clone().text()
          : "";
      const body = JSON.parse(text) as Record<string, unknown>;
      entry.requests.push({ url, body });
      const gate = entry.gate;
      if (gate && entry.requests.length === 1) {
        while (!gate.open) await scheduler.wait(10);
      }
      if (body.stream !== true) {
        return Response.json(
          { error: { code: "test_structured_request_refused", message: "not part of this oracle" } },
          { status: 401 },
        );
      }
      const events = entry.scripts.shift();
      if (!events) {
        return Response.json(
          { error: { code: "unexpected_extra_stream", message: "script exhausted" } },
          { status: 500 },
        );
      }
      // A scripted refusal is the provider's own terminal status, not a thrown
      // transport failure the harness would retry: it fails this run at the
      // provider boundary and leaves the loop free for whatever waits behind it.
      if (events === "refuse") {
        return Response.json(
          { error: { code: "test_provider_rejection", message: "test provider rejection" } },
          { status: 401 },
        );
      }
      return providerStream(events);
    }) as typeof fetch;
  });
}

export async function capturedProviderRequests(stub: DurableObjectStub): Promise<CapturedProviderRequest[]> {
  return runInDurableObject(stub, (_instance, state) => {
    const scope = globalThis as ProviderCaptureGlobal;
    return structuredClone(
      scope.__rallyPipelineProviderState?.get(state.id.toString())?.requests ?? [],
    );
  });
}

export async function openProviderGate(stub: DurableObjectStub): Promise<void> {
  await runInDurableObject(stub, (_instance, state) => {
    const scope = globalThis as ProviderCaptureGlobal;
    const gate = scope.__rallyPipelineProviderState?.get(state.id.toString())?.gate;
    if (!gate) throw new Error("no_provider_gate_installed");
    gate.open = true;
  });
}

export async function restoreProviderFetch(stub: DurableObjectStub): Promise<void> {
  await runInDurableObject(stub, (_instance, state) => {
    const scope = globalThis as ProviderCaptureGlobal;
    scope.__rallyPipelineProviderState?.delete(state.id.toString());
    // Hand the real fetch back only once no object still holds an install:
    // every patched closure dispatches through the shared map, so while any
    // entry remains the patch must stay, and restoring per-caller would strand
    // a concurrent test's requests on the real network. Safe to call twice —
    // a second call deletes nothing and finds either an empty map or nothing
    // saved to restore.
    if ((scope.__rallyPipelineProviderState?.size ?? 0) === 0
      && scope.__rallyPipelineOriginalFetch) {
      scope.fetch = scope.__rallyPipelineOriginalFetch;
      delete scope.__rallyPipelineOriginalFetch;
    }
  });
}
