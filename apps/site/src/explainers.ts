/**
 * The site's two interactive explainers, drawn from `explainer-math.ts`:
 *
 * - `[data-explainer="live"]`: a day in a live Canvas. The time slider is the
 *   only state; every dot, the version and the caption are recomputed from
 *   it, so scrubbing backwards is as exact as playing forwards. It plays by
 *   itself while on screen until the visitor touches a control, and never with
 *   reduced motion.
 * - `[data-explainer="team"]`: one Canvas at any team size. The people slider
 *   redraws both networks and the cost-per-person chart.
 *
 * Without script each figure shows its static drawing and its caption.
 */
import { DAY, SOURCES, clock, latestAt, pairs, phaseAt, planFor, pricePerPerson, publishes, versionAt, type DayEvent } from './explainer-math';

const SVG = 'http://www.w3.org/2000/svg';
const MINUTES_PER_FRAME = 1.2;
const RULER = { from: 24, to: 936 };

function svg<K extends keyof SVGElementTagNameMap>(name: K, attributes: Record<string, string | number>, parent: Element): SVGElementTagNameMap[K] {
  const element = document.createElementNS(SVG, name);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
  parent.append(element);
  return element;
}

const ease = (t: number): number => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);

function liveExplainer(figure: HTMLElement): void {
  const range = figure.querySelector<HTMLInputElement>('.ex-time');
  const output = figure.querySelector<HTMLOutputElement>('.ex-clock');
  const filter = figure.querySelector<HTMLInputElement>('.ex-filter');
  const play = figure.querySelector<HTMLButtonElement>('.ex-play');
  const caption = figure.querySelector<HTMLElement>('.ex-caption');
  const dots = figure.querySelector('.ex-dots');
  const ticks = figure.querySelector('.ex-ticks');
  const head = figure.querySelector('#ex-head');
  const version = figure.querySelector('#ex-ver');
  const canvas = figure.querySelector('.ex-canvas');
  const out = figure.querySelector<SVGPathElement>('#ex-w-out');
  const drop = figure.querySelector<SVGPathElement>('#ex-w-drop');
  if (!range || !output || !filter || !play || !caption || !dots || !ticks || !head || !version || !canvas || !out || !drop) return;
  const wires = new Map(SOURCES.map((source) => [source, figure.querySelector<SVGPathElement>(`#ex-w-${source}`)]));
  const x = (minute: number): number => RULER.from + (minute / 1440) * (RULER.to - RULER.from);

  const tickMarks = DAY.map((event) => svg('circle', { cx: x(event.minute), cy: 368, r: 5, class: `tick src-${event.source}` }, ticks));
  const markers = DAY.map((event) => svg('circle', { r: 7, class: `dot src-${event.source}` }, dots));

  const point = (path: SVGPathElement, progress: number): DOMPoint =>
    path.getPointAtLength(path.getTotalLength() * ease(Math.min(1, Math.max(0, progress))));

  const draw = (): void => {
    const minute = Number(range.value);
    const filtered = filter.checked;
    output.value = clock(minute);
    head.setAttribute('x1', String(x(minute)));
    head.setAttribute('x2', String(x(minute)));
    DAY.forEach((event, index) => {
      const dot = markers[index];
      const tick = tickMarks[index];
      if (!dot || !tick) return;
      tick.classList.toggle('muted', !publishes(event, filtered));
      const phase = phaseAt(event, minute, filtered);
      let at: DOMPoint | undefined;
      let opacity = 1;
      if (phase.kind === 'inbound') { const wire = wires.get(event.source); if (wire) at = point(wire, phase.progress); }
      else if (phase.kind === 'outbound') at = point(out, phase.progress);
      else if (phase.kind === 'dropped') { at = point(drop, phase.progress); opacity = 1 - phase.progress; }
      dot.classList.toggle('dropping', phase.kind === 'dropped');
      if (!at) { dot.setAttribute('opacity', '0'); return; }
      dot.setAttribute('cx', String(at.x));
      dot.setAttribute('cy', String(at.y));
      dot.setAttribute('opacity', String(opacity));
    });
    const current = versionAt(minute, filtered);
    version.textContent = `v${current}`;
    canvas.setAttribute('data-depth', String(Math.min(3, current - 1)));
    canvas.classList.toggle('bump', DAY.some((event) => publishes(event, filtered) && minute - event.minute >= 60 && minute - event.minute < 72));
    caption.textContent = describeMoment(latestAt(minute), minute, filtered, current);
  };

  let frame = 0;
  let playing = false;
  const setPlaying = (on: boolean): void => {
    playing = on;
    play.textContent = on ? 'Pause' : 'Play';
    play.setAttribute('aria-pressed', String(on));
    cancelAnimationFrame(frame);
    if (on) frame = requestAnimationFrame(tick);
  };
  const tick = (): void => {
    const next = Number(range.value) + MINUTES_PER_FRAME;
    range.value = String(next >= 1439 ? 0 : next);
    draw();
    if (playing) frame = requestAnimationFrame(tick);
  };

  // A visitor who touches a control takes over: autoplay never resumes.
  let touched = false;
  const takeOver = (): void => { touched = true; };
  range.addEventListener('input', () => { takeOver(); setPlaying(false); draw(); });
  filter.addEventListener('change', () => { takeOver(); draw(); });
  play.addEventListener('click', () => { takeOver(); setPlaying(!playing); });

  if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
    range.value = '400';
    new IntersectionObserver(([entry]) => {
      if (touched) return;
      setPlaying(entry?.isIntersecting ?? false);
    }, { threshold: 0.4 }).observe(figure);
  }
  draw();
}

