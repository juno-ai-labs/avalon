import { describe, expect, it, vi } from 'vitest';
import {
  decryptSessionValue,
  encryptSessionValue,
  migrateStoredSessionEncryption,
  type SessionSafeStorage,
} from './session-encryption';

function fakeSafeStorage(available = true): SessionSafeStorage {
  return {
    isEncryptionAvailable: () => available,
    encryptString: vi.fn((value: string) => Buffer.from(`keystore:${value}`, 'utf8')),
    decryptString: vi.fn((value: Buffer) => {
      const encoded = value.toString('utf8');
      if (!encoded.startsWith('keystore:')) throw new Error('Invalid keystore value');
      return encoded.slice('keystore:'.length);
    }),
  };
}

describe('desktop session encryption', () => {
  it('round-trips global-key values without using the operating-system keystore', () => {
    const safeStorage = fakeSafeStorage(false);
    const first = encryptSessionValue('durable session', 'global', safeStorage);
    const second = encryptSessionValue('durable session', 'global', safeStorage);

    expect(first).not.toEqual(second);
    expect(decryptSessionValue(first, safeStorage)).toEqual({
      plaintext: 'durable session',
      mode: 'global',
      legacy: false,
    });
  });

  // These fixtures were sealed independently with a test-only key and fixed IVs.
  it.each([
    {
      plaintext: 'Rally session fixture',
      envelope: 'cmFsbHktc2Vzc2lvbi9nbG9iYWwvdjEAAQEBAQEBAQEBAQEBkg910r3Xeo8N8U7SXlRrUyYdaqFRvrxWS/hWcmSf49mQivCEpg==',
    },
    {
      plaintext: 'Avalon session fixture',
      envelope: 'YXZhbG9uLXNlc3Npb24vZ2xvYmFsL3YxAAICAgICAgICAgICAokOieT8orDk0GZZnyVP1x+P+aO30B2QT+B+PrJliSHgkV5WzOkg',
    },
  ])('decrypts the $plaintext using an injected key', async ({ plaintext, envelope }) => {
    vi.stubGlobal('__RALLY_DESKTOP_SESSION_KEY__', Buffer.alloc(32, 0x25).toString('base64'));
    vi.resetModules();
    const { decryptSessionValue: decryptWithInjectedKey } = await import('./session-encryption');

    expect(decryptWithInjectedKey(Buffer.from(envelope, 'base64'), fakeSafeStorage(false))).toEqual({
      plaintext,
      mode: 'global',
      legacy: false,
    });
  });

  it('wraps lockdown values with safeStorage and recognizes pre-setting values', () => {
    const safeStorage = fakeSafeStorage();
    const encrypted = encryptSessionValue('private session', 'lockdown', safeStorage);

    expect(decryptSessionValue(encrypted, safeStorage)).toEqual({
      plaintext: 'private session',
      mode: 'lockdown',
      legacy: false,
    });
    expect(decryptSessionValue(Buffer.from('keystore:legacy session'), safeStorage)).toEqual({
      plaintext: 'legacy session',
      mode: 'lockdown',
      legacy: true,
    });
  });

  it('rejects lockdown encryption when no keystore is available', () => {
    const safeStorage = fakeSafeStorage(false);
    expect(() => encryptSessionValue('private session', 'lockdown', safeStorage))
      .toThrow('Lockdown mode requires an available operating-system keystore');
  });

  it('migrates every stored value back and forth without changing its plaintext', async () => {
    const safeStorage = fakeSafeStorage();
    const stored = [
      { bytes: Buffer.from('keystore:auth') },
      { bytes: Buffer.from('keystore:profile') },
    ];
    const values = stored.map((entry) => ({
      read: async () => entry.bytes,
      write: async (value: Uint8Array) => {
        entry.bytes = Buffer.from(value);
      },
    }));

    await migrateStoredSessionEncryption(values, 'global', safeStorage);
    expect(stored.map((entry) => decryptSessionValue(entry.bytes, safeStorage)))
      .toEqual([
        { plaintext: 'auth', mode: 'global', legacy: false },
        { plaintext: 'profile', mode: 'global', legacy: false },
      ]);

    await migrateStoredSessionEncryption(values, 'lockdown', safeStorage);
    expect(stored.map((entry) => decryptSessionValue(entry.bytes, safeStorage)))
      .toEqual([
        { plaintext: 'auth', mode: 'lockdown', legacy: false },
        { plaintext: 'profile', mode: 'lockdown', legacy: false },
      ]);
  });

  it('skips missing session files during a migration', async () => {
    const missing = Object.assign(new Error('missing'), { code: 'ENOENT' });
    await expect(migrateStoredSessionEncryption([{
      read: async () => { throw missing; },
      write: vi.fn(),
    }], 'global', fakeSafeStorage())).resolves.toBeUndefined();
  });
});
