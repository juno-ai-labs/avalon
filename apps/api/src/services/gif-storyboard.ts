import { decompressFrame, decompressFrames, parseGIF } from "gifuct-js";
import UPNG from "upng-js";
import type { GifModelMetadata } from "./gif-metadata";

const MAX_GIF_FRAMES = 500;
const MAX_GIF_CANVAS_PIXELS = 4_000_000;
const MAX_GIF_DECODED_PATCH_PIXELS = 40_000_000;
const MAX_STORYBOARD_FRAMES = 6;
const TILE_WIDTH = 480;
const TILE_HEIGHT = 360;
const LABEL_HEIGHT = 28;
const STORYBOARD_PADDING = 16;
const STORYBOARD_COLUMNS = 3;

export interface GifStoryboard {
  bytes: Uint8Array;
  metadata: GifModelMetadata;
}

export function buildGifStoryboard(bytes: Uint8Array): GifStoryboard | null {
  const parsed = parseGIF(exactArrayBuffer(bytes));
  const frameMetadata = decompressFrames(parsed, false);
  if (frameMetadata.length === 0 || frameMetadata.length > MAX_GIF_FRAMES) return null;

  const width = parsed.lsd.width;
  const height = parsed.lsd.height;
  assertSafeDimensions(width, height);
  const decodedPatchPixels = frameMetadata.reduce((sum, frame) => sum + frame.dims.width * frame.dims.height, 0);
  if (!Number.isSafeInteger(decodedPatchPixels) || decodedPatchPixels > MAX_GIF_DECODED_PATCH_PIXELS) return null;

  const delays = frameMetadata.map((frame) => boundedDelay(frame.delay));
  const durationMs = delays.reduce((sum, delay) => sum + delay, 0);
  const samples = chooseSamples(delays, durationMs);
  const sampleByFrame = new Map(samples.map((sample) => [sample.frameIndex, sample.timestampMs]));
  const renderedSamples: Array<{ rgba: Uint8ClampedArray; timestampMs: number }> = [];
  const canvas = new Uint8ClampedArray(width * height * 4);
  let previousDisposal = 0;
  let previousDims: { left: number; top: number; width: number; height: number } | null = null;
  let previousRestore: Uint8ClampedArray | null = null;
  let imageFrameIndex = 0;

  for (const frame of parsed.frames) {
    if (!("image" in frame)) continue;
    if (previousDisposal === 2 && previousDims) clearRect(canvas, width, height, previousDims);
    else if (previousDisposal === 3 && previousRestore) canvas.set(previousRestore);

    const decoded = decompressFrame(frame, parsed.gct, true);
    const restore = decoded.disposalType === 3 ? canvas.slice() : null;
    overlayPatch(canvas, width, height, decoded.dims, decoded.patch);
    const timestampMs = sampleByFrame.get(imageFrameIndex);
    if (timestampMs !== undefined) {
      renderedSamples.push({ rgba: resizeContained(canvas, width, height), timestampMs });
    }
    previousDisposal = decoded.disposalType ?? 0;
    previousDims = decoded.dims;
    previousRestore = restore;
    imageFrameIndex += 1;
  }

  if (renderedSamples.length === 0) return null;
  const storyboard = composeStoryboard(renderedSamples);
  return {
    bytes: new Uint8Array(UPNG.encode([exactArrayBuffer(storyboard.rgba)], storyboard.width, storyboard.height, 0)),
    metadata: {
      kind: "animated_gif",
      width,
      height,
      frameCount: frameMetadata.length,
      durationMs,
      averageFps: durationMs > 0 ? roundTo(frameMetadata.length * 1_000 / durationMs, 2) : 0,
      loopCount: readLoopCount(bytes),
      sampledTimestampsMs: renderedSamples.map((sample) => sample.timestampMs),
    },
  };
}

