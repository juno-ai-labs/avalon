import { TraceMap, originalPositionFor } from '@jridgewell/trace-mapping';

interface JavascriptSymbolicationInput {
  release: string;
  buildId: string;
  process: 'main' | 'preload' | 'renderer';
  generatedFrames: string[];
}

const FRAME = /^(?<bundle>[a-zA-Z0-9_-][a-zA-Z0-9._/-]{0,159}\.c?js):(?<line>\d{1,7}):(?<column>\d{1,5})$/u;
const SAFE_ARTIFACT_PART = /^[a-zA-Z0-9._-]{1,160}$/u;
const MAX_SOURCE_MAP_BYTES = 16 * 1024 * 1024;

/**
 * Resolves already-sanitized generated frames with a private artifact from the
 * current regional R2 bucket. Only a source basename and coordinates leave
 * this boundary; source contents, function names, and source paths never do.
 */
export async function symbolicateJavascriptFrames(
  bucket: R2Bucket,
  input: JavascriptSymbolicationInput,
): Promise<string[]> {
  if (!SAFE_ARTIFACT_PART.test(input.release) || !SAFE_ARTIFACT_PART.test(input.buildId)) {
    return [...input.generatedFrames];
  }
  const maps = new Map<string, TraceMap | null>();
  const result: string[] = [];
  for (const generatedFrame of input.generatedFrames.slice(0, 20)) {
    const match = FRAME.exec(generatedFrame);
    if (!match?.groups) {
      result.push(generatedFrame);
      continue;
    }
    const bundle = match.groups['bundle']!;
    const bundleName = bundle.replaceAll('\\', '/').split('/').at(-1)!;
    let trace = maps.get(bundleName);
    if (trace === undefined) {
      trace = await loadTraceMap(bucket, input, bundleName);
      maps.set(bundleName, trace);
    }
    if (!trace) {
      result.push(generatedFrame);
      continue;
    }
    const line = Number(match.groups['line']);
    const column = Number(match.groups['column']);
    const original = originalPositionFor(trace, { line, column: Math.max(0, column - 1) });
    if (!original.source || original.line === null || original.column === null) {
      result.push(generatedFrame);
      continue;
    }
    const source = original.source.replaceAll('\\', '/').split('/').at(-1) ?? bundleName;
    const safeSource = source.replace(/[^a-zA-Z0-9._-]/gu, '_').slice(0, 160) || 'application.js';
    result.push(`${safeSource}:${original.line}:${original.column + 1}`);
  }
  return result;
}

async function loadTraceMap(
  bucket: R2Bucket,
  input: JavascriptSymbolicationInput,
  bundleName: string,
): Promise<TraceMap | null> {
  const key = [
    'telemetry/javascript-symbols',
    input.release,
    input.buildId,
    input.process,
    `${bundleName}.map`,
  ].join('/');
  try {
    const object = await bucket.get(key);
    if (!object || ('size' in object && object.size > MAX_SOURCE_MAP_BYTES)) return null;
    const text = await object.text();
    if (new TextEncoder().encode(text).byteLength > MAX_SOURCE_MAP_BYTES) return null;
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return new TraceMap(parsed as ConstructorParameters<typeof TraceMap>[0]);
  } catch {
    return null;
  }
}
