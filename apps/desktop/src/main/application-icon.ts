export const applicationIconFamilies = {
  avalon: {
    light: 'avalon-light.icns',
    dark: 'avalon-dark.icns',
  },
} as const;

export type ApplicationIconName = keyof typeof applicationIconFamilies;
export type ApplicationIconAppearance = 'light' | 'dark';

export const defaultApplicationIcon: ApplicationIconName = 'avalon';

export function applicationIconAppearance(shouldUseDarkColors: boolean): ApplicationIconAppearance {
  return shouldUseDarkColors ? 'dark' : 'light';
}

export function applicationIconFileName(
  iconName: ApplicationIconName,
  appearance: ApplicationIconAppearance,
): string {
  return applicationIconFamilies[iconName][appearance];
}

const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function pngArea(encoded: Buffer): number | null {
  if (encoded.length < 24 || !encoded.subarray(0, pngSignature.length).equals(pngSignature)) return null;
  if (encoded.toString('ascii', 12, 16) !== 'IHDR') return null;
  const width = encoded.readUInt32BE(16);
  const height = encoded.readUInt32BE(20);
  if (width === 0 || height === 0) return null;
  return width * height;
}

/**
 * ICNS is the source format for macOS app icons, but Electron NativeImage only
 * decodes PNG/JPEG. Modern ICNS files store their raster representations as
 * PNG chunks, so use the largest one for the running process's Dock override.
 */
export function largestPngFromIcns(encoded: Buffer): Buffer {
  if (encoded.length < 8 || encoded.toString('ascii', 0, 4) !== 'icns') {
    throw new Error('Application icon is not an ICNS file');
  }
  const declaredLength = encoded.readUInt32BE(4);
  if (declaredLength < 8 || declaredLength > encoded.length) {
    throw new Error('Application icon has a truncated ICNS container');
  }

  let best: { area: number; png: Buffer } | undefined;
  let offset = 8;
  while (offset < declaredLength) {
    if (offset + 8 > declaredLength) throw new Error('Application icon has a truncated ICNS entry');
    const entryLength = encoded.readUInt32BE(offset + 4);
    if (entryLength < 8 || offset + entryLength > declaredLength) {
      throw new Error('Application icon has an invalid ICNS entry');
    }
    const candidate = encoded.subarray(offset + 8, offset + entryLength);
    const area = pngArea(candidate);
    if (area !== null && (!best || area > best.area)) best = { area, png: candidate };
    offset += entryLength;
  }

  if (!best) throw new Error('Application icon does not contain a PNG representation');
  return best.png;
}
