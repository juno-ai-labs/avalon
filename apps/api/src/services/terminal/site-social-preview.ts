import UPNG from "upng-js";

import type { ArtifactSocialPreview } from "@rally/contracts";

import { sha256Hex } from "../../lib/crypto";
import { assetContentType } from "./site-publish";

const CARD_WIDTH = 1200;
const CARD_HEIGHT = 630;
const GENERATED_PREVIEW_DIRECTORY = ".rally";

type PreviewFile = Readonly<{
  path: string;
  bytes: Uint8Array;
  sha256: string;
}>;

export type PreparedSocialPreview = Readonly<{
  socialPreview: ArtifactSocialPreview;
  generatedFile: PreviewFile | null;
}>;

/**
 * Normalize the page's authored metadata, filling every missing field at the
 * publish boundary so the serving hot path only has to serialize it.
 */
export async function prepareSocialPreview(
  files: readonly PreviewFile[],
  fallbackTitle: string,
): Promise<PreparedSocialPreview> {
  const index = files.find((file) => file.path === "index.html");
  const source = index ? new TextDecoder("utf-8", { fatal: false }).decode(index.bytes) : "";
  const title = limitUtf16WithoutSplitting(firstText(
    metaContent(source, "property", "og:title"),
    metaContent(source, "name", "twitter:title"),
    elementText(source, "title"),
    elementText(source, "h1"),
    fallbackTitle,
    "Rally site",
  ), 300);
  const description = limitUtf16WithoutSplitting(firstText(
    metaContent(source, "property", "og:description"),
    metaContent(source, "name", "twitter:description"),
    metaContent(source, "name", "description"),
    elementText(source, "p"),
    `A live site about ${title}.`,
  ), 500);
  const image = findAuthoredPreview(source, files);
  if (image) {
    return {
      socialPreview: {
        title,
        description,
        image: { ...image, alt: title, generated: false },
      },
      generatedFile: null,
    };
  }

  const bytes = generateFallbackSocialCard(title);
  const titleDigest = await sha256Hex(new TextEncoder().encode(title));
  const generatedFile = {
    path: `${GENERATED_PREVIEW_DIRECTORY}/social-preview-${titleDigest.slice(0, 12)}.png`,
    bytes,
    sha256: await sha256Hex(bytes),
  };
  return {
    socialPreview: {
      title,
      description,
      image: {
        path: generatedFile.path,
        contentType: "image/png",
        width: CARD_WIDTH,
        height: CARD_HEIGHT,
        alt: title,
        generated: true,
      },
    },
    generatedFile,
  };
}

function firstText(...values: Array<string | null | undefined>): string {
  for (const value of values) {
    const normalized = normalizeText(value ?? "");
    if (normalized) return normalized;
  }
  return "Rally site";
}

function limitUtf16WithoutSplitting(value: string, maximumCodeUnits: number): string {
  let result = "";
  for (const character of value) {
    if (result.length + character.length > maximumCodeUnits) break;
    result += character;
  }
  return result;
}

function normalizeText(value: string): string {
  return decodeHtmlEntities(value.replace(/<[^>]*>/gu, " "))
    .replace(/\s+/gu, " ")
    .trim();
}

function decodeHtmlEntities(value: string): string {
  return value.replace(/&(?:#(\d+)|#x([\da-f]+)|amp|quot|apos|lt|gt);/giu, (entity, decimal, hex) => {
    if (decimal || hex) {
      const codePoint = decimal ? Number(decimal) : Number.parseInt(hex, 16);
      return Number.isSafeInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : entity;
    }
    return ({
      "&amp;": "&",
      "&quot;": "\"",
      "&apos;": "'",
      "&lt;": "<",
      "&gt;": ">",
    } as Record<string, string>)[entity.toLowerCase()] ?? entity;
  });
}

