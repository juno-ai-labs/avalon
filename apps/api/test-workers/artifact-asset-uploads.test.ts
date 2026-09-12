import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { artifactAssetKey, artifactManifestKey } from "@rally/contracts";
import { writeArtifactVersion } from "../src/services/terminal/site-resource-bridge";

const artifactId = "00000000-0000-7000-8000-0000000000b1";
const input = {
  workspaceId: "00000000-0000-7000-8000-0000000000c1",
  workstreamId: "00000000-0000-7000-8000-0000000000d1",
  resourceId: "00000000-0000-7000-8000-0000000000e1",
  artifactId, region: "global" as const, version: 3, mode: "static" as const,
  stateful: false, serverModuleSha256: null, fallbackTitle: "Plan",
  files: Array.from({ length: 8 }, (_, index) => ({
    path: index === 0 ? "index.html" : `asset-${index}.txt`,
    bytes: new TextEncoder().encode(index === 0 ? "<title>Plan</title>" : `asset ${index}`),
    sha256: "1".repeat(64),
  })),
};

beforeEach(async () => { await reset(); });
afterEach(() => { vi.restoreAllMocks(); });

describe("artifact asset publication in real R2", () => {
  it("overlaps uploads and withholds the manifest until every asset is stored", async () => {
    const bucket = env.PAYLOADS;
    const put = bucket.put.bind(bucket);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let active = 0;
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
      expect(active).toBe(0);
      return await put(...args);
    });
    const publishing = writeArtifactVersion({ PAYLOADS: bucket }, input);
    try {
      await expect.poll(() => started.length).toBe(6);
      expect(await bucket.get(artifactManifestKey(artifactId, 3))).toBeNull();
    } finally { release(); }
    const result = await publishing;
    expect(maximum).toBe(6);
    for (const file of input.files) {
      expect(await (await bucket.get(artifactAssetKey(artifactId, 3, file.path)))?.text())
        .toBe(new TextDecoder().decode(file.bytes));
    }
    expect(await (await bucket.get(result.manifestRef))?.json()).toEqual(result.manifest);
  });

  it("drains in-flight writes and never stores the manifest when an asset fails", async () => {
    const bucket = env.PAYLOADS;
    const put = bucket.put.bind(bucket);
    let active = 0;
    vi.spyOn(bucket, "put").mockImplementation(async (...args) => {
      if (args[0] === artifactAssetKey(artifactId, 3, "asset-1.txt")) throw new Error("R2 unavailable");
      active += 1;
      try { return await put(...args); }
      finally { active -= 1; }
    });
    await expect(writeArtifactVersion({ PAYLOADS: bucket }, input)).rejects
      .toMatchObject({ code: "resource_publish_failed" });
    expect(active).toBe(0);
    expect(await bucket.get(artifactManifestKey(artifactId, 3))).toBeNull();
  });
});