function describeMoment(event: DayEvent | undefined, minute: number, filtered: boolean, version: number): string {
  if (!event) return `${clock(minute)}. Nothing yet today. The Canvas is on version ${version}.`;
  const verdict = publishes(event, filtered)
    ? (minute - event.minute >= 60 ? `published version ${version}` : 'on its way to the Canvas')
    : 'ignored: it doesn’t match the Sidekick’s condition';
  return `${clock(event.minute)} · ${event.source}: ${event.text}, ${verdict}.`;
}

function ring(count: number, cx: number, cy: number, radius: number): { x: number; y: number }[] {
  return Array.from({ length: count }, (_, index) => {
    const angle = (index / count) * Math.PI * 2 - Math.PI / 2;
    return count === 1 ? { x: cx, y: cy - radius } : { x: cx + Math.cos(angle) * radius, y: cy + Math.sin(angle) * radius };
  });
}

const PERSON_CLASSES = ['maya', 'theo', 'priya', 'sam'];

function teamExplainer(figure: HTMLElement): void {
  const range = figure.querySelector<HTMLInputElement>('.ex-people');
  const output = figure.querySelector<HTMLOutputElement>('.ex-people-out');
  const mesh = figure.querySelector('.ex-mesh');
  const star = figure.querySelector('.ex-star');
  const pairsOut = figure.querySelector('.ex-pairs');
  const linksOut = figure.querySelector('.ex-links');
  const axes = figure.querySelector('.ex-axes');
  const lines = figure.querySelector('.ex-lines');
  const marker = figure.querySelector('.ex-marker');
  const price = figure.querySelector('.ex-price');
  if (!range || !output || !mesh || !star || !pairsOut || !linksOut || !axes || !lines || !marker || !price) return;

  const max = Number(range.max);
  const cx = (people: number): number => 70 + ((people - 1) / (max - 1)) * 850;
  const cy = (dollars: number): number => 200 - (dollars / 100) * 170;
  svg('line', { x1: 70, y1: 200, x2: 920, y2: 200, class: 'axis' }, axes);
  for (const dollars of [25, 50, 75, 100]) {
    svg('line', { x1: 70, y1: cy(dollars), x2: 920, y2: cy(dollars), class: 'grid' }, axes);
    svg('text', { x: 60, y: cy(dollars) + 4, class: 'label end' }, axes).textContent = `$${dollars}`;
  }
  for (const people of [1, 5, 10, 15, 20]) svg('text', { x: cx(people), y: 222, class: 'label' }, axes).textContent = String(people);
  const segment = (from: number, to: number, name: string): void => {
    const points = Array.from({ length: to - from + 1 }, (_, n) => from + n).map((people) => `${cx(people)},${cy(pricePerPerson(people) ?? 0)}`);
    svg('polyline', { points: points.join(' '), class: `plan plan-${name}` }, lines);
    svg('text', { x: cx(from) + 6, y: cy(pricePerPerson(from) ?? 0) - 10, class: 'label left plan-label' }, lines).textContent = name === 'start' ? 'Start $100' : 'Grow $250';
  };
  segment(1, 4, 'start');
  segment(5, 14, 'grow');
  svg('line', { x1: cx(15), y1: 200, x2: cx(20), y2: 200, class: 'plan plan-agreed' }, lines);
  svg('text', { x: cx(15) + 6, y: 190, class: 'label left plan-label' }, lines).textContent = 'Beyond Grow: talk to us';
  const guide = svg('line', { y1: 30, y2: 200, class: 'guide' }, marker);
  const knob = svg('circle', { r: 8, class: 'knob' }, marker);

  const draw = (): void => {
    const people = Number(range.value);
    output.value = String(people);
    mesh.replaceChildren();
    star.replaceChildren();
    const around = ring(people, 220, 160, 118);
    around.forEach((a, i) => around.slice(i + 1).forEach((b) => svg('line', { x1: a.x, y1: a.y, x2: b.x, y2: b.y, class: 'edge' }, mesh)));
    around.forEach((p, i) => svg('circle', { cx: p.x, cy: p.y, r: 13, class: `node face-${PERSON_CLASSES[i % 4] ?? 'maya'}` }, mesh));
    svg('rect', { x: 186, y: 128, width: 68, height: 64, rx: 12, class: 'hub' }, star);
    svg('text', { x: 220, y: 165, class: 'hub-label' }, star).textContent = 'Canvas';
    around.forEach((p, i) => {
      svg('line', { x1: p.x, y1: p.y, x2: 220, y2: 160, class: 'spoke' }, star);
      svg('circle', { cx: p.x, cy: p.y, r: 13, class: `node face-${PERSON_CLASSES[i % 4] ?? 'maya'}` }, star);
    });
    pairsOut.textContent = String(pairs(people));
    linksOut.textContent = String(people);
    const each = pricePerPerson(people);
    const plan = planFor(people);
    const y = cy(each ?? 0);
    guide.setAttribute('x1', String(cx(people)));
    guide.setAttribute('x2', String(cx(people)));
    knob.setAttribute('cx', String(cx(people)));
    knob.setAttribute('cy', String(y));
    const amount = document.createElement('b');
    amount.textContent = each === null ? 'Talk to us' : `$${each.toFixed(2)}`;
    price.replaceChildren(amount, each === null ? ` for ${people} people` : ` per person on ${plan.name}${people === 1 ? ', just you' : ''}`);
  };
  range.addEventListener('input', draw);
  draw();
}

document.querySelectorAll<HTMLElement>('[data-explainer="live"]').forEach(liveExplainer);
document.querySelectorAll<HTMLElement>('[data-explainer="team"]').forEach(teamExplainer);

export {};
