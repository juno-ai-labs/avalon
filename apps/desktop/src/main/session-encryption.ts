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
  credentialBearing?: boolean;
  read: () => Promise<Uint8Array>;
  write: (value: Uint8Array) => Promise<void>;
}

export class LockdownDowngradeRequiresReloginError extends Error {
  constructor() {
    super('A Lockdown session cannot be downgraded outside the application');
    this.name = 'LockdownDowngradeRequiresReloginError';
  }
}

/**
 * The envelope headers this build mints, and the ones it still reads.
 *
 * The global header is also the AES-GCM additional authenticated data, so a
 * value written before the rename from Avalon only decrypts under the header it
 * was sealed with — the superseded spelling cannot be normalized on read, it has
 * to be carried. Nothing rewrites these in place: every session write re-seals
 * under the current header, so stored values converge as people use the app
 * rather than in a migration pass that could fail with a credential half-moved.
 */
const GLOBAL_ENVELOPE_HEADER = Buffer.from('rally-session/global/v1\0', 'utf8');
const LOCKDOWN_ENVELOPE_HEADER = Buffer.from('rally-session/lockdown/v1\0', 'utf8');
const SUPERSEDED_GLOBAL_ENVELOPE_HEADERS: readonly Buffer[] = Object.freeze([
  Buffer.from('avalon-session/global/v1\0', 'utf8'),
]);
const SUPERSEDED_LOCKDOWN_ENVELOPE_HEADERS: readonly Buffer[] = Object.freeze([
  Buffer.from('avalon-session/lockdown/v1\0', 'utf8'),
]);
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

/** The global header a stored value was sealed with, current or superseded. */
function globalEnvelopeHeader(value: Buffer): Buffer | undefined {
  return [GLOBAL_ENVELOPE_HEADER, ...SUPERSEDED_GLOBAL_ENVELOPE_HEADERS]
    .find((header) => startsWith(value, header));
}

/** The lockdown header a stored value was sealed with, current or superseded. */
function lockdownEnvelopeHeader(value: Buffer): Buffer | undefined {
  return [LOCKDOWN_ENVELOPE_HEADER, ...SUPERSEDED_LOCKDOWN_ENVELOPE_HEADERS]
    .find((header) => startsWith(value, header));
}

function decryptWithGlobalKey(value: Buffer, header: Buffer): string {
  const payloadOffset = header.length;
  const authTagOffset = payloadOffset + GLOBAL_IV_BYTES;
  const ciphertextOffset = authTagOffset + GLOBAL_AUTH_TAG_BYTES;
  if (value.length < ciphertextOffset) throw new Error('The stored global session envelope is incomplete');
  const decipher = createDecipheriv(
    'aes-256-gcm',
    GLOBAL_SESSION_KEY,
    value.subarray(payloadOffset, authTagOffset),
  );
  decipher.setAAD(header);
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
  const globalHeader = globalEnvelopeHeader(value);
  if (globalHeader) {
    return {
      plaintext: decryptWithGlobalKey(value, globalHeader),
      mode: 'global',
      legacy: false,
    };
  }
  if (!safeStorage.isEncryptionAvailable()) throw encryptionUnavailable();
  const lockdownHeader = lockdownEnvelopeHeader(value);
  if (lockdownHeader) {
    return {
      plaintext: safeStorage.decryptString(value.subarray(lockdownHeader.length)),
      mode: 'lockdown',
      legacy: false,
    };
  }
  // Releases before Lockdown mode stored the raw safeStorage result without
  // any envelope. Treat it as device-bound so upgrades can migrate it.
  return {
    plaintext: safeStorage.decryptString(value),
    mode: 'lockdown',
    legacy: true,
  };
}

export function storedSessionEncryptionMetadata(
  encryptedValue: Uint8Array,
): Pick<EncryptedSessionValue, 'mode' | 'legacy'> {
  const value = Buffer.from(encryptedValue);
  if (globalEnvelopeHeader(value)) return { mode: 'global', legacy: false };
  if (lockdownEnvelopeHeader(value)) return { mode: 'lockdown', legacy: false };
  return { mode: 'lockdown', legacy: true };
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error ? String(error.code) : undefined;
}

export async function migrateStoredSessionEncryption(
  values: readonly StoredEncryptedValue[],
  targetMode: SessionEncryptionMode,
  safeStorage: SessionSafeStorage,
  options: { allowLockdownToGlobal?: boolean } = {},
): Promise<void> {
  for (const value of values) {
    let encrypted: Uint8Array;
    try {
      encrypted = await value.read();
    } catch (error) {
      if (errorCode(error) === 'ENOENT') continue;
      throw error;
    }
    const metadata = storedSessionEncryptionMetadata(encrypted);
    if (
      targetMode === 'global'
      && metadata.mode === 'lockdown'
      && !metadata.legacy
      && value.credentialBearing !== false
      && options.allowLockdownToGlobal === false
    ) {
      throw new LockdownDowngradeRequiresReloginError();
    }
    const decrypted = decryptSessionValue(encrypted, safeStorage);
    if (decrypted.mode === targetMode && !decrypted.legacy) continue;
    await value.write(encryptSessionValue(decrypted.plaintext, targetMode, safeStorage));
  }
}
