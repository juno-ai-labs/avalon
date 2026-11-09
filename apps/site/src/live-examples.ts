/**
 * The hero's live Canvas examples, one per kind of person, and the renderer
 * that turns them into the carousel. Node only: `site-chrome.ts` renders the
 * carousel into the page at build time, and `live-carousel.ts` plays it in the
 * browser by reading the `data-at` and `data-until` steps written here.
 *
 * Each example is a Canvas a Sidekick keeps current. Signal `n` (1-based)
 * arrives at step `2n - 1`; the version it produces, and every change to the
 * artifact it causes, lands at step `2n`. A change names its signal, so adding
 * a signal never means renumbering steps by hand.
 *
 * After the last signal comes the payoff, the step the example exists for:
 * something useful Rally noticed across the signals that nobody asked about,
 * the row it is about, and what the Sidekick did with it.
 */
import { escapeHtml } from './comparison-pages';

type Person = 'maya' | 'theo' | 'priya' | 'sam';

/** A cell that changes when signal `at` lands: `from` before, `to` after. */
type Change = { from: string; to: string; at: number };
type Cell = string | Change;
/** A row present from the start, or one that a signal adds (`at`). */
type Row = { cells: readonly Cell[]; at?: number };

export type LiveExample = {
  id: string;
  /** The tab label: who this example is for. */
  persona: string;
  /** One line under the tab row describing the example. */
  summary: string;
  title: string;
  kind: 'Spreadsheet' | 'Document' | 'Website';
  /** The Sidekick that keeps the Canvas current. */
  keeper: string;
  /** Who has the Canvas: one face is someone working alone. */
  people: readonly Person[];
  /** The version shown before the first signal lands. */
  version: number;
  signals: readonly { source: string; text: string }[];
  columns: readonly string[];
  rows: readonly Row[];
  payoff: {
    /** What Rally noticed, in the panel beside the artifact. */
    noticed: string;
    /** What the Sidekick did about it, in the feed. */
    did: string;
    /** The row (0-based) the payoff is about, which lights up with it. */
    row: number;
  };
};

const initials: Record<Person, string> = { maya: 'M', theo: 'T', priya: 'P', sam: 'S' };

