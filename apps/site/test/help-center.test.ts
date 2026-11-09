import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { HelpContentError, loadHelpSite } from '../build/help/content';
import { renderMarkdown } from '../build/help/markdown';
import { ogImagePath, renderOgImage } from '../build/help/og';
import { buildHelp } from '../build/help/site';
import { searchEntries, type SearchEntry } from '../src/help-search';
import { markdownPathFor, prefersMarkdown } from '../worker/index';

const roots: string[] = [];

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'rally-help-'));
  roots.push(root);
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  return root;
}

const page = (title: string, body = '', extra = ''): string =>
  `---\ntitle: ${title}\ndescription: About ${title.toLowerCase()}.\n${extra}---\n\n${body}`;

const assets = { styles: ['/assets/help.css'], scripts: ['/assets/help.js'] };

const problemsOf = (run: () => unknown): string[] => {
  try {
    run();
  } catch (error) {
    if (error instanceof HelpContentError) return error.problems;
    throw error;
  }
  return [];
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('help center content', () => {
  it('orders chapters and pages by their number and counts chapters from one', () => {
    const root = tree({
      'index.md': page('Manual'),
      '20-sidekicks/index.md': page('Sidekicks'),
      '20-sidekicks/10-schedules.md': page('Schedules'),
      '20-sidekicks/2-create.md': page('Create'),
      '05-start/index.md': page('Start'),
    });
    const site = loadHelpSite(root);
    expect(site.chapters.map((chapter) => [chapter.number, chapter.slug])).toEqual([[1, 'start'], [2, 'sidekicks']]);
    expect(site.pages.map((entry) => entry.url)).toEqual([
      '/help/', '/help/start/', '/help/sidekicks/', '/help/sidekicks/create/', '/help/sidekicks/schedules/',
    ]);
    expect(site.pages[3]?.markdownUrl).toBe('/help/sidekicks/create.md');
  });

  it('names every front matter and layout problem in one error', () => {
    const root = tree({
      'index.md': page('Manual'),
      '01-start/index.md': '---\ntitle: Start\nsumary: typo\n---\n',
      '01-start/02-install.md': 'No front matter here.',
      '01-start/notes.md': page('Notes'),
      '01-start/deeper/03-page.md': page('Too deep'),
    });
    expect(problemsOf(() => loadHelpSite(root))).toEqual([
      '01-start/index.md: unknown front matter key "sumary" (allowed: title, description, nav_title, draft)',
      '01-start/index.md: front matter needs "description"',
      '01-start/02-install.md: missing front matter (start the file with ---, title:, description:, ---)',
      '01-start/deeper/: chapters are one level deep; nested folders may hold images but not pages',
      '01-start/notes.md: page files are named NN-slug.md, e.g. 02-invite-people.md',
    ]);
  });

  it('refuses a draft chapter opener that would hide finished pages', () => {
    const root = tree({
      'index.md': page('Manual'),
      '01-start/index.md': page('Start', '', 'draft: true\n'),
      '01-start/01-ready.md': page('Ready'),
    });
    expect(problemsOf(() => loadHelpSite(root))).toEqual([
      '01-start/index.md: is a draft, which would hide 1 finished page(s) in this chapter; mark them draft too, or publish the opener',
    ]);
  });

  it('leaves drafts out of a build and keeps them for a preview', () => {
    const root = tree({
      'index.md': page('Manual'),
      '01-start/index.md': page('Start'),
      '01-start/01-ready.md': page('Ready'),
      '01-start/02-soon.md': page('Soon', '', 'draft: true\n'),
    });
    expect(loadHelpSite(root).chapters[0]?.pages.map((entry) => entry.frontMatter.title)).toEqual(['Ready']);
    expect(loadHelpSite(root, { includeDrafts: true }).chapters[0]?.pages.map((entry) => entry.frontMatter.title)).toEqual(['Ready', 'Soon']);
  });
});

describe('help center markdown', () => {
  const render = (source: string) => renderMarkdown(source, { resolveHref: (href) => ({ href: `/resolved/${href}` }) });

  it('turns GitHub alerts into callouts and drops script tags', () => {
    expect(render('> [!TIP]\n> Press the button.\n\n<script>alert(1)</script>').html).toBe(
      '<div class="markdown-alert markdown-alert-tip"><p class="markdown-alert-title">Tip</p>\n<p>Press the button.</p>\n</div>\n',
    );
  });

  it('gives headings unique ids and reports H1 to H3 for the outline', () => {
    const { headings, html } = render('# One\n\n## Setup\n\n### Setup\n\n#### Deep');
    expect(headings).toEqual([
      { depth: 1, id: 'one', text: 'One' },
      { depth: 2, id: 'setup', text: 'Setup' },
      { depth: 3, id: 'setup-1', text: 'Setup' },
    ]);
    expect(html).toContain('<h4 id="deep">Deep<a class="anchor" href="#deep" aria-hidden="true" tabindex="-1">#</a></h4>');
  });

  it('wraps tables and code blocks, and highlights code by its language', () => {
    const { html } = render('| a |\n| - |\n| b |\n\n```js\nconst x = 1;\n```');
    expect(html).toContain('<div class="table"><table>');
    expect(html).toContain('<div class="code" data-lang="js"><pre><code class="hl language-js"><span class="hl-keyword">const</span>');
  });

  it('resolves relative links and marks external ones', () => {
    const { html } = render('[next](02-next.md) [site](https://example.com) [here](#top)');
    expect(html).toBe('<p><a href="/resolved/02-next.md">next</a> <a href="https://example.com" rel="noopener" class="external">site</a> <a href="#top">here</a></p>');
  });
});

describe('help center build', () => {
  const site = () => tree({
    'index.md': page('Manual', 'Start with [chapter one](01-start/index.md).'),
    '01-start/index.md': page('Start', 'Read [install](01-install.md#before-you-begin).'),
    '01-start/01-install.md': page('Install', '## Before you begin\n\n![The window](images/window.png)\n\nBack to [the start](./index.md).'),
    '01-start/images/window.png': 'not really a png',
  });

  it('publishes each page as HTML and as Markdown with links rewritten for each', () => {
    const outputs = buildHelp(site(), { assets });
    expect([...outputs.keys()].sort()).toEqual([
      'help/_assets/window-e90137d39d.png',
      'help/index.html',
      'help/index.md',
      'help/llms-full.txt',
      'help/llms.txt',
      'help/search-index.json',
      'help/sitemap.xml',
      'help/start.md',
      'help/start/index.html',
      'help/start/install.md',
      'help/start/install/index.html',
      'help/start/llms.txt',
    ]);
    expect(outputs.get('help/start/install/index.html')).toContain('<img src="/help/_assets/window-e90137d39d.png" alt="The window" loading="lazy" decoding="async">');
    expect(outputs.get('help/start/index.html')).toContain('<a href="/help/start/install/#before-you-begin">install</a>');
    expect(outputs.get('help/start/install.md')).toBe(
      '> Rally Help Center. Index of every page: https://rallywith.ai/help/llms.txt\n> This chapter\'s pages: https://rallywith.ai/help/start/llms.txt\n\n# Install\n\n> About install.\n\n## Before you begin\n\n![The window](https://rallywith.ai/help/_assets/window-e90137d39d.png)\n\nBack to [the start](https://rallywith.ai/help/start.md).\n',
    );
    expect(outputs.get('help/llms.txt')).toContain('## Chapter 1: Start\n\nAbout start. Index of this chapter: https://rallywith.ai/help/start/llms.txt\n\n- [Start](https://rallywith.ai/help/start.md): About start.\n- [1.1 Install](https://rallywith.ai/help/start/install.md): About install.');
  });

  it('fails on a link to a missing page, a missing heading, or a missing image', () => {
    const root = tree({
      'index.md': page('Manual', '[gone](01-start/09-gone.md) [anchor](01-start/index.md#nowhere) ![x](missing.png) ![y](https://example.com/y.png)'),
      '01-start/index.md': page('Start', '## Somewhere\n\nSee [above](#somewhere), not [here](#elsewhere). A note.[^1]\n\n[^1]: Footnote.'),
    });
    expect(problemsOf(() => buildHelp(root, { assets }))).toEqual([
      'index.md: link "01-start/09-gone.md" points at a page that does not exist',
      'index.md: image "missing.png" points at a file that does not exist',
      'index.md: image "https://example.com/y.png" is on another site, which the site\'s Content-Security-Policy blocks; save the image in the help folder and link it relatively',
      'index.md: link "01-start/index.md#nowhere" names a heading that 01-start/index.md does not have (it has: somewhere)',
      '01-start/index.md: link "#elsewhere" names a heading that 01-start/index.md does not have (it has: somewhere)',
    ]);
  });

  it('builds the published help center without a broken link', () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), '../help');
    expect(buildHelp(root, { assets }).has('help/index.html')).toBe(true);
  });
});

