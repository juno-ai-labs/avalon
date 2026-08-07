import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from 'node:crypto';

export type SessionEncryptionMode = 'global' | 'lockdown';

export interface SessionSafeStorage {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}

export interface EncryptedSessionValue {
  plaintext: string;
  mode: SessionEncryptionMode;
  legacy: boolean;
}

export interface StoredEncryptedValue {
  read: () => Promise<Uint8Array>;
  write: (value: Uint8Array) => Promise<void>;
}

const GLOBAL_ENVELOPE_HEADER = Buffer.from('avalon-session/global/v1\0', 'utf8');
const LOCKDOWN_ENVELOPE_HEADER = Buffer.from('avalon-session/lockdown/v1\0', 'utf8');
const GLOBAL_SESSION_KEY = Buffer.from('LqOwpiqP2oXJ/YMaSMg20IKP4wxNKnxvtXeQegxogOw=', 'base64');
const GLOBAL_IV_BYTES = 12;
const GLOBAL_AUTH_TAG_BYTES = 16;

function startsWith(value: Buffer, prefix: Buffer): boolean {
  return value.length >= prefix.length && value.subarray(0, prefix.length).equals(prefix);
}

function encryptionUnavailable(): Error {
  return new Error('Lockdown mode requires an available operating-system keystore');
}

function encryptWithGlobalKey(plaintext: string): Buffer {
  const iv = randomBytes(GLOBAL_IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', GLOBAL_SESSION_KEY, iv);
  cipher.setAAD(GLOBAL_ENVELOPE_HEADER);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([
    GLOBAL_ENVELOPE_HEADER,
    iv,
    cipher.getAuthTag(),
    ciphertext,
  ]);
}

function decryptWithGlobalKey(value: Buffer): string {
  const payloadOffset = GLOBAL_ENVELOPE_HEADER.length;
  const authTagOffset = payloadOffset + GLOBAL_IV_BYTES;
  const ciphertextOffset = authTagOffset + GLOBAL_AUTH_TAG_BYTES;
  if (value.length < ciphertextOffset) throw new Error('The stored global session envelope is incomplete');
  const decipher = createDecipheriv(
    'aes-256-gcm',
    GLOBAL_SESSION_KEY,
    value.subarray(payloadOffset, authTagOffset),
  );
  decipher.setAAD(GLOBAL_ENVELOPE_HEADER);
  decipher.setAuthTag(value.subarray(authTagOffset, ciphertextOffset));
  return Buffer.concat([
    decipher.update(value.subarray(ciphertextOffset)),
    decipher.final(),
  ]).toString('utf8');
}

export function encryptSessionValue(
  plaintext: string,
  mode: SessionEncryptionMode,
  safeStorage: SessionSafeStorage,
): Buffer {
  if (mode === 'global') return encryptWithGlobalKey(plaintext);
  if (!safeStorage.isEncryptionAvailable()) throw encryptionUnavailable();
  return Buffer.concat([
    LOCKDOWN_ENVELOPE_HEADER,
    safeStorage.encryptString(plaintext),
  ]);
}

export function decryptSessionValue(
  encryptedValue: Uint8Array,
  safeStorage: SessionSafeStorage,
): EncryptedSessionValue {
  const value = Buffer.from(encryptedValue);
  if (startsWith(value, GLOBAL_ENVELOPE_HEADER)) {
    return {
      plaintext: decryptWithGlobalKey(value),
      mode: 'global',
      legacy: false,
    };
  }
  if (!safeStorage.isEncryptionAvailable()) throw encryptionUnavailable();
  if (startsWith(value, LOCKDOWN_ENVELOPE_HEADER)) {
    return {
      plaintext: safeStorage.decryptString(value.subarray(LOCKDOWN_ENVELOPE_HEADER.length)),
      mode: 'lockdown',
      legacy: false,
    };
  }
  // Releases before Lockdown mode stored the raw safeStorage result without
  // an Avalon envelope. Treat it as device-bound so upgrades can migrate it.
  return {
    plaintext: safeStorage.decryptString(value),
    mode: 'lockdown',
    legacy: true,
  };
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error ? String(error.code) : undefined;
}

export async function migrateStoredSessionEncryption(
  values: readonly StoredEncryptedValue[],
  targetMode: SessionEncryptionMode,
  safeStorage: SessionSafeStorage,
): Promise<void> {
  for (const value of values) {
    let encrypted: Uint8Array;
    try {
      encrypted = await value.read();
    } catch (error) {
      if (errorCode(error) === 'ENOENT') continue;
      throw error;
    }
    const decrypted = decryptSessionValue(encrypted, safeStorage);
    if (decrypted.mode === targetMode && !decrypted.legacy) continue;
    await value.write(encryptSessionValue(decrypted.plaintext, targetMode, safeStorage));
  }
}
