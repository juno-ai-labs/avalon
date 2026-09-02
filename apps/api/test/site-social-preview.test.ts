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

  it("keeps text bounds without splitting an astral character", async () => {
    const title = `${"a".repeat(299)}🚀`;
    const prepared = await prepareSocialPreview([
      file("index.html", encoder.encode(`<title>${title}</title>`)),
    ], "Fallback title");

    expect(prepared.socialPreview.title).toBe("a".repeat(299));
    expect(prepared.socialPreview.title).not.toMatch(/[\uD800-\uDFFF]/u);
  });

  it.each([
    ["extended", webp("VP8X", 640, 360)],
    ["lossy", webp("VP8 ", 640, 360)],
    ["lossless", webp("VP8L", 640, 360)],
  ])("keeps an authored %s WebP preview", async (_kind, card) => {
    const prepared = await prepareSocialPreview([
      file("index.html", encoder.encode(`<title>WebP card</title><meta property="og:image" content="social-preview.webp">`)),
      file("social-preview.webp", card),
    ], "Fallback title");

    expect(prepared.generatedFile).toBeNull();
    expect(prepared.socialPreview.image).toMatchObject({
      path: "social-preview.webp",
      contentType: "image/webp",
      width: 640,
      height: 360,
      generated: false,
    });
  });
});

function webp(chunk: "VP8X" | "VP8 " | "VP8L", width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(30);
  bytes.set(encoder.encode("RIFF"), 0);
  bytes.set(encoder.encode("WEBP"), 8);
  bytes.set(encoder.encode(chunk), 12);
  if (chunk === "VP8X") {
    writeUint24Le(bytes, 24, width - 1);
    writeUint24Le(bytes, 27, height - 1);
  } else if (chunk === "VP8 ") {
    bytes.set([0x9d, 0x01, 0x2a], 23);
    writeUint16Le(bytes, 26, width);
    writeUint16Le(bytes, 28, height);
  } else {
    const packedWidth = width - 1;
    const packedHeight = height - 1;
    bytes[20] = 0x2f;
    bytes[21] = packedWidth & 0xff;
    bytes[22] = ((packedWidth >> 8) & 0x3f) | ((packedHeight & 0x03) << 6);
    bytes[23] = (packedHeight >> 2) & 0xff;
    bytes[24] = (packedHeight >> 10) & 0x0f;
  }
  return bytes;
}

function writeUint16Le(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = value >> 8;
}

function writeUint24Le(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >> 8) & 0xff;
  bytes[offset + 2] = (value >> 16) & 0xff;
}
