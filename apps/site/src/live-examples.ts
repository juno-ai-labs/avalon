/**
 * The hero carousel: one live artifact for each kind of person Rally is for.
 * Each example is data, rendered to HTML at build time (Node only) by
 * `renderLiveCarousel`, and played in the browser by `live-carousel.ts`.
 *
 * A slide plays four steps. Steps 1 to 3 are events in connected tools; each
 * one publishes a new version of the artifact, adding a row (`at`) or ticking
 * one off (`done`, by `rally` when an event did it). Step 4 is a person acting
 * on the page, ticking a row they own (`done: 4, by: <person>`).
 *
 * Every event is one a Sidekick can be started by (docs: help/03-sidekicks/
 * 04-triggers-and-schedules.md): a GitHub, Linear, Slack, Granola or Ashby
 * event, an email that meets a condition, or a schedule.
 */
import { escapeHtml as escape } from './comparison-pages';

type Person = 'maya' | 'theo' | 'priya' | 'guest' | 'rally';

interface Row {
  readonly text: string;
  readonly meta: string;
  /** The step the row arrives at; 0 means it was already there. */
  readonly at: number;
  /** The step the row is ticked off at, and who ticked it. */
  readonly done?: number;
  readonly by?: Person;
  /** A tick that approves rather than finishes: the row stays at full strength. */
  readonly approve?: boolean;
}

export interface LiveExample {
  readonly id: string;
  readonly who: string;
  readonly title: string;
  /**
   * Always a Site: a person ticks rows, and nobody types into a Canvas
   * directly. A live site that remembers things takes visitors' entries, and
   * a Sidekick's runs write rows into it (help/06-things-rally-makes/03-live-sites.md).
   */
  readonly kind: 'Site';
  readonly text: string;
  readonly sidekick: string;
  readonly reads: string;
  readonly audience: string;
  readonly people: readonly Person[];
  /** The version before the first event. */
  readonly version: number;
  readonly events: readonly [Event, Event, Event];
  readonly rows: readonly Row[];
  /** The artifact's headline at each step, 0 to 4; `!` before a line marks it as a warning. */
  readonly status: readonly [string, string, string, string, string];
  /** The moment the slide builds to, shown at step 4: a short big claim and its sentence. */
  readonly gotcha: { readonly big: string; readonly text: string };
}

interface Event { readonly tool: string; readonly text: string }