export const liveExamples: readonly LiveExample[] = [
  {
    id: 'solo', persona: 'Solopreneurs', summary: 'Invoices and cash, kept current from your inbox.',
    title: 'Invoices and cash', kind: 'Spreadsheet', keeper: 'Books keeper', people: ['maya'], version: 8,
    signals: [
      { source: 'Gmail', text: 'Northwind: “Paid, thanks!”' },
      { source: 'Gmail', text: 'Signed contract from Acme' },
      { source: 'Calendar', text: 'Globex invoice due tomorrow' },
    ],
    columns: ['Client', 'Invoice', 'Status'],
    rows: [
      { cells: ['Northwind', '$4,200', { from: 'Sent', to: 'Paid', at: 1 }] },
      { cells: ['Globex', '$1,800', { from: 'Sent', to: 'Due tomorrow', at: 3 }] },
      { cells: ['Acme', '$6,500', 'Draft ready'], at: 2 },
    ],
    payoff: { noticed: '$10,700 came in this month. Globex is due tomorrow and has gone quiet.', did: 'Drafted a friendly reminder to Globex in Gmail', row: 1 },
  },
  {
    id: 'engineering', persona: 'Engineering teams', summary: 'A release board that tracks itself.',
    title: 'Release 4.2 readiness', kind: 'Document', keeper: 'Release keeper', people: ['maya', 'theo', 'priya', 'sam'], version: 21,
    signals: [
      { source: 'GitHub', text: 'PR #812 merged: billing export' },
      { source: 'Linear', text: 'ENG-340 closed: flaky upload' },
      { source: 'Slack', text: '#incidents: login latency up' },
    ],
    columns: ['Item', 'Owner', 'State'],
    rows: [
      { cells: ['Billing export', 'Theo', { from: 'In review', to: 'Merged', at: 1 }] },
      { cells: ['Fix flaky upload', 'Priya', { from: 'Blocker', to: 'Done', at: 2 }] },
      { cells: ['Login latency', 'On call', 'New risk'], at: 3 },
    ],
    payoff: { noticed: 'Everything for 4.2 is green except login latency, and nobody owns it yet.', did: 'Posted the go / no-go summary to #release', row: 2 },
  },
  {
    id: 'parents', persona: 'Parents', summary: 'School email turned into one ranked list both parents tick off.',
    title: 'This week at school', kind: 'Website', keeper: 'School inbox', people: ['maya', 'sam'], version: 14,
    signals: [
      { source: 'Gmail', text: 'Ms. Lee: field trip form due Thu' },
      { source: 'Gmail', text: 'PTA: bake sale sign-up' },
      { source: 'Gmail', text: 'Office: picture day moved to Fri' },
    ],
    columns: ['#', 'To do', 'Done by'],
    rows: [
      { cells: ['1', 'Sign field trip form (Thu)', '—'], at: 1 },
      { cells: ['2', 'Pay lunch account', { from: '—', to: '✓ Sam', at: 2 }] },
      { cells: ['3', 'Picture day, now Friday', '—'], at: 3 },
      { cells: ['4', 'Bake sale: pick a slot', '—'], at: 2 },
    ],
    payoff: { noticed: 'The field trip form is due tomorrow and neither of you has ticked it.', did: 'Sent you both a reminder for tonight', row: 0 },
  },
  {
    id: 'product', persona: 'Product managers', summary: 'Feedback themes ranked by what customers keep asking for.',
    title: 'What customers are asking for', kind: 'Document', keeper: 'Feedback keeper', people: ['priya', 'theo'], version: 33,
    signals: [
      { source: 'Granola', text: 'Call with Acme: bulk export again' },
      { source: 'Slack', text: '#feedback: “need SSO for pilot”' },
      { source: 'Linear', text: 'FEAT-91 opened: audit log' },
    ],
    columns: ['Theme', 'Mentions', 'Trend'],
    rows: [
      { cells: ['Bulk export', { from: '13', to: '14', at: 1 }, '↑'] },
      { cells: ['SSO', { from: '6', to: '7', at: 2 }, { from: '→', to: '↑', at: 2 }] },
      { cells: ['Audit log', '1', 'New'], at: 3 },
    ],
    payoff: { noticed: 'SSO came up in 3 of this week\'s 5 sales calls, all from accounts on a pilot.', did: 'Added SSO to Thursday\'s roadmap review', row: 1 },
  },
  {
    id: 'developer', persona: 'Developers on a team', summary: 'Your own review queue, across GitHub and Linear.',
    title: 'My queue', kind: 'Spreadsheet', keeper: 'Queue keeper', people: ['theo'], version: 52,
    signals: [
      { source: 'GitHub', text: 'Priya requested your review on #820' },
      { source: 'GitHub', text: 'Your PR #815 was approved' },
      { source: 'Linear', text: 'ENG-352 assigned to you' },
    ],
    columns: ['What', 'Where', 'Next'],
    rows: [
      { cells: ['Review #820', 'GitHub', 'Review today'], at: 1 },
      { cells: ['PR #815 search filters', 'GitHub', { from: 'Waiting', to: 'Merge it', at: 2 }] },
      { cells: ['ENG-352 rate limits', 'Linear', 'Start'], at: 3 },
    ],
    payoff: { noticed: 'Priya\'s #820 depends on your #815. Merge yours first and her review gets simpler.', did: 'Moved ‘Merge #815’ to the top of your queue', row: 1 },
  },
  {
    id: 'founder', persona: 'Founders', summary: 'The monthly investor update writes itself as the month happens.',
    title: 'November investor update', kind: 'Document', keeper: 'Update keeper', people: ['maya', 'priya'], version: 6,
    signals: [
      { source: 'Ashby', text: 'Offer accepted: senior engineer' },
      { source: 'GitHub', text: 'Release 4.2 published' },
      { source: 'Drive', text: 'Metrics sheet: revenue updated' },
    ],
    columns: ['Section', 'This month'],
    rows: [
      { cells: ['Hiring', { from: '2 open roles', to: '1 hire, 1 open role', at: 1 }] },
      { cells: ['Shipped', { from: 'Billing export (in review)', to: 'Release 4.2 with billing export', at: 2 }] },
      { cells: ['Revenue', { from: 'Waiting for numbers', to: '+18% month on month', at: 3 }] },
    ],
    payoff: { noticed: 'Every section is filled from this month\'s activity. It\'s ready to send.', did: 'Drafted the update to investors in Gmail', row: 2 },
  },
  {
    id: 'recruiter', persona: 'Agency recruiters', summary: 'Every client role and candidate, updated as replies come in.',
    title: 'Client roles · pipeline', kind: 'Spreadsheet', keeper: 'Pipeline keeper', people: ['priya', 'maya', 'sam'], version: 40,
    signals: [
      { source: 'Ashby', text: 'New applicant for Northwind PM' },
      { source: 'Gmail', text: 'Jordan: “Tuesday works”' },
      { source: 'Calendar', text: 'Final round booked: Lee' },
    ],
    columns: ['Candidate', 'Client role', 'Stage'],
    rows: [
      { cells: ['Ari Chen', 'Northwind PM', 'New'], at: 1 },
      { cells: ['Jordan Reyes', 'Acme design lead', { from: 'Outreach', to: 'Screen Tue', at: 2 }] },
      { cells: ['Lee Park', 'Globex EM', { from: 'Second round', to: 'Final Thu', at: 3 }] },
    ],
    payoff: { noticed: 'Lee\'s final round is Thursday and Globex hasn\'t confirmed the panel.', did: 'Drafted the confirmation to the Globex hiring manager', row: 2 },
  },
];

