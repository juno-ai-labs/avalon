/**
 * The link preview of every hand-written page: home, the audience pages, the
 * product pages, the marketplace and blog indexes, and the Trust Center. Help, blog posts and
 * marketplace templates draw theirs from their own front matter instead.
 *
 * The `rally-page-cards` plugin in `vite.config.ts` draws each card at build
 * time to `<path>social.png`, adds its image tags to the page, and fails the
 * build when a card's title is not the page's `<h1>`, so a headline change
 * cannot leave a stale card behind. The description is the card's pitch: what
 * someone gets from opening the link, in the page's own words.
 */
import { escapeHtml } from './html';
import { accessCopy } from './access-copy';
import { audiencePath, audiences } from './audiences';
import { getIllustration } from './home-illustrations';
import { renderReadingCard, type ReadingCard } from './reading-card';

export interface PageCard {
  /** Published path of the page, ending in `/`. */
  path: string;
  eyebrow: string;
  /** The page's `<h1>`, word for word; a `\n` breaks the card's line where the page breaks its own. */
  title: string;
  description: string;
  scene: ReadingCard['scene'];
}

const ORIGIN = 'https://rallywith.ai';
const TRUST = 'Rally Trust Center';

export const pageCards: readonly PageCard[] = [
  {
    path: '/',
    eyebrow: 'Start free · No credit card needed',
    title: 'Connect Gmail. Get a dashboard of your leads in five minutes.',
    description: 'Rally turns your inbox into one page you can check at a glance: a dashboard, a board or a table. It updates itself as new mail arrives.',
    scene: 'canvas',
  },
  // Each audience page's card is its row in `audiences.ts`.
  ...audiences.map(({ slug, name, headline, pitch, scene }): PageCard => ({
    path: audiencePath(slug),
    eyebrow: `Rally for ${name.charAt(0).toLowerCase()}${name.slice(1)}`,
    title: headline,
    description: pitch,
    scene,
  })),
  {
    path: '/developer-mode/',
    eyebrow: 'Beyond the inbox',
    title: 'Developer mode',
    description: 'Email is where most people start. Rally also builds dashboards, small apps, podcast feeds and websites that react to the tools you already use.',
    scene: 'canvas',
  },
  {
    path: '/canvases/',
    eyebrow: 'Rally Canvases',
    title: 'Made once.\nKept current.',
    description: 'Your conversation with Rally and the page it makes beside it: a dashboard, a board or a table, kept up to date from your email and your tools.',
    scene: 'canvas',
  },
  {
    path: '/sidekicks/',
    eyebrow: 'Rally Sidekicks',
    title: 'The AI that keeps\nwork current.',
    description: 'The helper behind a page that updates itself. It watches your email and tools, or runs on a schedule, then does the work.',
    scene: 'sidekick',
  },
  {
    path: '/start-fast/',
    eyebrow: 'Rally',
    title: `${accessCopy.headline}\n${accessCopy.headlineTurn}`,
    description: 'When something changes in Linear, Slack or Gmail, Rally publishes a new version, and your whole team works from the same page.',
    scene: 'together',
  },
  {
    path: '/marketplace/',
    eyebrow: 'Rally Marketplace',
    title: 'Start from something\nalready reactive.',
    description: 'Templates for the work you run from email, and for developers, product managers and parents. Pick one, and Rally builds it with you and keeps it current.',
    scene: 'canvas',
  },
  {
    path: '/blog/',
    eyebrow: 'Rally blog',
    title: 'A few notes from Rally.',
    description: 'News and writing from the people building Rally: what we are making, learning and thinking about along the way.',
    scene: 'together',
  },
  {
    path: '/trust/',
    eyebrow: TRUST,
    title: 'Trust should be\neasy to inspect.',
    description: 'Security, privacy, terms, data processing and sub-processors for Rally, public by default. No sales call needed.',
    scene: 'together',
  },
  {
    path: '/trust/security/',
    eyebrow: TRUST,
    title: 'Security should be\ninspectable.',
    description: 'The controls Rally enforces today, the systems behind them, our CASA assessment, and how to report a vulnerability.',
    scene: 'together',
  },
  {
    path: '/trust/privacy/',
    eyebrow: TRUST,
    title: 'Privacy Policy',
    description: 'How Juno AI Labs handles personal information when you visit our sites, use Rally, connect other services or contact us.',
    scene: 'together',
  },
  {
    path: '/trust/terms/',
    eyebrow: TRUST,
    title: 'Terms of Service',
    description: 'The terms that govern access to and use of Rally.',
    scene: 'together',
  },
  {
    path: '/trust/acceptable-use/',
    eyebrow: TRUST,
    title: 'Acceptable Use Policy',
    description: 'Rally can read context, generate content and act through connected tools. These rules keep that power aimed at legitimate work.',
    scene: 'together',
  },
  {
    path: '/trust/dpa/',
    eyebrow: TRUST,
    title: 'Data Processing Addendum',
    description: 'How Juno AI Labs processes Customer Personal Data in Rally, as part of the agreement for the Services.',
    scene: 'together',
  },
  {
    path: '/trust/subprocessors/',
    eyebrow: TRUST,
    title: 'Sub-processors',
    description: 'The infrastructure, AI, communications and retrieval providers that help Juno AI Labs deliver Rally.',
    scene: 'together',
  },
  {
    path: '/trust/cookies/',
    eyebrow: TRUST,
    title: 'Cookie & Tracking Notice',
    description: 'A plain account of what Rally measures on its site and in the app, which trackers run where, and what it stores on your device.',
    scene: 'together',
  },
];

