import { createHash } from 'node:crypto';

export interface NormalizedJavascriptError {
  process: 'main' | 'preload' | 'renderer';
  errorCode: 'type_error' | 'range_error' | 'unhandled_rejection' | 'react_boundary' | 'unknown';
  fingerprint: string;
  generatedFrames: string[];
}

const processes = new Set(['main', 'preload', 'renderer']);
const errorCodes = new Set(['type_error', 'range_error', 'unhandled_rejection', 'react_boundary', 'unknown']);
const SAFE_FRAME = /^[a-zA-Z0-9_-][a-zA-Z0-9._/-]{0,159}\.(?:c?js):\d{1,7}:\d{1,5}$/u;

export async function normalizeJavascriptErrorCandidate(value: unknown): Promise<NormalizedJavascriptError> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const candidate = value as Record<string, unknown>;
  const keys = Object.keys(candidate).sort();
  if (keys.join(',') !== 'errorCode,frames,process') throw invalid();
  if (typeof candidate['process'] !== 'string' || !processes.has(candidate['process'])) throw invalid();
  if (typeof candidate['errorCode'] !== 'string' || !errorCodes.has(candidate['errorCode'])) throw invalid();
  if (!Array.isArray(candidate['frames']) || candidate['frames'].length === 0 || candidate['frames'].length > 20) {
    throw invalid();
  }
  const frames = candidate['frames'];
  if (frames.some((frame) => typeof frame !== 'string'
    || !SAFE_FRAME.test(frame)
    || frame.startsWith('/')
    || frame.includes('..')
    || frame.includes('?')
    || frame.includes('#'))) throw invalid();
  return {
    process: candidate['process'] as NormalizedJavascriptError['process'],
    errorCode: candidate['errorCode'] as NormalizedJavascriptError['errorCode'],
    fingerprint: createHash('sha256')
      .update(`${candidate['process']}\0${candidate['errorCode']}\0${frames.join('\n')}`)
      .digest('hex'),
    generatedFrames: [...frames],
  };
}

function invalid(): Error {
  return new Error('Invalid JavaScript error candidate');
}