/** The step a signal's version and changes land on. */
const landsAt = (signal: number): number => signal * 2;

/** The step the payoff lands on: one after the last signal's version. */
const payoffAt = (example: LiveExample): number => landsAt(example.signals.length) + 1;

/** Throws if a change, a row or the payoff names something the example does not have. */
export function checkLiveExample(example: LiveExample): void {
  const count = example.signals.length;
  if (!example.rows[example.payoff.row]) throw new Error(`${example.id}: the payoff names row ${example.payoff.row + 1}, but there are ${example.rows.length}`);
  const check = (at: number, where: string): void => {
    if (!Number.isInteger(at) || at < 1 || at > count) throw new Error(`${example.id}: ${where} names signal ${at}, but there are ${count}`);
  };
  example.rows.forEach((row, index) => {
    if (row.at !== undefined) check(row.at, `row ${index + 1}`);
    if (row.cells.length !== example.columns.length) throw new Error(`${example.id}: row ${index + 1} has ${row.cells.length} cells for ${example.columns.length} columns`);
    row.cells.forEach((cell) => { if (typeof cell !== 'string') check(cell.at, `row ${index + 1}`); });
  });
}

function renderCell(cell: Cell): string {
  if (typeof cell === 'string') return `<span>${escapeHtml(cell)}</span>`;
  const step = landsAt(cell.at);
  return `<span class="changes"><i class="old" data-until="${step}">${escapeHtml(cell.from)}</i><i class="new" data-at="${step}">${escapeHtml(cell.to)}</i></span>`;
}