/** The page's card, from a page path as Vite names it (`/canvases/index.html`) or a request URL. */
export function pageCardFor(path: string): PageCard | undefined {
  const page = path.split('?')[0]!.replace(/index\.html$/u, '');
  return pageCards.find((card) => card.path === page);
}

/** The card's published file, without the leading slash. */
export const pageCardFile = (card: PageCard): string => `${card.path.slice(1)}social.png`;

/** Draws the card as PNG bytes. */
export const renderPageCard = (card: PageCard): Promise<Buffer> =>
  renderReadingCard({ ...card, address: `rallywith.ai${card.path === '/' ? '' : card.path}` });

/** The `<h1>` as a reader sees it: tags dropped, line breaks and runs of space read as one space. */
export function headline(html: string): string | undefined {
  const match = /<h1\b[^>]*>([\s\S]*?)<\/h1>/u.exec(html);
  if (!match) return undefined;
  return match[1]!.replace(/<br\s*\/?>/gu, ' ').replace(/<[^>]*>/gu, '').replace(/&amp;/gu, '&').replace(/\s+/gu, ' ').trim();
}

/**
 * Adds the card's image tags to a page's head. A page that already names its
 * own image is refused, so one page cannot carry two cards.
 */
export function addPageCard(html: string, card: PageCard): string {
  if (/property="og:image"|name="twitter:(?:card|image)"/u.test(html)) {
    throw new Error(`rally-page-cards: ${card.path} names its own social image; its card comes from src/page-cards.ts`);
  }
  const title = card.title.replace(/\n/gu, ' ');
  const shown = headline(html);
  if (shown !== title) {
    throw new Error(`rally-page-cards: the card for ${card.path} is titled "${title}" but the page's <h1> reads "${shown ?? '(none)'}"`);
  }
  const image = `${ORIGIN}/${pageCardFile(card)}`;
  const alt = escapeHtml(`${/[.?!]$/u.test(title) ? title : `${title}.`} ${getIllustration(card.scene).label}`);
  const tags = [
    `<meta property="og:image" content="${image}" />`,
    '<meta property="og:image:width" content="1200" />',
    '<meta property="og:image:height" content="630" />',
    `<meta property="og:image:alt" content="${alt}" />`,
    '<meta name="twitter:card" content="summary_large_image" />',
    `<meta name="twitter:image" content="${image}" />`,
    `<meta name="twitter:image:alt" content="${alt}" />`,
  ];
  return html.replace('</head>', `    ${tags.join('\n    ')}\n  </head>`);
}
