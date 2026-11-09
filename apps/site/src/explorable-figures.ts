/**
 * The two explorable figures on the home page, rendered to SVG at build time
 * (Node only) and driven in the browser by `explorables.ts`. Geometry lives
 * here and only here; the client moves things along it.
 *
 * - `renderLoopFigure`: events in three tools travel into a Sidekick, which
 *   publishes a new version of a Canvas. A time slider scrubs the whole story.
 * - `renderPeopleFigure`: one Canvas, and a slider that adds people around it.
 *
 * Without a script each shows a finished state: every version published, and
 * three people in the Canvas.
 */

/** When each event leaves its tool, in seconds, and how long the loop runs. */
export const LOOP = { events: [1, 5, 9], length: 13 } as const;

const TOOLS = [
  { tool: 'Linear', text: 'PRI-142 moved to Done', read: 'Reading PRI-142' },
  { tool: 'Slack · #launch', text: '“Launch moves to Tuesday”', read: 'Reading #launch' },
  { tool: 'Granola', text: 'Launch sync notes ready', read: 'Reading the notes' },
] as const;

const VERSIONS = [
  { v: 3, date: 'Monday', pricing: 'In review', decision: 'Decisions: none yet', changed: -1 },
  { v: 4, date: 'Monday', pricing: 'Done', decision: 'Decisions: none yet', changed: 1 },
  { v: 5, date: 'Tuesday', pricing: 'Done', decision: 'Decisions: none yet', changed: 0 },
  { v: 6, date: 'Tuesday', pricing: 'Done', decision: 'Lead with teamwork', changed: 2 },
] as const;

const TOOL_Y = [92, 212, 332] as const;
const HEX = { x: 500, y: 212, r: 54 } as const;
const CARD = { x: 744, y: 92, w: 220, h: 240 } as const;
const TIMELINE = { y: 420, x0: 60, x1: 940 } as const;

const hexPoints = (cx: number, cy: number, r: number): string =>
  Array.from({ length: 6 }, (_, i) => {
    const angle = (Math.PI / 3) * i - Math.PI / 2;
    return `${(cx + r * Math.cos(angle)).toFixed(1)},${(cy + r * Math.sin(angle)).toFixed(1)}`;
  }).join(' ');

function versionCard(version: (typeof VERSIONS)[number], index: number): string {
  const { x, y, w } = CARD;
  const lines = [`Launch day: ${version.date}`, `Pricing page: ${version.pricing}`, version.decision];
  const rows = lines.map((line, row) => {
    const ry = y + 92 + row * 40;
    const mark = version.changed === row
      ? `<rect class="loop-changed" x="${x + 12}" y="${ry - 20}" width="${w - 24}" height="30" rx="4"/>` : '';
    return `${mark}<text class="loop-row" x="${x + 22}" y="${ry}">${line}</text>`;
  }).join('');
  return `<g class="loop-version" data-version="${index}">`
    + `<rect class="loop-card" x="${x}" y="${y}" width="${w}" height="${CARD.h}" rx="10"/>`
    + `<text class="loop-card-kind" x="${x + 22}" y="${y + 30}">Document</text>`
    + `<rect class="loop-card-badge" x="${x + w - 58}" y="${y + 14}" width="40" height="22" rx="5"/>`
    + `<text class="loop-card-v" x="${x + w - 38}" y="${y + 30}" text-anchor="middle">v${version.v}</text>`
    + `<text class="loop-card-title" x="${x + 22}" y="${y + 62}">Launch tracker</text>${rows}</g>`;
}

