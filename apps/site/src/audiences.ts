/**
 * The audiences the site has a page for at `/for/<slug>/`. Each page is its
 * own hand-written file (`for/<slug>/index.html` and `src/for/<slug>.css`);
 * this table holds only what the rest of the site says about it: the
 * homepage's grid, the footer column, the list at the foot of each audience
 * page, the sitemap, `llms.txt` and the link previews. Node only.
 */
import { escapeHtml as escape } from './html';
import { arrow } from './site-icons';

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
  /**
   * The Marketplace template its page starts: a file name without `.md` under
   * `packages/skills/marketplace-skills/`. The page's sign-up buttons link to
   * `/app/templates/<template>` on the web app, which signs the person up and
   * opens a Canvas that has already asked Rally for this audience's page.
   */
  readonly template: string;
  /** Which of the shared drawings its link preview carries, so seven previews in a row are not one picture. */
  readonly scene: 'canvas' | 'sidekick' | 'together';
}

/** In the order the homepage lists them. */
export const audiences: readonly Audience[] = [
  { slug: 'wholesalers', name: 'Wholesalers and small sellers', short: 'Wholesalers', line: 'Orders, quotes and supplier back-and-forth in one place.', headline: 'Every order in your inbox, on one board.', pitch: 'Connect Gmail and get an order board in five minutes: orders, quotes and supplier deliveries, kept up to date by your mail.', template: 'order-board', scene: 'canvas' },
  { slug: 'agencies', name: 'Agencies and freelancers', short: 'Agencies', line: 'Client requests, open threads and overdue replies on one page.', headline: 'Which client did you forget to answer?', pitch: 'Connect Gmail and get a wall of your clients in five minutes: who’s waiting on you, for how long, and what they asked.', template: 'client-wall', scene: 'together' },
  { slug: 'legal', name: 'In-house legal teams', short: 'Legal teams', line: 'Contract reviews, NDA requests, and who’s waiting on whom.', headline: 'Every open matter, and whose turn it is.', pitch: 'Connect Gmail and get a docket of every legal request: who asked, whose turn it is, and for how many days. It updates itself.', template: 'legal-docket', scene: 'sidekick' },
  { slug: 'accountants', name: 'Accountants and bookkeepers', short: 'Accountants', line: 'Document requests, client status and deadlines.', headline: 'The client checklist that ticks itself off.', pitch: 'Connect Gmail and get a checklist of the documents each client owes you. It ticks itself off as they arrive.', template: 'client-document-checklist', scene: 'canvas' },
  { slug: 'recruiters', name: 'Recruiters and staffing shops', short: 'Recruiters', line: 'Candidates, intros and placements.', headline: 'Candidates on one side, clients on the other.', pitch: 'Connect Gmail and get one page of every candidate, client and intro, and whose reply you’re waiting on. It updates itself.', template: 'recruiting-desk', scene: 'together' },
  { slug: 'brokers', name: 'Real estate, mortgage and insurance brokers', short: 'Brokers', line: 'Leads, deals in progress and follow-ups due.', headline: 'Who’s waiting on you today?', pitch: 'Connect Gmail. In five minutes, see every lead, deal and follow-up that is waiting on you, longest wait first. The page updates itself.', template: 'todays-follow-ups', scene: 'sidekick' },
  { slug: 'event-planners', name: 'Wedding and event planners', short: 'Event planners', line: 'Vendors, client requests and what’s due before each date.', headline: 'Everything due before the date, on one page.', pitch: 'Connect Gmail and get a page for each event in five minutes: every vendor, every client request and what is due before the date.', template: 'event-countdown', scene: 'together' },
];

const ORIGIN = 'https://rallywith.ai';

export const audiencePath = (slug: string): string => `/for/${slug}/`;

/**
 * Where an audience page's sign-up buttons go: its template's link on the web
 * app. A page writes `href="<!-- rally:audience-start <slug> -->"` and this
 * fills it in, so a page cannot name a template its registry row does not.
 */
export function renderAudienceStartLink(slug?: string): string {
  const audience = audiences.find((candidate) => candidate.slug === slug);
  if (!audience) throw new Error(`Unknown audience: ${slug ?? '(none)'}`);
  return `https://app.rallywith.ai/app/templates/${audience.template}`;
}

/** The homepage's grid: one card per audience, linking to its page. */
export function renderAudienceGrid(): string {
  return `<ul class="audience-grid">${audiences.map(({ slug, name, line }) =>
    `<li><a href="${audiencePath(slug)}"><strong>${escape(name)}</strong><span>${escape(line)}</span><i aria-hidden="true">${arrow}</i></a></li>`).join('')}`
    // The last card is for everyone the list leaves out.
    + `<li class="audience-grid-more"><a href="/developer-mode/"><strong>Something else?</strong><span>Rally builds more than inbox pages. Try developer mode.</span><i aria-hidden="true">${arrow}</i></a></li></ul>`;
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
