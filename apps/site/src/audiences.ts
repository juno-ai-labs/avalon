/**
 * The audiences the site has a page for at `/for/<slug>/`. Each page is its
 * own hand-written file (`for/<slug>/index.html` and `src/for/<slug>.css`);
 * this table holds only what the rest of the site says about it: the
 * homepage's grid, the footer column, the list at the foot of each audience
 * page, the sitemap, `llms.txt` and the link previews. Node only.
 */
import { escapeHtml as escape } from './html';

export interface Audience {
  /** The page's address: `/for/<slug>/`. */
  readonly slug: string;
  /** Who it is for, as the grid and the lists name them. */
  readonly name: string;
  /** The same in a word or two, for the footer. */
  readonly short: string;
  /** One line: what ends up in one place. */
  readonly line: string;
  /** The page's `<h1>`, word for word, for its link preview; a `\n` breaks the line. */
  readonly headline: string;
  /** The link preview's pitch. */
  readonly pitch: string;
}

/** In the order the homepage lists them. */
export const audiences: readonly Audience[] = [
  { slug: 'wholesalers', name: 'Wholesalers and small sellers', short: 'Wholesalers', line: 'Orders, quotes and supplier back-and-forth in one place.', headline: 'Every order in your inbox, on one board.', pitch: 'Connect Gmail and get an order board in five minutes: orders, quotes and supplier deliveries, kept up to date by your mail.' },
  { slug: 'agencies', name: 'Agencies and freelancers', short: 'Agencies', line: 'Client requests, open threads and overdue replies on one page.', headline: 'Which client did you forget to answer?', pitch: 'Connect Gmail and get a wall of your clients in five minutes: who’s waiting on you, for how long, and what they asked.' },
  { slug: 'legal', name: 'In-house legal teams', short: 'Legal teams', line: 'Contract reviews, NDA requests, and who’s waiting on whom.', headline: 'Every open matter, and whose turn it is.', pitch: 'Connect Gmail and get a docket of every legal request: who asked, whose turn it is, and for how many days. It updates itself.' },
  { slug: 'accountants', name: 'Accountants and bookkeepers', short: 'Accountants', line: 'Document requests, client status and deadlines.', headline: 'The client checklist that ticks itself off.', pitch: 'Connect Gmail and get a checklist of the documents each client owes you. It ticks itself off as they arrive.' },
  { slug: 'recruiters', name: 'Recruiters and staffing shops', short: 'Recruiters', line: 'Candidates, intros and placements.', headline: 'Candidates on one side, clients on the other.', pitch: 'Connect Gmail and get one page of every candidate, client and intro, and whose reply you’re waiting on. It updates itself.' },
  { slug: 'brokers', name: 'Real estate, mortgage and insurance brokers', short: 'Brokers', line: 'Leads, deals in progress and follow-ups due.', headline: '', pitch: '' },
  { slug: 'event-planners', name: 'Wedding and event planners', short: 'Event planners', line: 'Vendors, client requests and what’s due before each date.', headline: 'Everything due before the date, on one page.', pitch: 'Connect Gmail and get a page for each event in five minutes: every vendor, every client request and what is due before the date.' },
];

const ORIGIN = 'https://rallywith.ai';

export const audiencePath = (slug: string): string => `/for/${slug}/`;

export const arrow = '<svg class="arrow-icon" viewBox="0 0 18 18" fill="none" aria-hidden="true"><path d="M4 14L14 4M4 4h10v10" /></svg>';

/** Gmail's mark, painted in `currentColor`. */
export const gmailMark = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor"><path d="M24 5.457v13.909c0 .904-.732 1.636-1.636 1.636h-3.819V11.73L12 16.64l-6.545-4.91v9.273H1.636A1.636 1.636 0 0 1 0 19.366V5.457c0-2.023 2.309-3.178 3.927-1.964L5.455 4.64 12 9.548l6.545-4.91 1.528-1.145C21.69 2.28 24 3.434 24 5.457z"/></svg>';

/** The homepage's grid: one card per audience, linking to its page. */
export function renderAudienceGrid(): string {
  return `<ul class="audience-grid">${audiences.map(({ slug, name, line }) =>
    `<li><a href="${audiencePath(slug)}"><strong>${escape(name)}</strong><span>${escape(line)}</span><i aria-hidden="true">${arrow}</i></a></li>`).join('')}`
    // The last card is for everyone the list leaves out.
    + `<li class="audience-grid-more"><a href="/off-the-beaten-path/"><strong>Something else?</strong><span>Rally builds more than inbox pages. See the rest.</span><i aria-hidden="true">${arrow}</i></a></li></ul>`;
}

/** The other audiences' pages, for the foot of the page named by `current`. */
export function renderOtherAudiences(current?: string): string {
  if (current && !audiences.some(({ slug }) => slug === current)) throw new Error(`Unknown audience: ${current}`);
  return `<ul class="audience-others">${audiences.filter(({ slug }) => slug !== current).map(({ slug, name }) =>
    `<li><a href="${audiencePath(slug)}">${escape(name)} ${arrow}</a></li>`).join('')}</ul>`;
}

/** A sitemap of every audience page, which `robots.txt` lists beside the main one. */
export function renderAudienceSitemap(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n`
    + audiences.map(({ slug }) => `  <url>\n    <loc>${ORIGIN}${audiencePath(slug)}</loc>\n  </url>\n`).join('')
    + '</urlset>\n';
}