export const liveExamples: readonly LiveExample[] = [
  {
    id: 'solo', who: 'Solopreneurs', title: 'Client pipeline', kind: 'Site',
    text: 'Every signed proposal, new lead and client call moves your pipeline, so the day starts with what to do next.',
    sidekick: 'Pipeline', reads: 'Gmail · Granola', audience: 'Only you', people: ['maya'], version: 11,
    events: [
      { tool: 'Gmail', text: 'Northwind: “Signed. Let’s start Monday.”' },
      { tool: 'Gmail', text: 'Lumen: “Could we talk Thursday at 10?”' },
      { tool: 'Granola', text: 'Notes from the Acme call are ready' },
    ],
    rows: [
      { text: 'Send Acme the revised quote', meta: 'From the call', at: 3 },
      { text: 'Kick off Northwind', meta: 'Signed · Mon', at: 1 },
      { text: 'Reply to Lumen about Thursday', meta: 'New lead', at: 2 },
      { text: 'Invoice Bramble for October', meta: 'Due Fri', at: 0 },
      { text: 'Follow up with Orchard', meta: 'Quiet 9 days', at: 0, done: 4, by: 'maya' },
    ],
    status: ['Up next: invoice Bramble', 'Up next: kick off Northwind', 'Up next: reply to Lumen', 'Up next: send Acme the quote', 'Up next: send Acme the quote'],
    gotcha: { big: '0 typed', text: 'Two emails and a call moved your pipeline. You didn’t copy a thing into it.' },
  },
  {
    id: 'engineering', who: 'Engineering teams', title: 'Release readiness', kind: 'Site',
    text: 'Merged pull requests, reopened issues and finished checks land on one page the whole team reads before shipping.',
    sidekick: 'Release check', reads: 'GitHub · Linear', audience: 'Specific people · 6', people: ['maya', 'theo', 'priya'], version: 21,
    events: [
      { tool: 'GitHub', text: '#482 “Rate limits for the export API” merged' },
      { tool: 'Linear', text: 'ENG-311 reopened: export times out on large files' },
      { tool: 'GitHub', text: 'Checks passed on main, build 1,284' },
    ],
    rows: [
      { text: 'ENG-311 Export times out on large files', meta: 'Reopened · blocks release', at: 2 },
      { text: 'Rate limits for the export API', meta: '#482', at: 0, done: 1, by: 'rally' },
      { text: 'Checks on main', meta: 'Build 1,284', at: 0, done: 3, by: 'rally' },
      { text: 'Docs for the new limits', meta: 'Priya', at: 0, done: 4, by: 'priya' },
      { text: 'Release notes', meta: 'Theo', at: 0 },
    ],
    status: ['Ready to ship', 'Ready to ship', '!Blocked by ENG-311', '!Blocked by ENG-311 · checks green', '!Blocked by ENG-311 · docs done'],
    gotcha: { big: 'Blocked', text: 'The release page changed itself when ENG-311 reopened. Nobody had to notice first.' },
  },
  {
    id: 'parents', who: 'Parents', title: 'School this week', kind: 'Site',
    text: 'Rally reads every email from school, ranks what needs doing by when, and both parents tick things off on the same list.',
    sidekick: 'School inbox', reads: 'Gmail', audience: 'Specific people · 2', people: ['maya', 'theo'], version: 7,
    events: [
      { tool: 'Gmail', text: 'Ms. Lee: field trip form due Friday' },
      { tool: 'Gmail', text: 'PTA: bake sale Saturday, 12 cupcakes a family' },
      { tool: 'Gmail', text: 'Coach: Wednesday practice moves to 4:30' },
    ],
    rows: [
      { text: 'Pick-up moves to 4:30 on Wednesday', meta: 'Wed · Coach', at: 3, done: 4, by: 'theo' },
      { text: 'Sign the field trip form', meta: 'Fri · Ms. Lee', at: 1, done: 4, by: 'maya' },
      { text: 'Bake 12 cupcakes', meta: 'Sat · PTA', at: 2 },
      { text: 'Library books back', meta: 'Thu', at: 0 },
      { text: 'Picture day money', meta: 'Paid', at: 0, done: 0, by: 'theo' },
    ],
    status: ['2 things this week', '3 things · form due Friday', '4 things this week', '5 things · pick-up time changed', '3 left · 2 done between you'],
    gotcha: { big: '2 parents', text: 'One list. Theo ticked pick-up, Maya ticked the form, and nobody forwarded an email.' },
  },
  {
    id: 'product', who: 'Product managers', title: 'What customers ask for', kind: 'Site',
    text: 'Customer calls and #feedback threads become one ranked list of asks, and shipped work drops off on its own.',
    sidekick: 'Feedback', reads: 'Granola · Slack · Linear', audience: 'Organization', people: ['maya', 'theo', 'priya'], version: 33,
    events: [
      { tool: 'Granola', text: 'Acme call: “We need SSO before we roll out.”' },
      { tool: 'Slack · #feedback', text: 'Two more teams ask for bulk export' },
      { tool: 'Linear', text: 'Dark mode moved to Done' },
    ],
    rows: [
      { text: 'Bulk export', meta: '6 teams asked', at: 2 },
      { text: 'SSO for larger teams', meta: '4 customers, newest Acme', at: 1 },
      { text: 'Slack notifications', meta: '3 teams asked · Priya on it', at: 0, done: 4, by: 'priya', approve: true },
      { text: 'Dark mode', meta: 'Shipped', at: 0, done: 3, by: 'rally' },
      { text: 'Audit log', meta: '2 customers', at: 0 },
    ],
    status: ['5 asks tracked', 'SSO joins at #2', 'Bulk export now #1', 'Dark mode shipped', 'Priya took notifications'],
    gotcha: { big: '1 call', text: 'put SSO on the list with who asked. Every ask is counted and ranked as it comes in.' },
  },
  {
    id: 'developers', who: 'Developers on a team', title: 'My queue', kind: 'Site',
    text: 'Review requests, assigned issues and questions that name you, ranked into one queue only you see.',
    sidekick: 'My queue', reads: 'GitHub · Linear · Slack', audience: 'Only you', people: ['theo'], version: 4,
    events: [
      { tool: 'GitHub', text: 'Priya asked you to review #519 “Retry webhooks”' },
      { tool: 'Linear', text: 'ENG-402 assigned to you · High' },
      { tool: 'Slack · #api', text: 'Maya: “@Theo is the migration safe to run?”' },
    ],
    rows: [
      { text: 'Answer Maya in #api', meta: 'Waiting', at: 3 },
      { text: 'Review #519 Retry webhooks', meta: 'From Priya', at: 1, done: 4, by: 'theo' },
      { text: 'ENG-402 Cache misses on login', meta: 'High', at: 2 },
      { text: 'Finish #507 Search index', meta: 'Your pull request', at: 0 },
    ],
    status: ['1 thing on your plate', 'A review is waiting', '2 waiting on you', 'Maya is waiting: answer first', '2 left'],
    gotcha: { big: '#1', text: 'A teammate waiting on you goes to the top, without you checking Slack.' },
  },
  {
    id: 'founders', who: 'Founders', title: 'November investor update', kind: 'Site',
    text: 'Revenue, shipped work and warm intros collect into next month’s update as they happen, ready for your cofounder to edit.',
    sidekick: 'Investor update', reads: 'Google Drive · Linear · Gmail', audience: 'Specific people · 2', people: ['maya', 'theo'], version: 2,
    events: [
      { tool: 'Schedule · 1st of the month', text: 'Read October from the metrics sheet' },
      { tool: 'Linear', text: 'SSO, bulk export and audit log completed' },
      { tool: 'Gmail', text: 'Dana introduced you to Ravi at Northstar Capital' },
    ],
    rows: [
      { text: 'Revenue: $48.2k a month, up 12%', meta: 'Metrics sheet', at: 1 },
      { text: 'Shipped: SSO, bulk export, audit log', meta: 'Linear', at: 2 },
      { text: 'New conversations: Northstar Capital', meta: 'Intro from Dana', at: 3 },
      { text: 'Hiring: two engineers', meta: 'Theo', at: 0, done: 4, by: 'theo', approve: true },
    ],
    status: ['Draft · 1 of 4 sections', 'Draft · 2 of 4 sections', 'Draft · 3 of 4 sections', 'Draft · 4 of 4 · ready to send', 'Reviewed by Theo · ready to send'],
    gotcha: { big: '4 of 4', text: 'sections written as the month happened. The update was done before you sat down to write it.' },
  },
  {
    id: 'recruiters', who: 'Agency recruiters', title: 'Shortlist: Senior designer, Northwind', kind: 'Site',
    text: 'Stage changes, interviews and notes move candidates up the shortlist, and the client ticks who to advance as a guest.',
    sidekick: 'Shortlist', reads: 'Ashby · Granola', audience: 'Specific people · 3, 1 guest', people: ['maya', 'priya', 'guest'], version: 9,
    events: [
      { tool: 'Ashby', text: 'Ana Ruiz moved to Onsite' },
      { tool: 'Ashby', text: 'Interview scheduled: Jon Park, Fri 11:00' },
      { tool: 'Granola', text: 'Interview notes ready: Lee Chen' },
    ],
    rows: [
      { text: 'Lee Chen', meta: 'Strong portfolio · advance?', at: 3, done: 4, by: 'guest', approve: true },
      { text: 'Ana Ruiz', meta: 'Onsite', at: 1 },
      { text: 'Jon Park', meta: 'Interview Fri 11:00', at: 2 },
      { text: 'Sam Ito', meta: 'Sourced · no reply yet', at: 0 },
    ],
    status: ['4 candidates', 'Ana Ruiz at onsite', 'Jon Park interview booked', 'Lee Chen notes in · now #1', 'Northwind advanced Lee Chen'],
    gotcha: { big: '1 tick', text: 'from the client, as a guest on the shortlist. No email thread, no spreadsheet sent back and forth.' },
  },
];

