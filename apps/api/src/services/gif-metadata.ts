const MAX_STORYBOARD_FRAMES = 6;

export interface GifModelMetadata {
  kind: "animated_gif";
  width: number;
  height: number;
  frameCount: number;
  durationMs: number;
  averageFps: number;
  loopCount: number | null;
  sampledTimestampsMs: number[];
}

export function parseGifModelMetadata(value: string | null | undefined): GifModelMetadata | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<GifModelMetadata>;
    if (parsed.kind !== "animated_gif"
      || !isPositiveInteger(parsed.width)
      || !isPositiveInteger(parsed.height)
      || !isPositiveInteger(parsed.frameCount)
      || !isNonNegativeInteger(parsed.durationMs)
      || typeof parsed.averageFps !== "number"
      || !Number.isFinite(parsed.averageFps)
      || parsed.averageFps < 0
      || !(parsed.loopCount === null || isNonNegativeInteger(parsed.loopCount))
      || !Array.isArray(parsed.sampledTimestampsMs)
      || parsed.sampledTimestampsMs.length === 0
      || parsed.sampledTimestampsMs.length > MAX_STORYBOARD_FRAMES
      || !parsed.sampledTimestampsMs.every(isNonNegativeInteger)) return null;
    return parsed as GifModelMetadata;
  } catch {
    return null;
  }
}

export function describeGifModelMetadata(fileName: string, metadata: GifModelMetadata): string {
  const loop = metadata.loopCount === 0 ? "loops indefinitely"
    : metadata.loopCount === null ? "loop behavior is unspecified"
      : `loops ${metadata.loopCount} ${metadata.loopCount === 1 ? "time" : "times"}`;
  const timestamps = metadata.sampledTimestampsMs.map(formatTimestamp).join(", ");
  return `[${fileName}: animated GIF; ${formatDuration(metadata.durationMs)}; ${metadata.frameCount} frames; approximately ${formatFps(metadata.averageFps)} fps; ${metadata.width}x${metadata.height}; ${loop}. The storyboard cells are ordered left-to-right, top-to-bottom at timestamps ${timestamps}.]`;
}

function formatFps(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0+$/u, "").replace(/\.$/u, "");
}

function formatTimestamp(milliseconds: number): string {
  const totalSeconds = milliseconds / 1_000;
  if (totalSeconds < 60) return `${totalSeconds.toFixed(1)}s`;
  const minutes = Math.floor(totalSeconds / 60);
  return `${minutes}m${Math.floor(totalSeconds % 60).toString().padStart(2, "0")}s`;
}

function formatDuration(milliseconds: number): string {
  return `duration ${formatTimestamp(milliseconds)}`;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
