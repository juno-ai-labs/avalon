import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  applicationIconAppearance,
  applicationIconFileName,
  applicationIconFamilies,
  largestPngFromIcns,
} from './application-icon';

const iconResourceDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '../../resources/icons');

function fakePng(width: number, height: number): Buffer {
  const encoded = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(encoded);
  encoded.writeUInt32BE(13, 8);
  encoded.write('IHDR', 12, 'ascii');
  encoded.writeUInt32BE(width, 16);
  encoded.writeUInt32BE(height, 20);
  return encoded;
}

function icnsEntry(type: string, payload: Buffer): Buffer {
  const entry = Buffer.alloc(8 + payload.length);
  entry.write(type, 0, 'ascii');
  entry.writeUInt32BE(entry.length, 4);
  payload.copy(entry, 8);
  return entry;
}

function icns(...entries: Buffer[]): Buffer {
  const encoded = Buffer.concat([Buffer.alloc(8), ...entries]);
  encoded.write('icns', 0, 'ascii');
  encoded.writeUInt32BE(encoded.length, 4);
  return encoded;
}

describe('application icons', () => {
  it('resolves appearance variants from a named icon family', () => {
    expect(applicationIconAppearance(false)).toBe('light');
    expect(applicationIconAppearance(true)).toBe('dark');
    expect(applicationIconFileName('avalon', 'light')).toBe('avalon-light.icns');
    expect(applicationIconFileName('avalon', 'dark')).toBe('avalon-dark.icns');
  });

  it('extracts the largest embedded PNG representation from an ICNS file', () => {
    const small = fakePng(128, 128);
    const large = fakePng(1024, 1024);
    expect(largestPngFromIcns(icns(
      icnsEntry('ic07', small),
      icnsEntry('name', Buffer.from('Avalon')),
      icnsEntry('ic10', large),
    ))).toEqual(large);
  });

  it('ships every declared appearance as a 1024px ICNS source', () => {
    for (const fileName of Object.values(applicationIconFamilies.avalon)) {
      const png = largestPngFromIcns(readFileSync(resolve(iconResourceDirectory, fileName)));
      expect(png.readUInt32BE(16)).toBe(1024);
      expect(png.readUInt32BE(20)).toBe(1024);
    }
  });

  it.each([
    Buffer.from('not an icon'),
    Buffer.from('69636e7300000100', 'hex'),
    icns(icnsEntry('name', Buffer.from('Avalon'))),
  ])('rejects malformed ICNS data', (encoded) => {
    expect(() => largestPngFromIcns(encoded)).toThrow();
  });
});
