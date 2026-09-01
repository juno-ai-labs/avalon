import { env } from "cloudflare:workers";
import { createExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { artifactAssetKey, asArtifactId } from "@rally/contracts";
import type { ArtifactManifest } from "@rally/contracts";
import {
  ASSET_SHIM_MODULE,
  ASSET_SHIM_SOURCE,
  LOADER_ENTRY_MODULE,
  LOADER_ENTRY_SOURCE,
} from "../src/artifacts/asset-shim";

/**
 * A **stateless active** site's isolate, on real workerd.
 *
 * This path had no test of any kind, which is how it shipped an `ASSETS`
 * binding that threw `DataCloneError` on the first request of every active
 * site: the loader's env serializer clones what it is handed and rejects a
 * value carrying a function, and nothing ever invoked a real module to find
 * out. A Node double would have proved the routing and missed the mechanism
 * entirely, which is why this is here rather than in `test/`.
 *
 * **Scope is the isolate contract, not admission.** The host, fetch-metadata,
 * and viewer-session fences in front of this are the policy suite's, and
 * reaching them here would mean seeding a `WorkstreamDO` that answers
 * visibility. What is proved here is what the module receives once it runs: the
 * binding crosses at all, it serves this artifact's published files, it accepts
 * the relative string the skill teaches, and the egress fence holds.
 */

const ARTIFACT = "00000000-0000-7000-8000-0000000000d1";
const PAGE_HTML = "<!doctype html><title>Signups</title><p>Sign up.";
const SEED_JSON = '{"capacity":40}';

/** A stateless active site, written the way the skill teaches one. */
const SIGNUP_MODULE = `
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/capacity") {
      const seed = await (await env.ASSETS.fetch("/seed.json")).json();
      return Response.json(seed);
    }
    if (url.pathname === "/api/egress") {
      try {
        await fetch("https://example.invalid/");
        return Response.json({ threw: false });
      } catch {
        return Response.json({ threw: true });
      }
    }
    return env.ASSETS.fetch(request);
  },
};
`;

function manifest(version: number): ArtifactManifest {
  return {
    version: 1,
    artifactId: asArtifactId(ARTIFACT),
    artifactVersion: version,
    mode: "active",
    stateful: false,
    serverModuleSha256: "a".repeat(64),
    assets: [
      {
        path: "index.html",
        contentType: "text/html; charset=utf-8",
        sizeBytes: PAGE_HTML.length,
        sha256: "b".repeat(64),
      },
      {
        path: "seed.json",
        contentType: "application/json; charset=utf-8",
        sizeBytes: SEED_JSON.length,
        sha256: "c".repeat(64),
      },
    ],
    totalBytes: PAGE_HTML.length + SEED_JSON.length,
    publishedAt: "2026-09-01T12:00:00.000Z",
  };
}

/**
 * The isolate as the serving Worker assembles it.
 *
 * A fresh version per call, because the loader caches an isolate by its id and
 * a reused one would serve the previous module — the trap the facet suite
 * records.
 */
let nextVersion = 0;
async function serve(path: string): Promise<Response> {
  nextVersion += 1;
  const version = nextVersion;
  const site = manifest(version);
  await env.PAYLOADS.put(artifactAssetKey(ARTIFACT, version, "index.js"), SIGNUP_MODULE);
  await env.PAYLOADS.put(artifactAssetKey(ARTIFACT, version, "index.html"), PAGE_HTML);
  await env.PAYLOADS.put(artifactAssetKey(ARTIFACT, version, "seed.json"), SEED_JSON);

  const loader = env.ARTIFACT_LOADER;
  if (!loader) throw new Error("this suite needs the worker_loaders binding");
  const ctx = createExecutionContext();
  const worker = loader.get(`artifact:${ARTIFACT}:v${version}`, async () => ({
    compatibilityDate: "2026-08-01",
    mainModule: LOADER_ENTRY_MODULE,
    modules: {
      [LOADER_ENTRY_MODULE]: LOADER_ENTRY_SOURCE,
      [ASSET_SHIM_MODULE]: ASSET_SHIM_SOURCE,
      "index.js": SIGNUP_MODULE,
    },
    env: {
      ASSETS: ctx.exports.ArtifactAssetLoopback({
        props: {
          artifactId: ARTIFACT,
          version,
          assets: site.assets.map((asset) => ({
            path: asset.path,
            contentType: asset.contentType,
          })),
        },
      }),
    },
    globalOutbound: null,
  }));
  return await worker.getEntrypoint().fetch(
    new Request(`https://${ARTIFACT}-g.rallyusercontent.test${path}`),
  );
}

describe("a stateless active site's isolate", () => {
  it("serves its own published page through the ASSETS binding", async () => {
    // The binding crossing at all is the assertion: a plain object carrying a
    // `fetch` is rejected by the loader's env serializer, so this request threw
    // `DataCloneError` before any of the module's own code ran.
    const response = await serve("/");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(PAGE_HTML);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
  });

  it("accepts the relative string the skill teaches for a server-side read", async () => {
    // A stub's own `fetch` is the runtime's Fetcher and throws
    // `Invalid URL: /seed.json` on this. Rally's shim in front of the site's
    // module is what makes the declared `Request | string` contract true.
    const response = await serve("/api/capacity");
    expect(await response.json()).toEqual({ capacity: 40 });
  });

  it("answers a path the manifest does not name with a 404", async () => {
    expect((await serve("/nope.css")).status).toBe(404);
  });

  it("gives the site no network at all", async () => {
    // `globalOutbound: null`, reported by the module's own catch rather than by
    // a mock, so what is proved is the platform's fence and not a stub's.
    expect(await (await serve("/api/egress")).json()).toEqual({ threw: true });
  });
});
