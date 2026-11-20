/**
 * Words in a headline that follow a story's slide: the homepage's
 * "a dashboard of your leads" becomes "a board of your orders" when the hero
 * story moves on. The markup names the story and which of the slide's data
 * attributes each word shows:
 *
 *   <span class="swap" data-swap="home-story:word"><span class="swap-now">leads</span></span>
 *
 * The headline wraps on its own, so a longer word can turn its lines
 * somewhere else. Every word of the headline is therefore measured before
 * and after the change and glides from where it was to where it now sits,
 * while the old word drifts up out of focus and the new one rises into place
 * a beat behind it. Nothing jumps.
 */
import { reducedMotion } from './steps';

const EASE = 'cubic-bezier(.22,.8,.2,1)';

/** Wraps each loose word of `heading` in a span, so it can be moved on its own. */
function splitWords(heading: HTMLElement): void {
  const walker = document.createTreeWalker(heading, NodeFilter.SHOW_TEXT);
  const loose: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.parentElement?.closest('.swap') && node.textContent?.trim()) loose.push(node as Text);
  }
  for (const node of loose) {
    const pieces = document.createDocumentFragment();
    for (const piece of (node.textContent ?? '').split(/(\s+)/u)) {
      if (!piece.trim()) { pieces.append(piece); continue; }
      const word = document.createElement('span');
      word.className = 'swap-part';
      word.textContent = piece;
      pieces.append(word);
    }
    node.replaceWith(pieces);
  }
}

/** Changes one holder's word: the old one leaves as a copy laid over it, the new one takes its place. */
function change(holder: HTMLElement, next: string, delay: number): void {
  const now = holder.querySelector<HTMLElement>('.swap-now');
  if (!now || now.textContent === next) return;
  if (reducedMotion) {
    now.textContent = next;
    return;
  }
  const old = document.createElement('span');
  old.className = 'swap-old';
  old.setAttribute('aria-hidden', 'true');
  old.textContent = now.textContent;
  now.textContent = next;
  holder.append(old);
  old.animate([
    { opacity: 1, transform: 'none', filter: 'blur(0)' },
    { opacity: 0, transform: 'translateY(-.36em)', filter: 'blur(5px)' },
  ], { duration: 220, easing: 'cubic-bezier(.4,0,.9,.5)', delay, fill: 'both' }).finished.then(() => old.remove(), () => old.remove());
  // The new word waits until the old one is nearly gone, so the two never read as a smear.
  now.animate([
    { opacity: 0, transform: 'translateY(.4em)', filter: 'blur(5px)' },
    { opacity: 1, transform: 'none', filter: 'blur(0)' },
  ], { duration: 620, easing: EASE, delay: delay + 200, fill: 'backwards' });
}

/** Shows `words` in `heading`'s holders, keyed by each holder's data attribute name. */
function swapWords(heading: HTMLElement, holders: readonly { holder: HTMLElement; key: string }[], words: DOMStringMap): void {
  const parts = Array.from(heading.querySelectorAll<HTMLElement>('.swap-part, .swap'));
  const before = parts.map((part) => part.getBoundingClientRect());
  holders.forEach(({ holder, key }, index) => {
    const next = words[key];
    if (next) change(holder, next, index * 110);
  });
  if (reducedMotion) return;
  parts.forEach((part, index) => {
    const from = before[index]!;
    const to = part.getBoundingClientRect();
    const dx = from.left - to.left;
    const dy = from.top - to.top;
    if (!dx && !dy) return;
    // A word that changes line crosses others on its way, so it thins out mid-flight and firms up as it lands.
    const far = Math.abs(dy) > 4;
    part.animate([
      { transform: `translate(${dx}px, ${dy}px)`, opacity: 1 },
      { opacity: far ? 0.15 : 1, offset: 0.3 },
      { transform: 'none', opacity: 1 },
    ], { duration: 640, easing: EASE });
  });
}

// One headline may hold several words that follow one story; they change together.
const headings = new Map<HTMLElement, Map<HTMLElement, { holder: HTMLElement; key: string }[]>>();
for (const holder of document.querySelectorAll<HTMLElement>('[data-swap]')) {
  const [storyId, key] = (holder.dataset.swap ?? '').split(':');
  const story = storyId ? document.getElementById(storyId) : null;
  const heading = holder.closest<HTMLElement>('h1, h2, h3, p');
  if (!story || !key || !heading) continue;
  const stories = headings.get(heading) ?? new Map<HTMLElement, { holder: HTMLElement; key: string }[]>();
  stories.set(story, [...(stories.get(story) ?? []), { holder, key }]);
  headings.set(heading, stories);
}
for (const [heading, stories] of headings) {
  splitWords(heading);
  for (const [story, holders] of stories) {
    story.addEventListener('story:slide', (event) => {
      swapWords(heading, holders, (event as CustomEvent<{ slide: HTMLElement }>).detail.slide.dataset);
    });
  }
}