export function renderLoopFigure(): string {
  const tools = TOOLS.map(({ tool, text }, i) => {
    const y = TOOL_Y[i]!;
    return `<g class="loop-tool" data-tool="${i}"><rect x="20" y="${y - 34}" width="220" height="68" rx="10"/>`
      + `<text class="loop-tool-name" x="40" y="${y - 6}">${tool}</text><text class="loop-tool-text" x="40" y="${y + 18}">${text}</text></g>`;
  }).join('');
  const wiresIn = TOOL_Y.map((y, i) =>
    `<path class="loop-wire" id="loop-in-${i}" d="M240,${y} C360,${y} 360,${HEX.y} ${HEX.x - HEX.r},${HEX.y}"/>`).join('');
  const wireOut = `<path class="loop-wire" id="loop-out" d="M${HEX.x + HEX.r},${HEX.y} L${CARD.x},${HEX.y}"/>`;
  const { x0, x1, y } = TIMELINE;
  const at = (time: number): number => x0 + ((x1 - x0) * time) / LOOP.length;
  const ticks = LOOP.events.map((time, i) =>
    `<g class="loop-tick" data-tool="${i}"><line x1="${at(time)}" x2="${at(time)}" y1="${y - 8}" y2="${y + 8}"/>`
    + `<text x="${at(time)}" y="${y + 28}" text-anchor="middle">${TOOLS[i]!.tool.split(' ')[0]}</text></g>`).join('');
  const description = 'A Linear issue closing, a Slack message and a meeting note each travel into the Launch tracker Sidekick,'
    + ' which reads the event and publishes a new version of the Launch tracker Canvas: version 4, then 5, then 6.';
  return `<figure class="explorable loop" data-loop data-events="${LOOP.events.join(',')}" data-length="${LOOP.length}">`
    + `<svg class="explorable-svg" viewBox="0 0 1000 460" role="img" aria-label="${description}">`
    + `${wiresIn}${wireOut}${tools}`
    + `<g class="loop-hex"><polygon points="${hexPoints(HEX.x, HEX.y, HEX.r)}"/>`
    + `<image href="/brand/rally-mark-paper.svg" x="${HEX.x - 22}" y="${HEX.y - 22}" width="44" height="44"/></g>`
    + `<text class="loop-hex-name" x="${HEX.x}" y="${HEX.y + HEX.r + 28}" text-anchor="middle">Launch tracker · Sidekick</text>`
    + `<text class="loop-status" x="${HEX.x}" y="${HEX.y - HEX.r - 24}" text-anchor="middle" data-loop-status>v6 published · waiting</text>`
    + `${VERSIONS.map(versionCard).join('')}`
    + `<circle class="loop-pulse" r="7" cx="-20" cy="-20" data-loop-pulse/>`
    + `<line class="loop-axis" x1="${x0}" x2="${x1}" y1="${y}" y2="${y}"/>${ticks}`
    + `<line class="loop-head" x1="${x1}" x2="${x1}" y1="${y - 14}" y2="${y + 14}" data-loop-head/></svg>`
    + `<div class="explorable-controls"><button class="explorable-play" type="button" data-loop-play aria-label="Play">`
    + `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path class="icon-play" d="M4 2.5v11l9-5.5z"/><path class="icon-pause" d="M4 2.5h3v11H4zM9 2.5h3v11H9z"/></svg></button>`
    + `<input class="explorable-range" type="range" min="0" max="${LOOP.length}" step="0.01" value="${LOOP.length}" aria-label="Time" data-loop-range>`
    + `<output class="explorable-readout" data-loop-readout>${LOOP.length.toFixed(1)} s</output></div>`
    + `<figcaption class="fig-caption"><span></span>Drag the slider to move through time. Each event travels to the Sidekick, which reads it and publishes the next version of the same Canvas. Older versions stay in the stack.</figcaption></figure>`;
}

/** Places for people around the Canvas: an inner ring of 12, then an outer ring. */
export const PEOPLE = { max: 40, start: 3 } as const;

function seat(index: number): { x: number; y: number } {
  const inner = index < 12;
  const count = inner ? 12 : PEOPLE.max - 12;
  const slot = inner ? index : index - 12;
  // Start at the top left and go round, offset per ring so the rings interleave.
  const angle = -Math.PI / 2 - 0.35 + (2 * Math.PI * slot) / count + (inner ? 0 : Math.PI / count);
  const [rx, ry] = inner ? [250, 140] : [400, 176];
  return { x: 500 + rx * Math.cos(angle), y: 210 + ry * Math.sin(angle) };
}

const CAST = [['maya', 'M'], ['theo', 'T'], ['priya', 'P']] as const;

export function renderPeopleFigure(): string {
  const people = Array.from({ length: PEOPLE.max }, (_, i) => {
    const { x, y } = seat(i);
    const [cls, initial] = CAST[i] ?? ['other', ''];
    const on = i < PEOPLE.start ? ' is-on' : '';
    return `<g class="person person-${cls}${on}" data-person="${i}">`
      + `<line class="person-link" x1="${x.toFixed(1)}" y1="${y.toFixed(1)}" x2="500" y2="210"/>`
      + `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${i < 12 ? 15 : 11}"/>`
      + (initial ? `<text x="${x.toFixed(1)}" y="${(y + 4.5).toFixed(1)}" text-anchor="middle">${initial}</text>` : '')
      + '</g>';
  }).join('');
  return `<figure class="explorable people-fig" data-people data-max="${PEOPLE.max}">`
    + `<div class="people-grid"><svg class="explorable-svg" viewBox="0 0 1000 420" role="img" aria-label="One Canvas in the middle with people around it, each linked to the same page. A slider adds people, from one to forty.">`
    + `${people}<g class="people-canvas"><rect x="420" y="120" width="160" height="180" rx="10"/>`
    + `<text class="people-canvas-title" x="440" y="156">Launch tracker</text>`
    + `<rect class="people-line" x="440" y="176" width="120" height="7" rx="2"/><rect class="people-line" x="440" y="194" width="96" height="7" rx="2"/>`
    + `<rect class="people-line" x="440" y="212" width="110" height="7" rx="2"/><rect class="people-line is-accent" x="440" y="230" width="70" height="7" rx="2"/>`
    + `<circle class="people-rally" cx="560" cy="280" r="13"/><image href="/brand/rally-mark-paper.svg" x="551" y="271" width="18" height="18"/></g></svg>`
    + `<dl class="people-stats"><div><dt>People in the Canvas</dt><dd data-people-count>${PEOPLE.start}</dd></div>`
    + `<div><dt>Share setting</dt><dd data-people-label>Specific people</dd></div>`
    + `<div><dt>Copies of the page</dt><dd>1</dd></div><div><dt>Seats to buy</dt><dd>None</dd></div></dl></div>`
    + `<div class="explorable-controls"><label class="explorable-label" for="people-range">People</label>`
    + `<input class="explorable-range" id="people-range" type="range" min="1" max="${PEOPLE.max}" step="1" value="${PEOPLE.start}" data-people-range></div>`
    + `<figcaption class="fig-caption"><span></span>Drag to add people. However many join, there is one page, one Chat and one Rally, and nobody&rsquo;s copy goes out of date. The share setting is the one the Canvas&rsquo;s Share menu would show.</figcaption></figure>`;
}
