import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { artifactBlobKey, artifactManifestKey, manifestAssetKey } from "@rally/contracts";
import { sha256Hex } from "../src/lib/crypto";
import { writeArtifactVersion } from "../src/services/terminal/site-resource-bridge";

const artifactId = "00000000-0000-7000-8000-0000000000b1";
const input = {
  workspaceId: "00000000-0000-7000-8000-0000000000c1",
  workstreamId: "00000000-0000-7000-8000-0000000000d1",
  resourceId: "00000000-0000-7000-8000-0000000000e1",
  artifactId, region: "global" as const, version: 3, mode: "static" as const,
  stateful: false, serverModuleSha256: null, fallbackTitle: "Plan",
  // Each its own bytes and digest: R2 checks every write against its digest,
  // and files with the same digest share one stored copy.
  files: await Promise.all(Array.from({ length: 8 }, async (_, index) => {
    const bytes = new TextEncoder().encode(index === 0 ? "<title>Plan</title>" : `asset ${index}`);
    return { path: index === 0 ? "index.html" : `asset-${index}.txt`, bytes, sha256: await sha256Hex(bytes) };
  })),
};

beforeEach(async () => { await reset(); });
afterEach(() => { vi.restoreAllMocks(); });

describe("artifact asset publication in real R2", () => {
  it("writes each file under its version's own prefix until blob writes are turned on", async () => {
    const result = await writeArtifactVersion({ PAYLOADS: env.PAYLOADS }, input);
    expect(result.manifest).not.toHaveProperty("assetStore");
    for (const file of input.files) {
      expect(await (await env.PAYLOADS.get(manifestAssetKey(result.manifest, file)))?.text())
        .toBe(new TextDecoder().decode(file.bytes));
      expect(manifestAssetKey(result.manifest, file)).toBe(`artifact/${artifactId}/v3/assets/${file.path}`);
    }
  });

  it("overlaps uploads and withholds the manifest until every asset is stored", async () => {
    const bucket = env.PAYLOADS;
    const put = bucket.put.bind(bucket);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let active = 0;
    let activeAtManifest = -1;
    let maximum = 0;
    const started: string[] = [];
    vi.spyOn(bucket, "put").mockImplementation(async (...args) => {
      const [key] = args;
      if (key !== artifactManifestKey(artifactId, 3)) {
        started.push(key);
        active += 1;
        maximum = Math.max(maximum, active);
        try { await gate; return await put(...args); }
        finally { active -= 1; }
      }
      activeAtManifest = active;
      return await put(...args);
    });
    const publishing = writeArtifactVersion({ PAYLOADS: bucket, ARTIFACT_BLOB_STORE: "on" }, input);
    try {
      await expect.poll(() => started.length, { timeout: 5_000 }).toBe(6);
      expect(await bucket.get(artifactManifestKey(artifactId, 3))).toBeNull();
    } finally { release(); }
    const result = await publishing;
    expect(maximum).toBe(6);
    expect(activeAtManifest).toBe(0);
    for (const file of result.manifest.assets) {
      const stored = await (await bucket.get(manifestAssetKey(result.manifest, file)))?.text();
      expect(stored).toBeTypeOf("string");
      expect(stored).not.toBe("");
      const inputFile = input.files.find((candidate) => candidate.path === file.path);
      if (inputFile) {
        expect(stored).toBe(new TextDecoder().decode(inputFile?.bytes));
      }
    }
    expect(await (await bucket.get(result.manifestRef))?.json()).toEqual(result.manifest);
  });

  it("drains in-flight writes and never stores the manifest when an asset fails", async () => {
    const bucket = env.PAYLOADS;
    const put = bucket.put.bind(bucket);
    let active = 0;
    const attemptedAssets: string[] = [];
    vi.spyOn(bucket, "put").mockImplementation(async (...args) => {
      if (args[0] !== artifactManifestKey(artifactId, 3)) attemptedAssets.push(args[0]);
      if (args[0] === artifactBlobKey(artifactId, input.files[1]!.sha256)) throw new Error("R2 unavailable");
      active += 1;
      try { return await put(...args); }
      finally { active -= 1; }
    });
    await expect(writeArtifactVersion({ PAYLOADS: bucket, ARTIFACT_BLOB_STORE: "on" }, input)).rejects
      .toMatchObject({ code: "resource_publish_failed" });
    expect(active).toBe(0);
    expect(attemptedAssets).toHaveLength(6);
    expect(await bucket.get(artifactManifestKey(artifactId, 3))).toBeNull();
  });
});
