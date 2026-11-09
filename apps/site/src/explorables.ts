/**
 * Drives the explorable figures that `explorable-figures.ts` renders.
 *
 * The loop figure draws any instant `t` from scratch (`drawLoop(t)`), so
 * playing, scrubbing and reduced motion are the same code: playback only
 * moves `t`. It plays while on screen until the reader touches the slider or
 * the button. The people figure shows as many people as its slider says.
 */
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

/** How long each phase of one event takes, in seconds. */
const TRAVEL_IN = 1.2;
const READ = 1;
const TRAVEL_OUT = 0.8;
const ENTER = 0.5;
const STATUS = ['Event from Linear', 'Event from Slack', 'Event from Granola'] as const;
const READING = ['Reading PRI-142', 'Reading #launch', 'Reading the notes'] as const;

const clamp = (value: number): number => Math.min(1, Math.max(0, value));
const ease = (value: number): number => 1 - (1 - clamp(value)) ** 3;

function loop(figure: HTMLElement): void {
  const events = (figure.dataset.events ?? '').split(',').map(Number);
  const length = Number(figure.dataset.length);
  const svg = figure.querySelector('svg')!;
  const range = figure.querySelector<HTMLInputElement>('[data-loop-range]')!;
  const readout = figure.querySelector<HTMLOutputElement>('[data-loop-readout]')!;
  const play = figure.querySelector<HTMLButtonElement>('[data-loop-play]')!;
  const pulse = svg.querySelector<SVGCircleElement>('[data-loop-pulse]')!;
  const head = svg.querySelector<SVGLineElement>('[data-loop-head]')!;
  const status = svg.querySelector<SVGTextElement>('[data-loop-status]')!;
  const wiresIn = events.map((_, i) => svg.querySelector<SVGPathElement>(`#loop-in-${i}`)!);
  const wireOut = svg.querySelector<SVGPathElement>('#loop-out')!;
  const tools = Array.from(svg.querySelectorAll<SVGGElement>('.loop-tool'));
  const ticks = Array.from(svg.querySelectorAll<SVGGElement>('.loop-tick'));
  const versions = Array.from(svg.querySelectorAll<SVGGElement>('.loop-version'));
  const hex = svg.querySelector<SVGGElement>('.loop-hex')!;
  const axis = svg.querySelector<SVGLineElement>('.loop-axis')!;
  const x0 = Number(axis.getAttribute('x1'));
  const x1 = Number(axis.getAttribute('x2'));

  const place = (path: SVGPathElement, progress: number): void => {
    const point = path.getPointAtLength(path.getTotalLength() * ease(progress));
    pulse.setAttribute('cx', point.x.toFixed(1));
    pulse.setAttribute('cy', point.y.toFixed(1));
  };

  function draw(t: number): void {
    let pulseOn = false;
    let text = 'Waiting for events';
    let reading = false;
    let published = 0;
    events.forEach((start, i) => {
      const local = t - start;
      const publishAt = TRAVEL_IN + READ + TRAVEL_OUT;
      tools[i]?.classList.toggle('is-active', local >= 0 && local < TRAVEL_IN);
      ticks[i]?.classList.toggle('is-past', local >= 0);
      if (local < 0) return;
      if (local < TRAVEL_IN) { pulseOn = true; place(wiresIn[i]!, local / TRAVEL_IN); text = STATUS[i]!; }
      else if (local < TRAVEL_IN + READ) { reading = true; text = READING[i]!; }
      else if (local < publishAt) { pulseOn = true; place(wireOut, (local - TRAVEL_IN - READ) / TRAVEL_OUT); text = `Publishing v${4 + i}`; }
      else { published = i + 1; text = `v${4 + i} published · waiting`; }
    });
    pulse.classList.toggle('is-on', pulseOn);
    hex.classList.toggle('is-reading', reading);
    status.textContent = text;

    // The newest version is in front; each older one steps back and fades.
    versions.forEach((version, j) => {
      const age = published - j;
      if (age < 0) { version.setAttribute('opacity', '0'); return; }
      const start = j === 0 ? -Infinity : events[j - 1]! + TRAVEL_IN + READ + TRAVEL_OUT;
      const enter = ease((t - start) / ENTER);
      const dx = age * 12 + (1 - enter) * 40;
      version.setAttribute('transform', `translate(${dx.toFixed(1)} ${(-age * 12).toFixed(1)})`);
      version.setAttribute('opacity', (enter * Math.max(0.12, 1 - age * 0.38)).toFixed(2));
    });
    const x = x0 + ((x1 - x0) * t) / length;
    head.setAttribute('x1', x.toFixed(1));
    head.setAttribute('x2', x.toFixed(1));
    readout.value = `${t.toFixed(1)} s`;
  }

  let t = length;
  let playing = false;
  let last = 0;
  let touched = false;
  const setPlaying = (on: boolean): void => {
    playing = on;
    figure.classList.toggle('is-playing', on);
    play.setAttribute('aria-label', on ? 'Pause' : 'Play');
    if (on) { last = performance.now(); requestAnimationFrame(frame); }
  };
  function frame(now: number): void {
    if (!playing) return;
    t += (now - last) / 1000;
    last = now;
    if (t > length + 1.5) t = 0;
    range.value = String(Math.min(t, length));
    draw(Math.min(t, length));
    requestAnimationFrame(frame);
  }

  range.addEventListener('input', () => {
    touched = true;
    setPlaying(false);
    t = Number(range.value);
    draw(t);
  });
  play.addEventListener('click', () => {
    touched = true;
    if (!playing && t >= length) t = 0;
    setPlaying(!playing);
  });
  if (!reduced) {
    new IntersectionObserver(([entry]) => {
      if (touched) return;
      if (entry?.isIntersecting && !playing) { t = 0; setPlaying(true); }
      else if (!entry?.isIntersecting && playing) setPlaying(false);
    }, { threshold: 0.4 }).observe(figure);
  }
  draw(t);
}

/** What the Canvas's Share menu would say for this many people. */
const shareLabel = (count: number): string =>
  count === 1 ? 'Only you' : count <= 20 ? 'Specific people' : 'Everyone in the Organization';

function people(figure: HTMLElement): void {
  const range = figure.querySelector<HTMLInputElement>('[data-people-range]')!;
  const count = figure.querySelector<HTMLElement>('[data-people-count]')!;
  const label = figure.querySelector<HTMLElement>('[data-people-label]')!;
  const seats = Array.from(figure.querySelectorAll<SVGGElement>('[data-person]'));
  const draw = (): void => {
    const n = Number(range.value);
    seats.forEach((seat, i) => seat.classList.toggle('is-on', i < n));
    count.textContent = String(n);
    label.textContent = shareLabel(n);
  };
  range.addEventListener('input', draw);
  draw();
}

document.querySelectorAll<HTMLElement>('[data-loop]').forEach(loop);
document.querySelectorAll<HTMLElement>('[data-people]').forEach(people);

export {};