function roundTo(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function chooseSamples(delays: number[], durationMs: number): Array<{ frameIndex: number; timestampMs: number }> {
  const count = Math.min(MAX_STORYBOARD_FRAMES, delays.length);
  if (delays.length <= MAX_STORYBOARD_FRAMES) {
    let timestampMs = 0;
    return delays.map((delay, frameIndex) => {
      const sample = { frameIndex, timestampMs };
      timestampMs += delay;
      return sample;
    });
  }
  const targets = count === 1
    ? [0]
    : Array.from({ length: count }, (_, index) => Math.round((Math.max(0, durationMs - 1) * index) / (count - 1)));
  const selected = new Map<number, number>();
  let frameStart = 0;
  let targetIndex = 0;
  for (let frameIndex = 0; frameIndex < delays.length && targetIndex < targets.length; frameIndex += 1) {
    const frameEnd = frameStart + (delays[frameIndex] ?? 0);
    while (targetIndex < targets.length && (targets[targetIndex] ?? 0) < frameEnd) {
      selected.set(frameIndex, frameStart);
      targetIndex += 1;
    }
    frameStart = frameEnd;
  }
  if (selected.size === 0) selected.set(0, 0);
  return [...selected.entries()].map(([frameIndex, timestampMs]) => ({ frameIndex, timestampMs }));
}

function composeStoryboard(samples: Array<{ rgba: Uint8ClampedArray; timestampMs: number }>): {
  rgba: Uint8ClampedArray;
  width: number;
  height: number;
} {
  const columns = Math.min(STORYBOARD_COLUMNS, samples.length);
  const rows = Math.ceil(samples.length / columns);
  const width = STORYBOARD_PADDING + columns * (TILE_WIDTH + STORYBOARD_PADDING);
  const height = STORYBOARD_PADDING + rows * (TILE_HEIGHT + LABEL_HEIGHT + STORYBOARD_PADDING);
  const rgba = new Uint8ClampedArray(width * height * 4);
  fill(rgba, 246, 246, 244, 255);
  samples.forEach((sample, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const left = STORYBOARD_PADDING + column * (TILE_WIDTH + STORYBOARD_PADDING);
    const top = STORYBOARD_PADDING + row * (TILE_HEIGHT + LABEL_HEIGHT + STORYBOARD_PADDING);
    blit(rgba, width, sample.rgba, TILE_WIDTH, TILE_HEIGHT, left, top);
    drawLabel(rgba, width, left + 8, top + TILE_HEIGHT + 7, formatTimestamp(sample.timestampMs));
  });
  return { rgba, width, height };
}

function resizeContained(source: Uint8ClampedArray, sourceWidth: number, sourceHeight: number): Uint8ClampedArray {
  const target = new Uint8ClampedArray(TILE_WIDTH * TILE_HEIGHT * 4);
  fill(target, 255, 255, 255, 255);
  const scale = Math.min(1, TILE_WIDTH / sourceWidth, TILE_HEIGHT / sourceHeight);
  const width = Math.max(1, Math.round(sourceWidth * scale));
  const height = Math.max(1, Math.round(sourceHeight * scale));
  const left = Math.floor((TILE_WIDTH - width) / 2);
  const top = Math.floor((TILE_HEIGHT - height) / 2);
  for (let y = 0; y < height; y += 1) {
    const sourceY = Math.min(sourceHeight - 1, Math.floor(y / scale));
    for (let x = 0; x < width; x += 1) {
      const sourceX = Math.min(sourceWidth - 1, Math.floor(x / scale));
      const sourceOffset = (sourceY * sourceWidth + sourceX) * 4;
      const targetOffset = ((top + y) * TILE_WIDTH + left + x) * 4;
      const alpha = source[sourceOffset + 3] ?? 0;
      const inverse = 255 - alpha;
      target[targetOffset] = Math.round(((source[sourceOffset] ?? 0) * alpha + 255 * inverse) / 255);
      target[targetOffset + 1] = Math.round(((source[sourceOffset + 1] ?? 0) * alpha + 255 * inverse) / 255);
      target[targetOffset + 2] = Math.round(((source[sourceOffset + 2] ?? 0) * alpha + 255 * inverse) / 255);
      target[targetOffset + 3] = 255;
    }
  }
  return target;
}

function overlayPatch(
  canvas: Uint8ClampedArray,
  canvasWidth: number,
  canvasHeight: number,
  dims: { left: number; top: number; width: number; height: number },
  patch: Uint8ClampedArray,
): void {
  for (let y = 0; y < dims.height; y += 1) {
    const targetY = dims.top + y;
    if (targetY < 0 || targetY >= canvasHeight) continue;
    for (let x = 0; x < dims.width; x += 1) {
      const targetX = dims.left + x;
      if (targetX < 0 || targetX >= canvasWidth) continue;
      const patchOffset = (y * dims.width + x) * 4;
      if ((patch[patchOffset + 3] ?? 0) === 0) continue;
      const targetOffset = (targetY * canvasWidth + targetX) * 4;
      canvas[targetOffset] = patch[patchOffset] ?? 0;
      canvas[targetOffset + 1] = patch[patchOffset + 1] ?? 0;
      canvas[targetOffset + 2] = patch[patchOffset + 2] ?? 0;
      canvas[targetOffset + 3] = patch[patchOffset + 3] ?? 255;
    }
  }
}

function clearRect(
  canvas: Uint8ClampedArray,
  canvasWidth: number,
  canvasHeight: number,
  dims: { left: number; top: number; width: number; height: number },
): void {
  for (let y = Math.max(0, dims.top); y < Math.min(canvasHeight, dims.top + dims.height); y += 1) {
    const start = (y * canvasWidth + Math.max(0, dims.left)) * 4;
    const end = (y * canvasWidth + Math.min(canvasWidth, dims.left + dims.width)) * 4;
    canvas.fill(0, start, end);
  }
}

function blit(
  target: Uint8ClampedArray,
  targetWidth: number,
  source: Uint8ClampedArray,
  sourceWidth: number,
  sourceHeight: number,
  left: number,
  top: number,
): void {
  for (let y = 0; y < sourceHeight; y += 1) {
    const sourceStart = y * sourceWidth * 4;
    target.set(source.subarray(sourceStart, sourceStart + sourceWidth * 4), ((top + y) * targetWidth + left) * 4);
  }
}

const FONT: Record<string, string[]> = {
  "0": ["111", "101", "101", "101", "111"], "1": ["010", "110", "010", "010", "111"],
  "2": ["111", "001", "111", "100", "111"], "3": ["111", "001", "111", "001", "111"],
  "4": ["101", "101", "111", "001", "001"], "5": ["111", "100", "111", "001", "111"],
  "6": ["111", "100", "111", "101", "111"], "7": ["111", "001", "001", "001", "001"],
  "8": ["111", "101", "111", "101", "111"], "9": ["111", "101", "111", "001", "111"],
  ".": ["000", "000", "000", "000", "010"], ":": ["000", "010", "000", "010", "000"],
  "s": ["011", "100", "111", "001", "110"], "m": ["000", "110", "111", "101", "101"],
  "h": ["100", "100", "111", "101", "101"],
};

function drawLabel(target: Uint8ClampedArray, targetWidth: number, left: number, top: number, text: string): void {
  const scale = 3;
  let cursor = left;
  for (const character of text) {
    const glyph = FONT[character];
    if (!glyph) continue;
    glyph.forEach((row, y) => [...row].forEach((pixel, x) => {
      if (pixel !== "1") return;
      for (let dy = 0; dy < scale; dy += 1) for (let dx = 0; dx < scale; dx += 1) {
        const offset = ((top + y * scale + dy) * targetWidth + cursor + x * scale + dx) * 4;
        target[offset] = 40;
        target[offset + 1] = 40;
        target[offset + 2] = 40;
        target[offset + 3] = 255;
      }
    }));
    cursor += 4 * scale;
  }
}

function readLoopCount(bytes: Uint8Array): number | null {
  for (const marker of ["NETSCAPE2.0", "ANIMEXTS1.0"]) {
    const encoded = new TextEncoder().encode(marker);
    outer: for (let index = 0; index <= bytes.length - encoded.length; index += 1) {
      for (let offset = 0; offset < encoded.length; offset += 1) {
        if (bytes[index + offset] !== encoded[offset]) continue outer;
      }
      const block = index + encoded.length;
      if (bytes[block] === 3 && bytes[block + 1] === 1) return (bytes[block + 2] ?? 0) | ((bytes[block + 3] ?? 0) << 8);
    }
  }
  return null;
}

function boundedDelay(value: number | undefined): number {
  return Number.isFinite(value) && (value ?? 0) > 0 ? Math.min(60_000, Math.round(value ?? 100)) : 100;
}

function formatTimestamp(milliseconds: number): string {
  const totalSeconds = milliseconds / 1_000;
  if (totalSeconds < 60) return `${totalSeconds.toFixed(1)}s`;
  const minutes = Math.floor(totalSeconds / 60);
  return `${minutes}m${Math.floor(totalSeconds % 60).toString().padStart(2, "0")}s`;
}

function assertSafeDimensions(width: number, height: number): void {
  if (!isPositiveInteger(width) || !isPositiveInteger(height) || width * height > MAX_GIF_CANVAS_PIXELS) {
    throw new Error("GIF dimensions exceed the safe storyboard limit");
  }
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function fill(target: Uint8ClampedArray, red: number, green: number, blue: number, alpha: number): void {
  for (let index = 0; index < target.length; index += 4) {
    target[index] = red;
    target[index + 1] = green;
    target[index + 2] = blue;
    target[index + 3] = alpha;
  }
}

function exactArrayBuffer(bytes: Uint8Array | Uint8ClampedArray): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
