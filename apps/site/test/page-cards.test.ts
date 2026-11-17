import "../../../tests/isolated-region";
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { addPageCard, pageCardFor, renderPageCard, type PageCard } from '../src/page-cards';

const card: PageCard = {
  path: '/made/',
  eyebrow: 'Rally Canvases',
  title: 'Made once.\nKept current.',
  description: 'A page Rally keeps current.',
  scene: 'canvas',
};
const page = (h1: string, head = '') =>
  `<!doctype html><html><head><title>Made</title>${head}</head><body><h1 id="page-title" class="display">${h1}</h1></body></html>`;

describe('page cards', () => {
  it('adds the card to a page whose headline is the card title, reading line breaks and markup as the reader sees them', () => {
    const html = addPageCard(page('Made once.<br><em>Kept current.</em>'), card);
    expect(html).toBe(page('Made once.<br><em>Kept current.</em>', [
      '    <meta property="og:image" content="https://rallywith.ai/made/social.png" />',
      '    <meta property="og:image:width" content="1200" />',
      '    <meta property="og:image:height" content="630" />',
      '    <meta property="og:image:alt" content="Made once. Kept current. Two pencil-drawn colleagues leaning over a shared plan, with a small studio behind them." />',
      '    <meta name="twitter:card" content="summary_large_image" />',
      '    <meta name="twitter:image" content="https://rallywith.ai/made/social.png" />',
      '    <meta name="twitter:image:alt" content="Made once. Kept current. Two pencil-drawn colleagues leaning over a shared plan, with a small studio behind them." />',
      '  ',
    ].join('\n')));
  });

  it('ends a title without its own stop with one in the image description', () => {
    const html = addPageCard(page('Cookie &amp; Tracking Notice'), { ...card, title: 'Cookie & Tracking Notice', scene: 'together' });
    expect(html).toContain('<meta property="og:image:alt" content="Cookie &amp; Tracking Notice. Two pencil-drawn colleagues walking together with a pencil and a rolled plan." />');
  });

  it('fails the build when the page headline no longer matches its card, naming both', () => {
    expect(() => addPageCard(page('Made twice.'), card))
      .toThrow('rally-page-cards: the card for /made/ is titled "Made once. Kept current." but the page\'s <h1> reads "Made twice."');
    expect(() => addPageCard('<html><head></head><body></body></html>', card))
      .toThrow('the page\'s <h1> reads "(none)"');
  });

  it('refuses a page that still names its own image', () => {
    expect(() => addPageCard(page('Made once. Kept current.', '<meta property="og:image" content="https://rallywith.ai/old.jpg" />'), card))
      .toThrow('rally-page-cards: /made/ names its own social image; its card comes from src/page-cards.ts');
  });

  it('finds a card from the path Vite builds or the URL the dev server is asked for', () => {
    expect(pageCardFor('/canvases/index.html')?.path).toBe('/canvases/');
    expect(pageCardFor('/canvases/?ref=x')?.path).toBe('/canvases/');
    expect(pageCardFor('/index.html')?.path).toBe('/');
    expect(pageCardFor('/invite/index.html')).toBeUndefined();
  });

  it('draws a card at the size social sites ask for', async () => {
    expect(await sharp(await renderPageCard(card)).metadata()).toMatchObject({ format: 'png', width: 1200, height: 630 });
  });
});