function elementText(source: string, tag: string): string | null {
  const match = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}\\s*>`, "iu").exec(source);
  return match?.[1] ?? null;
}

function metaContent(source: string, key: "name" | "property", expected: string): string | null {
  for (const match of source.matchAll(/<meta\b[^>]*>/giu)) {
    const attributes = htmlAttributes(match[0]);
    if (attributes.get(key)?.toLowerCase() === expected) return attributes.get("content") ?? null;
  }
  return null;
}

function htmlAttributes(tag: string): Map<string, string> {
  const result = new Map<string, string>();
  const pattern = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gu;
  for (const match of tag.matchAll(pattern)) {
    result.set(match[1]!.toLowerCase(), match[2] ?? match[3] ?? match[4] ?? "");
  }
  return result;
}

function findAuthoredPreview(
  source: string,
  files: readonly PreviewFile[],
): Omit<ArtifactSocialPreview["image"], "alt" | "generated"> | null {
  const declared = [
    metaContent(source, "property", "og:image"),
    metaContent(source, "name", "twitter:image"),
  ];
  const conventional = [
    "social-preview.png", "social-preview.jpg", "social-preview.jpeg", "social-preview.webp",
    "og-image.png", "og-image.jpg", "og.png",
  ];
  for (const candidate of [...declared, ...conventional]) {
    const path = candidate ? localAssetPath(candidate) : null;
    if (!path) continue;
    const file = files.find((entry) => entry.path === path);
    if (!file) continue;
    const contentType = assetContentType(path);
    if (!isSocialImageType(contentType)) continue;
    const dimensions = imageDimensions(file.bytes, contentType);
    if (!dimensions) continue;
    return { path, contentType, ...dimensions };
  }
  return null;
}

function localAssetPath(value: string): string | null {
  const normalized = decodeHtmlEntities(value).trim();
  if (!normalized || normalized.startsWith("//") || /^[a-z][a-z\d+.-]*:/iu.test(normalized)) return null;
  try {
    const url = new URL(normalized, "https://artifact.invalid/");
    if (url.origin !== "https://artifact.invalid") return null;
    return decodeURIComponent(url.pathname).replace(/^\/+|\/+/gu, (slashes, offset) => offset === 0 ? "" : "/");
  } catch {
    return null;
  }
}

function isSocialImageType(value: string): value is ArtifactSocialPreview["image"]["contentType"] {
  return value === "image/png" || value === "image/jpeg" || value === "image/gif" || value === "image/webp";
}

function imageDimensions(
  bytes: Uint8Array,
  contentType: ArtifactSocialPreview["image"]["contentType"],
): { width: number; height: number } | null {
  if (contentType === "image/png" && bytes.length >= 24
    && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return dimensions(readUint32(bytes, 16), readUint32(bytes, 20));
  }
  if (contentType === "image/gif" && bytes.length >= 10
    && String.fromCharCode(...bytes.subarray(0, 3)) === "GIF") {
    return dimensions(bytes[6]! | (bytes[7]! << 8), bytes[8]! | (bytes[9]! << 8));
  }
  if (contentType === "image/webp") return webpDimensions(bytes);
  if (contentType === "image/jpeg") return jpegDimensions(bytes);
  return null;
}

function webpDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 25
    || String.fromCharCode(...bytes.subarray(0, 4)) !== "RIFF"
    || String.fromCharCode(...bytes.subarray(8, 12)) !== "WEBP") return null;
  const chunk = String.fromCharCode(...bytes.subarray(12, 16));
  if (chunk === "VP8X" && bytes.length >= 30) {
    return dimensions(1 + readUint24Le(bytes, 24), 1 + readUint24Le(bytes, 27));
  }
  if (chunk === "VP8 " && bytes.length >= 30
    && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
    return dimensions(readUint16Le(bytes, 26) & 0x3fff, readUint16Le(bytes, 28) & 0x3fff);
  }
  if (chunk === "VP8L" && bytes[20] === 0x2f) {
    const width = 1 + bytes[21]! + ((bytes[22]! & 0x3f) << 8);
    const height = 1 + (bytes[22]! >> 6) + (bytes[23]! << 2) + ((bytes[24]! & 0x0f) << 10);
    return dimensions(width, height);
  }
  return null;
}

function jpegDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 8 < bytes.length) {
    if (bytes[offset] !== 0xff) { offset += 1; continue; }
    const marker = bytes[offset + 1]!;
    if (marker === 0xd8 || marker === 0xd9) { offset += 2; continue; }
    const length = (bytes[offset + 2]! << 8) | bytes[offset + 3]!;
    if (length < 2 || offset + length + 2 > bytes.length) return null;
    if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7)
      || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
      return dimensions(
        (bytes[offset + 7]! << 8) | bytes[offset + 8]!,
        (bytes[offset + 5]! << 8) | bytes[offset + 6]!,
      );
    }
    offset += length + 2;
  }
  return null;
}

function dimensions(width: number, height: number): { width: number; height: number } | null {
  return Number.isSafeInteger(width) && Number.isSafeInteger(height) && width > 0 && height > 0
    ? { width, height }
    : null;
}

function readUint32(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset]! << 24) | (bytes[offset + 1]! << 16)
    | (bytes[offset + 2]! << 8) | bytes[offset + 3]!) >>> 0;
}

function readUint24Le(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16);
}

function readUint16Le(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8);
}

/** A dependency-free, deterministic branded card for sites without artwork. */
export function generateFallbackSocialCard(title: string): Uint8Array {
  assertFontShape();
  const rgba = new Uint8Array(CARD_WIDTH * CARD_HEIGHT * 4);
  const seed = [...title].reduce((value, character) => ((value * 33) ^ character.codePointAt(0)!) >>> 0, 5381);
  const accent = [180 + (seed & 31), 78 + ((seed >>> 5) & 31), 74 + ((seed >>> 10) & 31)] as const;
  for (let y = 0; y < CARD_HEIGHT; y += 1) {
    for (let x = 0; x < CARD_WIDTH; x += 1) {
      const offset = (y * CARD_WIDTH + x) * 4;
      const glow = Math.max(0, 1 - Math.hypot(x - 1000, y - 80) / 720);
      rgba[offset] = Math.round(25 + glow * accent[0] * 0.32);
      rgba[offset + 1] = Math.round(27 + glow * accent[1] * 0.24);
      rgba[offset + 2] = Math.round(36 + glow * accent[2] * 0.28);
      rgba[offset + 3] = 255;
    }
  }
  fillRoundedApprox(rgba, 70, 70, 1060, 490, 34, [245, 241, 232, 255]);
  fillRoundedApprox(rgba, 100, 100, 104, 104, 24, [...accent, 255]);
  drawText(rgba, "R", 128, 122, 12, [255, 255, 255, 255]);
  drawText(rgba, "RALLY", 238, 128, 8, [39, 39, 45, 255]);
  const words = fallbackCardText(title, seed).split(" ");
  const lines = wrapWords(words, 18).slice(0, 2);
  lines.forEach((line, index) => drawText(rgba, line, 105, 270 + index * 92, 10, [39, 39, 45, 255]));
  fillRect(rgba, 105, 490, 180, 8, [...accent, 255]);
  return new Uint8Array(UPNG.encode([exactArrayBuffer(rgba)], CARD_WIDTH, CARD_HEIGHT, 0));
}

function wrapWords(words: string[], lineLength: number): string[] {
  const lines: string[] = [];
  for (const word of words) {
    const clipped = limitUtf16WithoutSplitting(word, lineLength);
    const current = lines.at(-1);
    if (!current || current.length + 1 + clipped.length > lineLength) lines.push(clipped);
    else lines[lines.length - 1] = `${current} ${clipped}`;
  }
  return lines.length > 0 ? lines : ["RALLY SITE"];
}

function fallbackCardText(title: string, seed: number): string {
  const transliterated = normalizeText(title)
    .normalize("NFKD")
    .replace(/\p{Mark}+/gu, "")
    .toUpperCase();
  let supportedCharacters = 0;
  const visible = [...transliterated].map((character) => {
    if (FONT[character]) {
      if (/[A-Z0-9]/u.test(character)) supportedCharacters += 1;
      return character;
    }
    return character.trim() ? "?" : " ";
  }).join("").replace(/\s+/gu, " ").trim();
  if (supportedCharacters > 0) return visible;
  return `RALLY SITE ${seed.toString(16).toUpperCase().padStart(8, "0").slice(0, 6)}`;
}

const FONT: Readonly<Record<string, string>> = Object.freeze({
  A: "01110100011000111111100011000110001", B: "11110100011000111110100011000111110",
  C: "01111100001000010000100001000001111", D: "11110100011000110001100011000111110",
  E: "11111100001000011110100001000011111", F: "11111100001000011110100001000010000",
  G: "01111100001000010111100011000101111", H: "10001100011000111111100011000110001",
  I: "11111001000010000100001000010011111", J: "00111000100001000010100101001001100",
  K: "10001100101010011000101001001010001", L: "10000100001000010000100001000011111",
  M: "10001110111010110101100011000110001", N: "10001110011010110011100011000110001",
  O: "01110100011000110001100011000101110", P: "11110100011000111110100001000010000",
  Q: "01110100011000110001101011001001101", R: "11110100011000111110101001001010001",
  S: "01111100001000001110000010000111110", T: "11111001000010000100001000010000100",
  U: "10001100011000110001100011000101110", V: "10001100011000110001100010101000100",
  W: "10001100011000110101101011101110001", X: "10001100010101000100010101000110001",
  Y: "10001100010101000100001000010000100", Z: "11111000010001000100010001000011111",
  "0": "01110100011001110101110011000101110", "1": "00100011000010000100001000010001110",
  "2": "01110100010000100010001000100011111", "3": "11110000010000101110000010000111110",
  "4": "00010001100101010010111110001000010", "5": "11111100001000011110000010000111110",
  "6": "01110100001000011110100011000101110", "7": "11111000010001000100010000100001000",
  "8": "01110100011000101110100011000101110", "9": "01110100011000101111000010000101110",
  "-": "00000000000000011111000000000000000", ".": "00000000000000000000000000110001100",
  "?": "01110100010001000100001000000000100",
  " ": "00000000000000000000000000000000000",
});

function assertFontShape(): void {
  for (const [character, glyph] of Object.entries(FONT)) {
    if (glyph.length !== 35) throw new Error(`Invalid social-preview glyph: ${character}`);
  }
}

function drawText(
  rgba: Uint8Array,
  value: string,
  x: number,
  y: number,
  scale: number,
  color: readonly [number, number, number, number],
): void {
  let cursor = x;
  for (const character of value) {
    const glyph = FONT[character] ?? FONT["?"]!;
    for (let row = 0; row < 7; row += 1) {
      for (let column = 0; column < 5; column += 1) {
        if (glyph[row * 5 + column] === "1") fillRect(rgba, cursor + column * scale, y + row * scale, scale, scale, color);
      }
    }
    cursor += 6 * scale;
  }
}

function fillRoundedApprox(
  rgba: Uint8Array,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
  color: readonly [number, number, number, number],
): void {
  fillRect(rgba, x + radius, y, width - radius * 2, height, color);
  fillRect(rgba, x, y + radius, width, height - radius * 2, color);
  for (let dy = 0; dy < radius; dy += 1) {
    for (let dx = 0; dx < radius; dx += 1) {
      if ((dx - radius) ** 2 + (dy - radius) ** 2 <= radius ** 2) {
        setPixel(rgba, x + dx, y + dy, color);
        setPixel(rgba, x + width - dx - 1, y + dy, color);
        setPixel(rgba, x + dx, y + height - dy - 1, color);
        setPixel(rgba, x + width - dx - 1, y + height - dy - 1, color);
      }
    }
  }
}

function fillRect(
  rgba: Uint8Array,
  x: number,
  y: number,
  width: number,
  height: number,
  color: readonly [number, number, number, number],
): void {
  for (let row = Math.max(0, y); row < Math.min(CARD_HEIGHT, y + height); row += 1) {
    for (let column = Math.max(0, x); column < Math.min(CARD_WIDTH, x + width); column += 1) {
      setPixel(rgba, column, row, color);
    }
  }
}

function setPixel(
  rgba: Uint8Array,
  x: number,
  y: number,
  color: readonly [number, number, number, number],
): void {
  const offset = (y * CARD_WIDTH + x) * 4;
  rgba.set(color, offset);
}

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