const FACES: Record<Person, { initial: string; label: string }> = {
  maya: { initial: 'M', label: 'Maya' },
  theo: { initial: 'T', label: 'Theo' },
  priya: { initial: 'P', label: 'Priya' },
  guest: { initial: 'N', label: 'Northwind, a guest' },
  rally: { initial: '', label: 'the Sidekick' },
};

const face = (person: Person): string => `<i class="face face-${person}">${FACES[person].initial}</i>`;

function renderRow(row: Row): string {
  const done = row.done === undefined ? '' : ` data-done="${row.done}"`;
  const by = row.by ? `<span class="live-by">${face(row.by)}</span>` : '';
  const tick = row.done === undefined ? '' : '<svg class="live-tick" viewBox="0 0 16 16" width="16" height="16"><path d="M3.5 8.5l3 3 6-7"/></svg>';
  // Rendered in the slide's finished state (arrived, ticked); live-carousel.ts rewinds it when it plays.
  const state = `${row.approve ? ' is-approve' : ''} is-on${row.done === undefined ? '' : ' is-done'}`;
  return `<li class="live-row${state}" data-at="${row.at}"${done}><span class="live-rank"></span>`
    + `<span class="live-text">${escape(row.text)}<small>${escape(row.meta)}</small></span>`
    + `<span class="live-check">${tick}${by}</span></li>`;
}

