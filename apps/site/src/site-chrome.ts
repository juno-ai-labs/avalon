/**
 * Shared markup for the public marketing pages: the column footer and the
 * comparison table. Pages hold a marker comment and the Vite plugin in
 * `vite.config.ts` swaps in the markup, so the list of rivals and Trust Center
 * pages lives here once instead of in every page that shows it.
 */

export interface Comparison {
  /** Path segment under `/compare/`, and the page's directory name. */
  slug: string;
  name: string;
  maker: string;
  /** What the product is, in one plain line. */
  kind: string;
  /** Why a team would pick Rally instead, in one plain line. */
  edge: string;
}

export const comparisons: readonly Comparison[] = [
  {
    slug: 'claude-tag', name: 'Claude Tag', maker: 'Anthropic',
    kind: 'Claude as a teammate you tag in Slack threads.',
    edge: 'Rally gives the team its own room with Spaces, private Breakouts, and the right model for each job, not one vendor’s.',
  },
  {
    slug: 'grok-bot', name: 'Grok Bot', maker: 'xAI',
    kind: 'A crew of named Grok agents you build, equip, and add to Slack.',
    edge: 'One AI that sets up its own Sidekicks, so nobody has to build and babysit a bot roster.',
  },
  {
    slug: 'viktor', name: 'Viktor', maker: 'Viktor',
    kind: 'An AI coworker you message in Slack or Teams, paid in credits.',
    edge: 'Viktor takes tasks. Rally is where the whole team and the AI work from the same context, at one flat price.',
  },
  {
    slug: 'chatgpt', name: 'ChatGPT', maker: 'OpenAI',
    kind: 'A personal AI chat, mostly one person at a time.',
    edge: 'Coworkers see the work, add to it, and pick it up. No more pasting answers into Slack.',
  },
  {
    slug: 'claude-cowork', name: 'Claude Cowork', maker: 'Anthropic',
    kind: 'A desktop agent that works through one person’s files and apps.',
    edge: 'Cowork works on your laptop. Rally works where the whole team can see it.',
  },
  {
    slug: 'instinct', name: 'Instinct', maker: 'Spear Street Technology',
    kind: 'An invite-only personal agent for errands and life admin.',
    edge: 'Rally is built for team work. It won’t book your dentist, but it will get the launch plan out the door.',
  },
  {
    slug: 'notion-ai', name: 'Notion AI', maker: 'Notion',
    kind: 'AI inside your Notion pages, wiki, and databases.',
    edge: 'Rally reads your Notion and the rest of your tools, and the conversation is shared, not tucked in a page sidebar.',
  },
  {
    slug: 'slack', name: 'Slack', maker: 'Salesforce',
    kind: 'Team chat, now with AI summaries and Slackbot.',
    edge: 'Slack is where you talk about work. Rally is where people and AI do it together, and it still posts back to Slack.',
  },
  {
    slug: 'microsoft-teams', name: 'Microsoft Teams', maker: 'Microsoft',
    kind: 'Chat and meetings, with Copilot sold per seat on top.',
    edge: 'No license maze. One price per organization, no seat limit, and it works with Google tools too.',
  },
];

export const trustPages: readonly { href: string; name: string }[] = [
  { href: '/trust/', name: 'Overview' },
  { href: '/trust/security/', name: 'Security' },
  { href: '/trust/privacy/', name: 'Privacy' },
  { href: '/trust/terms/', name: 'Terms' },
  { href: '/trust/dpa/', name: 'DPA' },
  { href: '/trust/subprocessors/', name: 'Sub-processors' },
  { href: '/trust/cookies/', name: 'Cookies' },
  { href: '/trust/acceptable-use/', name: 'Acceptable Use' },
];

const escape = (text: string): string =>
  text.replace(/[&<>"']/gu, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character] ?? character);

const footerColumn = (id: string, title: string, links: readonly string[]): string =>
  `<nav class="footer-column" aria-labelledby="${id}"><h2 class="footer-heading" id="${id}">${title}</h2><ul class="footer-links">${links.map((link) => `<li>${link}</li>`).join('')}</ul></nav>`;

export function renderSiteFooter(): string {
  const compared = [
    ...comparisons.map(({ slug, name }) => `<a href="/compare/${slug}/">${escape(name)}</a>`),
    '<a href="/compare/">All comparisons</a>',
  ];
  const trust = trustPages.map(({ href, name }) => `<a href="${href}">${escape(name)}</a>`);
  const help = [
    '<a href="/support/">Support</a>',
    '<a href="/support/getting-started/">Getting started</a>',
    '<a href="/support/connectors/">Connectors</a>',
    '<a data-site-action="support-contact-footer" href="mailto:help@rallywith.ai?subject=Rally%20support">help@rallywith.ai</a>',
  ];
  return `<footer class="rally-footer"><div class="footer-grid">`
    + `<div class="footer-brand"><a class="wordmark" href="/" aria-label="Rally home"><img class="rally-symbol" src="/brand/rally-mark-ink.svg" width="24" height="24" alt=""><span>rally</span></a>`
    + `<p class="footer-tagline">Made for people who work with AI, not on it.</p></div>`
    + footerColumn('footer-compared', 'Compared to', compared)
    + footerColumn('footer-trust', 'Trust Center', trust)
    + footerColumn('footer-help', 'Help', help)
    + `</div><p class="footer-legal"><small>© 2026 Juno AI Labs · Rally</small></p></footer>`;
}

/** Every rival in one table, each row linking to its own page. */
export function renderComparisonTable(): string {
  const rows = comparisons.map(({ slug, name, maker, kind, edge }) =>
    `<tr><th scope="row"><a class="compare-name" href="/compare/${slug}/">${escape(name)}</a><span class="compare-maker">${escape(maker)}</span></th>`
    + `<td data-label="What it is">${escape(kind)}</td>`
    + `<td data-label="Why teams pick Rally">${escape(edge)}</td>`
    + `<td class="compare-more"><a href="/compare/${slug}/" aria-label="Rally vs ${escape(name)}, full comparison">Rally vs ${escape(name)} <span aria-hidden="true">→</span></a></td></tr>`,
  ).join('');
  return `<div class="compare-table-wrap"><table class="compare-table">`
    + `<caption class="compare-caption">Rally compared with nine AI and team tools, as of October 2026</caption>`
    + `<thead><tr><th scope="col">Tool</th><th scope="col">What it is</th><th scope="col">Why teams pick Rally</th><th scope="col"><span class="visually-hidden">Full comparison</span></th></tr></thead>`
    + `<tbody>${rows}</tbody></table></div>`;
}

const markers: Record<string, () => string> = {
  'site-footer': renderSiteFooter,
  'comparison-table': renderComparisonTable,
};

/** Replaces each `<!-- rally:name -->` marker with its shared markup. */
export function renderSiteChrome(html: string): string {
  return html.replace(/<!-- rally:([a-z-]+) -->/gu, (_match, name: string) => {
    const render = markers[name];
    if (!render) throw new Error(`Unknown site chrome marker: ${name}`);
    return render();
  });
}