describe('help center search', () => {
  const entry = (t: string, x: string, h: Array<[string, string]> = []): SearchEntry => ({ t, c: 'Chapter 1 · Start', u: `/help/${t.toLowerCase()}/`, d: '', h, x });
  const entries = [
    entry('Sidekicks', 'A sidekick runs on a schedule.'),
    entry('Canvases', 'Talk in a canvas. Sidekicks can write here.', [['schedules', 'Schedules']]),
    entry('Billing', 'Invoices.'),
  ];

  it('ranks title matches above body matches and needs every word', () => {
    expect(searchEntries(entries, 'sidekick').map((hit) => hit.entry.t)).toEqual(['Sidekicks', 'Canvases']);
    expect(searchEntries(entries, 'sidekick invoices')).toEqual([]);
  });

  it('returns every match rather than a fixed number', () => {
    const many = Array.from({ length: 30 }, (_, index) => entry(`Page ${index}`, 'Mentions sidekick once.'));
    expect(searchEntries(many, 'sidekick')).toHaveLength(30);
  });

  it('points a heading match at its section', () => {
    expect(searchEntries(entries, 'schedules').map((hit) => [hit.entry.t, hit.heading])).toEqual([
      ['Canvases', ['schedules', 'Schedules']],
    ]);
  });
});

