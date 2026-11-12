import { describe, expect, it } from 'vitest';
import sharp, { type Region } from 'sharp';
import { renderReadingCard } from '../src/reading-card';

const preview = (title: string) => renderReadingCard({
  eyebrow: 'Rally blog', title, description: 'A short description of the work.',
  address: 'rallywith.ai/blog/long-title', scene: 'together',
});

async function isPaper(png: Buffer, region: Region): Promise<boolean> {
  const pixels = await sharp(png).extract(region).ensureAlpha().raw().toBuffer();
  return pixels.every((value, index) => value === [252, 251, 247, 255][index % 4]);
}

describe('reading card title layout', () => {
  it('keeps long multi-line titles out of the footer clearance', async () => {
    const png = await preview('Good work deserves a little company. '.repeat(24));
    expect(await isPaper(png, { left: 64, top: 545, width: 625, height: 20 })).toBe(true);
  });

  it('keeps a long unbroken word inside the text column', async () => {
    const png = await preview('Supercalifragilisticexpialidocious'.repeat(16));
    expect(await isPaper(png, { left: 700, top: 165, width: 35, height: 265 })).toBe(true);
  });
});
