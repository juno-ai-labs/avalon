import { ARTIFACT_MAX_ASSET_COUNT, artifactAssetKey } from "@rally/contracts";
import { describe, expect, it, vi } from "vitest";

import type { Env } from "../src/env";
import { writeArtifactVersion } from "../src/services/terminal/site-resource-bridge";
import { createCloudflareTestBinding } from "./helpers/cloudflare-test";

const ARTIFACT = "00000000-0000-7000-8000-0000000000b1";

describe("site artifact social-preview storage", () => {
  it("stores a generated card as a versioned asset and describes it in the manifest", async () => {
    const stored = new Map<string, Uint8Array>();
    const put = vi.fn(async (key: string, value: Uint8Array | string) => {
      stored.set(key, typeof value === "string" ? new TextEncoder().encode(value) : value);
    });
    const env = {
      PAYLOADS: createCloudflareTestBinding<R2Bucket>({ put }),
    } satisfies Pick<Env, "PAYLOADS">;
    const html = new TextEncoder().encode("<html><head><title>Quarterly plan</title></head><body></body></html>");

    const written = await writeArtifactVersion(env, {
      workspaceId: "00000000-0000-7000-8000-0000000000c1",
      workstreamId: "00000000-0000-7000-8000-0000000000d1",
      region: "global",
      artifactId: ARTIFACT,
      resourceId: "00000000-0000-7000-8000-0000000000e1",
      version: 3,
      mode: "static",
      stateful: false,
      files: [{ path: "index.html", bytes: html, sha256: "1".repeat(64) }],
      fallbackTitle: "Plan",
      serverModuleSha256: null,
    });

    const imagePath = written.manifest.socialPreview?.image.path;
    expect(imagePath).toMatch(/^\.rally\/social-preview-[0-9a-f]{12}\.png$/u);
    expect(written.manifest.assets.map((asset) => asset.path)).toEqual(["index.html", imagePath]);
    expect(stored.get(artifactAssetKey(ARTIFACT, 3, imagePath!))?.subarray(0, 8)).toEqual(
      new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    );
    expect(written.manifest.totalBytes).toBeGreaterThan(html.byteLength);
  });

  it("refuses a generated card that would exceed the existing manifest asset ceiling", async () => {
    const put = vi.fn(async () => undefined);
    const env = {
      PAYLOADS: createCloudflareTestBinding<R2Bucket>({ put }),
    } satisfies Pick<Env, "PAYLOADS">;
    const bytes = new TextEncoder().encode("x");
    const files = Array.from({ length: ARTIFACT_MAX_ASSET_COUNT }, (_, index) => ({
      path: index === 0 ? "index.html" : `asset-${index}.txt`,
      bytes,
      sha256: "1".repeat(64),
    }));

    await expect(writeArtifactVersion(env, {
      workspaceId: "00000000-0000-7000-8000-0000000000c1",
      workstreamId: "00000000-0000-7000-8000-0000000000d1",
      region: "global",
      artifactId: ARTIFACT,
      resourceId: "00000000-0000-7000-8000-0000000000e1",
      version: 3,
      mode: "static",
      stateful: false,
      files,
      fallbackTitle: "Plan",
      serverModuleSha256: null,
    })).rejects.toMatchObject({ code: "resource_publish_failed" });
    expect(put).not.toHaveBeenCalled();
  });

  it("records anonymous submissions in the manifest only when index.js declares them", async () => {
    const env = { PAYLOADS: createCloudflareTestBinding<R2Bucket>({ put: vi.fn(async () => undefined) }) } satisfies Pick<Env, "PAYLOADS">;
    const html = new TextEncoder().encode("<html><head><title>Poll</title></head><body></body></html>");
    const publish = (source: string) => writeArtifactVersion(env, {
      workspaceId: "00000000-0000-7000-8000-0000000000c1",
      workstreamId: "00000000-0000-7000-8000-0000000000d1",
      region: "global",
      artifactId: ARTIFACT,
      resourceId: "00000000-0000-7000-8000-0000000000e1",
      version: 1,
      mode: "active",
      stateful: true,
      files: [
        { path: "index.html", bytes: html, sha256: "1".repeat(64) },
        { path: "index.js", bytes: new TextEncoder().encode(source), sha256: "2".repeat(64) },
      ],
      fallbackTitle: "Poll",
      serverModuleSha256: "2".repeat(64),
    });
    expect((await publish("export const acceptAnonymousSubmissions = true;\nexport class SiteData {}")).manifest.anonymousSubmissions).toBe(true);
    expect((await publish("export class SiteData {}")).manifest).not.toHaveProperty("anonymousSubmissions");
  });
});
