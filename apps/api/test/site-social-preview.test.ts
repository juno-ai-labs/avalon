import UPNG from "upng-js";
import { describe, expect, it } from "vitest";

import {
  generateFallbackSocialCard,
  prepareSocialPreview,
} from "../src/services/terminal/site-social-preview";

const encoder = new TextEncoder();

function file(path: string, bytes: Uint8Array) {
  return { path, bytes, sha256: "0".repeat(64) };
}

describe("site social preview publication", () => {
  it("normalizes authored page metadata and uses a local social card", async () => {
    const card = generateFallbackSocialCard("Authored card");
    const prepared = await prepareSocialPreview([
      file("index.html", encoder.encode(`<!doctype html><html><head>
        <meta content="Release &amp; readiness" property="og:title">
        <meta name="description" content="Milestones &amp; current launch risks.">
        <meta property="og:image" content="./social-preview.png?cache=1">
      </head></html>`)),
      file("social-preview.png", card),
    ], "Directory name");

    expect(prepared.generatedFile).toBeNull();
    expect(prepared.socialPreview).toEqual({
      title: "Release & readiness",
      description: "Milestones & current launch risks.",
      image: {
        path: "social-preview.png",
        contentType: "image/png",
        width: 1200,
        height: 630,
        alt: "Release & readiness",
        generated: false,
      },
    });
  });

  it("generates a valid 1200 by 630 PNG when the page has no local preview", async () => {
    const prepared = await prepareSocialPreview([
      file("index.html", encoder.encode(`<!doctype html><h1>Customer map</h1>
        <p>Accounts, owners, and the next conversation.</p>`)),
    ], "Fallback title");

    expect(prepared.socialPreview.title).toBe("Customer map");
    expect(prepared.socialPreview.description).toBe("Accounts, owners, and the next conversation.");
    expect(prepared.socialPreview.image).toMatchObject({
      path: expect.stringMatching(/^\.rally\/social-preview-[0-9a-f]{12}\.png$/u),
      contentType: "image/png",
      width: 1200,
      height: 630,
    });
    expect(prepared.generatedFile?.bytes.subarray(0, 8)).toEqual(
      new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    );
    const generatedBytes = prepared.generatedFile!.bytes;
    const decoded = UPNG.decode(generatedBytes.buffer.slice(
      generatedBytes.byteOffset,
      generatedBytes.byteOffset + generatedBytes.byteLength,
    ) as ArrayBuffer);
    expect([decoded.width, decoded.height]).toEqual([1200, 630]);
  });

  it("does not turn a remote og:image into a published-site dependency", async () => {
    const prepared = await prepareSocialPreview([
      file("index.html", encoder.encode(`<head>
        <title>Local-only site</title>
        <meta property="og:image" content="https://images.example/card.png">
      </head>`)),
    ], "Fallback title");

    expect(prepared.generatedFile).not.toBeNull();
    expect(prepared.socialPreview.image.path).not.toContain("example");
  });
});