function renderSlide(example: LiveExample, index: number): string {
  checkLiveExample(example);
  const { id, title, kind, keeper, people, version, signals, columns, rows, payoff } = example;
  const last = payoffAt(example);
  const versions = signals.map((_, n) => {
    const at = landsAt(n + 1);
    const until = n + 1 < signals.length ? ` data-until="${landsAt(n + 2)}"` : '';
    return `<span data-at="${at}"${until}>Version ${version + n + 1}</span>`;
  }).join('');
  const feed = signals.map(({ source, text }, n) =>
    `<div class="ev" data-at="${n * 2 + 1}"><span class="src">${escapeHtml(source)}</span><div><b>${escapeHtml(text)}</b>`
    + `<i class="ver" data-at="${landsAt(n + 1)}">v${version + n + 1} · ${escapeHtml(keeper)}</i></div></div>`).join('')
    + `<div class="ev ev-did" data-at="${last}"><span class="src rally">Rally</span><div><b>${escapeHtml(payoff.did)}</b><i class="ver">done</i></div></div>`;
  const head = columns.map((column) => `<span class="th">${escapeHtml(column)}</span>`).join('');
  const body = rows.map((row, index) => {
    const added = row.at === undefined ? '' : ` data-at="${landsAt(row.at)}"`;
    const marked = index === payoff.row ? ` data-mark="${last}"` : '';
    return `<div class="row"${added}${marked}>${row.cells.map(renderCell).join('')}</div>`;
  }).join('');
  const faces = people.map((person) => `<b class="face ${person}">${initials[person]}</b>`).join('');
  const who = people.length === 1 ? 'Just you' : `${people.length} people`;
  return `<div class="lc-slide" id="lc-${id}" role="tabpanel" aria-labelledby="lc-tab-${id}" data-steps="${last}"${index === 0 ? '' : ' hidden'}>`
    + `<div class="win" aria-hidden="true">`
    + `<div class="win-bar"><span class="win-dots"><i></i><i></i><i></i></span><span class="win-pill"><span class="glyph"></span>${escapeHtml(title)}</span>`
    + `<span class="win-live"><i></i>Live · kept by ${escapeHtml(keeper)}</span><span class="win-faces" title="${who}">${faces}</span></div>`
    + `<div class="win-body"><div class="feed"><p class="feed-head">What changed it</p>${feed}</div>`
    + `<div class="doc"><div class="doc-head"><span>${kind}</span><span class="doc-ver"><span data-until="2">Version ${version}</span>${versions}</span></div>`
    + `<h4>${escapeHtml(title)}</h4><div class="sheet${columns[0] === '#' ? ' ranked' : ''}" data-columns="${columns.length}"><div class="row head">${head}</div>${body}</div>`
    + `<div class="payoff" data-at="${last}"><span class="payoff-label">Rally noticed</span><p>${escapeHtml(payoff.noticed)}</p></div></div></div></div>`
    + `<p class="visually-hidden">${escapeHtml(describe(example))}</p></div>`;
}

/** A plain description of the example, for assistive technology. */
export function describe({ title, keeper, signals, version, people, payoff }: LiveExample): string {
  const steps = signals.map(({ source, text }, n) => `${source}: ${text}, which publishes version ${version + n + 1}`).join('; ');
  const who = people.length === 1 ? 'one person' : `${people.length} people`;
  return `A live Canvas named ${title}, used by ${who} and kept current by the ${keeper} Sidekick. ${steps}. Then Rally notices: ${payoff.noticed} ${payoff.did}.`;
}

/** The hero carousel: a tab per example and a slide per example. */
export function renderLiveCarousel(examples: readonly LiveExample[] = liveExamples): string {
  const tabs = examples.map(({ id, persona }, index) =>
    `<button class="lc-tab" type="button" role="tab" id="lc-tab-${id}" aria-controls="lc-${id}" aria-selected="${index === 0}" tabindex="${index === 0 ? 0 : -1}">`
    + `<span>${escapeHtml(persona)}</span><i class="lc-progress" aria-hidden="true"></i></button>`).join('');
  const summaries = examples.map(({ id, summary }, index) =>
    `<p class="lc-summary" data-for="lc-${id}"${index === 0 ? '' : ' hidden'}>${escapeHtml(summary)}</p>`).join('');
  return `<section class="stage lc" data-live-carousel aria-roledescription="carousel" aria-label="Live Canvas examples">`
    + `<div class="lc-tabs" role="tablist" aria-label="Who it is for">${tabs}</div>`
    + `<div class="lc-summaries">${summaries}</div>`
    + examples.map(renderSlide).join('')
    + `<p class="stage-caption"><span aria-hidden="true">Signals from your tools · a new version each time</span><button class="lc-pause" type="button" hidden>Pause</button></p>`
    + `</section>`;
}