describe('help center content negotiation', () => {
  it('serves Markdown only to clients that rank it above HTML', () => {
    expect(prefersMarkdown('text/markdown, text/html')).toBe(true);
    expect(prefersMarkdown('text/markdown;q=1.0, text/html;q=0.7, */*;q=0.1')).toBe(true);
    expect(prefersMarkdown('text/html, text/markdown')).toBe(false);
    expect(prefersMarkdown('text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8')).toBe(false);
    expect(prefersMarkdown('*/*')).toBe(false);
    expect(prefersMarkdown('text/markdown;q=0')).toBe(false);
    expect(prefersMarkdown(null)).toBe(false);
  });

  it('maps a page URL to its Markdown copy and leaves files alone', () => {
    expect(markdownPathFor('/help')).toBe('/help/index.md');
    expect(markdownPathFor('/help/')).toBe('/help/index.md');
    expect(markdownPathFor('/help/sidekicks/')).toBe('/help/sidekicks.md');
    expect(markdownPathFor('/help/sidekicks/schedules')).toBe('/help/sidekicks/schedules.md');
    expect(markdownPathFor('/help/llms.txt')).toBeNull();
    expect(markdownPathFor('/help/_assets/window-1.png')).toBeNull();
    expect(markdownPathFor('/trust/')).toBeNull();
  });
});

describe('help center social cards', () => {
  const site = () => loadHelpSite(tree({
    'index.md': page('Manual'),
    '01-start/index.md': page('Start'),
    '01-start/01-install.md': page('Install'),
  }));

  it('names each card after its page and changes the name when the words change', () => {
    const before = site().pages.map(ogImagePath);
    expect(before.map((path) => path.replace(/-[0-9a-f]{10}\.png$/u, ''))).toEqual(['/help/_og/help', '/help/_og/start', '/help/_og/start--install']);
    const renamed = loadHelpSite(tree({
      'index.md': page('Manual'),
      '01-start/index.md': page('Start'),
      '01-start/01-install.md': page('Install Rally'),
    }));
    expect(ogImagePath(renamed.pages[2]!)).not.toBe(before[2]);
    expect(ogImagePath(renamed.pages[1]!)).toBe(before[1]);
  });

  it('renders a 1200 by 630 PNG', async () => {
    const png = Buffer.from(await renderOgImage(site().pages[2]!));
    expect(png.subarray(1, 4).toString('ascii')).toBe('PNG');
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([1200, 630]);
  });

  it('puts the card in the page head', () => {
    const html = buildHelp(tree({ 'index.md': page('Manual') }), { assets }).get('help/index.html');
    expect(html).toMatch(/<meta property="og:image" content="https:\/\/rallywith\.ai\/help\/_og\/help-[0-9a-f]{10}\.png">/u);
    expect(html).toContain('<meta property="og:image:alt" content="Manual: About manual.">');
  });
});
