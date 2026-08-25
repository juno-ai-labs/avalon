import { describe, expect, it, vi } from 'vitest';
import {
  nativeSystemAudioAddonPath,
  NativeSystemAudioController,
  type NativeSystemAudioBinding,
} from './native-system-audio';

function fixture() {
  let listener: ((data?: Uint8Array, sampleRate?: number) => void) | undefined;
  const binding: NativeSystemAudioBinding = {
    isSupported: vi.fn(() => true),
    start: vi.fn((nextListener) => {
      listener = nextListener;
      return { channels: 1, sampleRate: 48_000 };
    }),
    stop: vi.fn(() => listener?.()),
  };
  const owner = {
    isDestroyed: vi.fn(() => false),
    send: vi.fn(),
  };
  return {
    binding,
    drain: () => listener?.(),
    emit: (data: Uint8Array, sampleRate = 48_000) => listener?.(data, sampleRate),
    owner,
  };
}

describe('native system audio controller', () => {
  it('streams only validated Float32 audio to the owning meeting window', () => {
    const target = fixture();
    const controller = new NativeSystemAudioController(() => target.binding);

    expect(controller.start(target.owner)).toEqual({ channels: 1, sampleRate: 48_000 });
    const audio = new Uint8Array(new Float32Array([0.2, -0.1]).buffer);
    target.emit(audio);
    target.emit(new Uint8Array(3));
    target.emit(audio, 1);

    expect(target.owner.send).toHaveBeenCalledOnce();
    expect(target.owner.send).toHaveBeenCalledWith('meeting-audio:data', audio, 48_000);
  });

  it('allows only one meeting to own the native tap and only that owner to stop it', async () => {
    const target = fixture();
    const other = fixture().owner;
    const controller = new NativeSystemAudioController(() => target.binding);

    controller.start(target.owner);
    expect(() => controller.start(other)).toThrow(/another meeting/i);
    await controller.stop(other);
    expect(target.binding.stop).not.toHaveBeenCalled();
    await controller.stop(target.owner);
    expect(target.binding.stop).toHaveBeenCalledOnce();
  });

  it('does not resolve stop until the native drain marker arrives', async () => {
    const target = fixture();
    target.binding.stop = vi.fn();
    const controller = new NativeSystemAudioController(() => target.binding);
    controller.start(target.owner);
    let stopped = false;

    const stopping = controller.stop(target.owner).then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);
    target.drain();
    await stopping;

    expect(stopped).toBe(true);
  });

  it('cleans up a failed or malformed native start', () => {
    const target = fixture();
    target.binding.start = vi.fn(() => ({ channels: 2, sampleRate: 48_000 }));
    const controller = new NativeSystemAudioController(() => target.binding);

    expect(() => controller.start(target.owner)).toThrow(/invalid stream format/i);
    expect(target.binding.stop).toHaveBeenCalledOnce();
  });

  it('does not deliver native chunks after the meeting window is destroyed', () => {
    const target = fixture();
    const controller = new NativeSystemAudioController(() => target.binding);
    controller.start(target.owner);
    target.owner.isDestroyed.mockReturnValue(true);

    target.emit(new Uint8Array(new Float32Array([0.2]).buffer));
    expect(target.owner.send).not.toHaveBeenCalled();
  });

  it('resolves packaged and development addon paths without user input', () => {
    expect(nativeSystemAudioAddonPath({
      currentDirectory: '/repo/apps/desktop/out/main',
      isPackaged: false,
      resourcesPath: '/Applications/Rally.app/Contents/Resources',
    })).toBe('/repo/apps/desktop/.native-build/system-audio-tap.node');
    expect(nativeSystemAudioAddonPath({
      currentDirectory: '/ignored',
      isPackaged: true,
      resourcesPath: '/Applications/Rally.app/Contents/Resources',
    })).toBe('/Applications/Rally.app/Contents/Resources/native/system-audio-tap.node');
  });
});