function renderSlide(example: LiveExample, index: number): string {
  const { id, who, title, kind, text, sidekick, reads, audience, people, version, events, rows, status, gotcha } = example;
  const statuses = status.map((line, step) => {
    const warn = line.startsWith('!');
    const current = step === status.length - 1 ? ' is-current' : '';
    return `<span class="live-status-line${warn ? ' is-warn' : ''}${current}" data-status="${step}">${escape(warn ? line.slice(1) : line)}</span>`;
  }).join('');
  // Without a script every slide shows its last step: the final version and every row.
  const last = version + events.length;
  const signals = events.map(({ tool, text: event }, step) =>
    `<li class="signal is-on" data-at="${step + 1}"><span class="signal-tool">${escape(tool)}</span>${escape(event)}</li>`).join('');
  return `<div class="slide${index === 0 ? ' is-active' : ''}" id="slide-${id}" role="tabpanel" aria-labelledby="tab-${id}" data-slide data-step="4" data-version="${version}"${index === 0 ? '' : ' hidden'}>`
    + `<div class="slide-copy"><p class="slide-who">For ${escape(who.toLowerCase())}</p>`
    + `<h2 class="slide-title">${escape(title)}</h2><p class="slide-text">${escape(text)}</p>`
    + `<dl class="slide-meta"><div><dt>Kept current by</dt><dd>${escape(sidekick)} &middot; Sidekick</dd></div>`
    + `<div><dt>Reads</dt><dd>${escape(reads)}</dd></div><div><dt>Shared with</dt><dd>${escape(audience)}</dd></div></dl></div>`
    + `<div class="slide-art" aria-hidden="true"><ol class="signals"><li class="signals-label">In your tools</li>${signals}</ol>`
    + `<div class="live-sheet"><div class="live-head"><span class="live-kind">${kind}</span>`
    + `<span class="live-people">${people.map(face).join('')}${face('rally')}</span>`
    + `<span class="live-version" data-live-version>v${last}</span></div>`
    + `<p class="live-title">${escape(title)}</p><p class="live-byline" data-live-byline>Updated by ${escape(sidekick)} &middot; after ${escape(events[2].tool)}</p>`
    + `<p class="live-status">${statuses}</p>`
    + `<ol class="live-list">${rows.map(renderRow).join('')}</ol>`
    + `<p class="gotcha is-on" data-at="4"><b>${escape(gotcha.big)}</b><span>${escape(gotcha.text)}</span></p></div></div></div>`;
}

/** The hero carousel: a tab per audience, a slide per live artifact. */
export function renderLiveCarousel(): string {
  const tabs = liveExamples.map(({ id, who }, index) =>
    `<button class="carousel-tab" type="button" role="tab" id="tab-${id}" aria-controls="slide-${id}" aria-selected="${index === 0}"${index === 0 ? '' : ' tabindex="-1"'}>`
    + `<span>${escape(who)}</span><i class="carousel-progress" aria-hidden="true"></i></button>`).join('');
  return `<figure class="carousel" data-carousel aria-roledescription="carousel" aria-label="Live artifacts, one for each kind of person">`
    + `<div class="carousel-bar"><div class="carousel-tabs" role="tablist" aria-label="Who it is for">${tabs}</div>`
    + `<button class="carousel-pause" type="button" data-carousel-pause aria-label="Pause the examples" aria-pressed="false" hidden>`
    + `<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path class="icon-pause" d="M4 2.5h3v11H4zM9 2.5h3v11H9z"/><path class="icon-play" d="M4 2.5v11l9-5.5z"/></svg></button></div>`
    + `<div class="carousel-slides">${liveExamples.map(renderSlide).join('')}</div>`
    + `<figcaption class="fig-caption"><span></span>Seven live artifacts. In each, a Sidekick reads events in connected tools and publishes a new version; then a person ticks off what they own. Pick one, or let them play.</figcaption></figure>`;
}
