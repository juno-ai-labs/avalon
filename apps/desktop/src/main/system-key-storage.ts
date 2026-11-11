import type { SessionSafeStorage } from './session-encryption';

/** Linux's basic_text fallback is not an operating-system keystore. */
export function systemKeyStorage(
  platform: NodeJS.Platform,
  storage: SessionSafeStorage & { getSelectedStorageBackend(): string },
): SessionSafeStorage {
  const available = (): boolean => storage.isEncryptionAvailable()
    && (platform !== 'linux' || ['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6'].includes(storage.getSelectedStorageBackend()));
  return {
    isEncryptionAvailable: available,
    encryptString(value) {
      if (!available()) throw new Error('Lockdown mode requires an available operating-system keystore');
      return storage.encryptString(value);
    },
    decryptString(value) {
      if (!available()) throw new Error('Lockdown mode requires an available operating-system keystore');
      return storage.decryptString(value);
    },
  };
}
