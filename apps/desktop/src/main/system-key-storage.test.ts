import { describe, expect, it, vi } from 'vitest';
import { systemKeyStorage } from './system-key-storage';

describe('Linux system keystore', () => {
  it.each(['basic_text', 'unknown'])('refuses %s even when Electron reports encryption available', (backend) => {
    const storage = systemKeyStorage('linux', {
      isEncryptionAvailable: () => true,
      getSelectedStorageBackend: () => backend,
      encryptString: () => Buffer.from('encrypted'), decryptString: () => 'session',
    });
    expect(storage.isEncryptionAvailable()).toBe(false);
    expect(() => storage.encryptString('credential')).toThrow('operating-system keystore');
    expect(() => storage.decryptString(Buffer.from('encrypted'))).toThrow('operating-system keystore');
  });
  it.each(['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6'])('uses %s to protect credentials', (backend) => {
    const encryptString = vi.fn(() => Buffer.from('protected'));
    const storage = systemKeyStorage('linux', { isEncryptionAvailable: () => true,
      getSelectedStorageBackend: () => backend, encryptString, decryptString: () => 'credential' });
    expect(storage.encryptString('credential').toString()).toBe('protected');
    expect(encryptString).toHaveBeenCalledWith('credential');
  });
  it('never asks macOS for a Linux backend', () => {
    const storage = systemKeyStorage('darwin', { isEncryptionAvailable: () => true,
      getSelectedStorageBackend: () => { throw new Error('Linux only'); },
      encryptString: () => Buffer.from('keychain'), decryptString: () => 'credential' });
    expect(storage.encryptString('credential').toString()).toBe('keychain');
  });
});
