import { join, resolve } from 'node:path';

export interface NativeSystemAudioCaptureInfo {
  channels: number;
  sampleRate: number;
}

export interface NativeSystemAudioBinding {
  isSupported: () => boolean;
  start: (
    listener: (data?: Uint8Array, sampleRate?: number) => void,
  ) => NativeSystemAudioCaptureInfo;
  stop: () => void;
}

export interface SystemAudioCaptureOwner {
  isDestroyed: () => boolean;
  send: (channel: string, data: Uint8Array, sampleRate: number) => void;
}

export function nativeSystemAudioAddonPath(input: {
  currentDirectory: string;
  isPackaged: boolean;
  resourcesPath: string;
}): string {
  return input.isPackaged
    ? join(input.resourcesPath, 'native', 'system-audio-tap.node')
    : resolve(input.currentDirectory, '../../.native-build/system-audio-tap.node');
}

function validCaptureInfo(value: NativeSystemAudioCaptureInfo): boolean {
  return value.channels === 1
    && Number.isFinite(value.sampleRate)
    && value.sampleRate >= 8_000
    && value.sampleRate <= 384_000;
}

function validAudioChunk(data: Uint8Array, sampleRate: number): boolean {
  return data.byteLength > 0
    && data.byteLength <= 4 * 384_000
    && data.byteLength % Float32Array.BYTES_PER_ELEMENT === 0
    && Number.isFinite(sampleRate)
    && sampleRate >= 8_000
    && sampleRate <= 384_000;
}

export class NativeSystemAudioController {
  private binding: NativeSystemAudioBinding | undefined;
  private captureInfo: NativeSystemAudioCaptureInfo | undefined;
  private owner: SystemAudioCaptureOwner | undefined;
  private resolveStop: (() => void) | undefined;
  private stopPromise: Promise<void> | undefined;

  constructor(private readonly loadBinding: () => NativeSystemAudioBinding) {}

  start(owner: SystemAudioCaptureOwner): NativeSystemAudioCaptureInfo {
    if (this.owner === owner && this.captureInfo) return this.captureInfo;
    if (this.owner) throw new Error('Another meeting is already recording computer audio.');

    const binding = this.loadBinding();
    if (!binding.isSupported()) {
      throw new Error('Computer audio recording requires macOS 14.2 or later.');
    }
    this.binding = binding;
    this.owner = owner;
    try {
      const info = binding.start((data, sampleRate) => {
        if (data === undefined || sampleRate === undefined) {
          this.resolveStop?.();
          return;
        }
        if (this.owner !== owner || owner.isDestroyed() || !validAudioChunk(data, sampleRate)) return;
        owner.send('transcription-audio:data', data, sampleRate);
      });
      if (!validCaptureInfo(info)) {
        throw new Error('The native computer audio tap returned an invalid stream format.');
      }
      this.captureInfo = info;
      return info;
    } catch (error) {
      try { binding.stop(); } catch { /* Preserve the start failure. */ }
      this.binding = undefined;
      this.captureInfo = undefined;
      this.owner = undefined;
      throw error;
    }
  }

  async stop(owner?: SystemAudioCaptureOwner): Promise<void> {
    if (!this.owner || (owner !== undefined && this.owner !== owner)) return;
    if (this.stopPromise) return this.stopPromise;
    const binding = this.binding;
    if (!binding) return;
    this.stopPromise = new Promise<void>((resolve, reject) => {
      this.resolveStop = resolve;
      try {
        binding.stop();
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    }).finally(() => {
      this.binding = undefined;
      this.captureInfo = undefined;
      this.owner = undefined;
      this.resolveStop = undefined;
      this.stopPromise = undefined;
    });
    return this.stopPromise;
  }
}
