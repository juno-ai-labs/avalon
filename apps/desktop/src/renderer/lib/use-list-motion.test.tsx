import { render } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LIST_MOTION, LIST_MOTION_TOTAL_MS } from './list-motion';
import { useListMotion } from './use-list-motion';

const ROW = 48;
const CONTAINER_LEFT = 10;
const ROW_LEFT = 22;
const ROW_WIDTH = 200;

interface FakeAnimation {
  cancel: ReturnType<typeof vi.fn>;
  onfinish: (() => void) | null;
  oncancel: (() => void) | null;
  /** Set by a test that wants the animation to read as not yet drawn. */
  pending: boolean;
}

const animate = vi.fn();
const jsdomMeasure = Element.prototype.getBoundingClientRect;
/** The document-order measurement each test installs; see `beforeEach`. */
let measure: (this: Element) => DOMRect;

/**
 * `generation` goes into the row keys, so bumping it replaces every row's
 * element; `hidden` rows render with no layout, the way `display: none` does.
 */
function List({ rows, hold = [], hidden = [], generation = 0, layout }: {
  rows: string[]; hold?: string[]; hidden?: string[]; generation?: number; layout?: unknown;
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null);
  useListMotion(ref, layout);
  return (
    <div data-testid="list" ref={ref}>
      {rows.map((key) => (
        <div
          data-hidden={hidden.includes(key) ? '' : undefined}
          data-motion-hold={hold.includes(key) ? '' : undefined}
          data-motion-key={key}
          data-testid={key}
          key={`${generation}:${key}`}
          tabIndex={-1}
        >
          {key}
        </div>
      ))}
    </div>
  );
}

/**
 * A row drawn `dy` pixels from its slot by an animation in flight: the browser
 * reports its rect through the transform, and the transform through computed
 * style, and the stubs here have to agree the same way.
 */
function drawnOffBy(element: HTMLElement, dy: number): void {
  Element.prototype.getBoundingClientRect = function shifted(this: Element): DOMRect {
    const rect = measure.call(this);
    return this === element ? { ...rect, top: rect.top + dy, y: rect.y + dy, bottom: rect.bottom + dy } : rect;
  };
  vi.spyOn(globalThis, 'getComputedStyle').mockImplementation((candidate) => ({
    transform: candidate === element ? `matrix(1, 0, 0, 1, 0, ${dy})` : 'none',
  }) as CSSStyleDeclaration);
}

/** The animations started on a row, newest last, each with its keyframes and options. */
function played(key: string): Array<{ keyframes: Keyframe[]; options: KeyframeAnimationOptions; animation: FakeAnimation }> {
  return animate.mock.calls
    .map((call, index) => ({ element: call[0] as HTMLElement, keyframes: call[1] as Keyframe[], options: call[2] as KeyframeAnimationOptions, animation: animate.mock.results[index]!.value as FakeAnimation }))
    .filter(({ element }) => element.dataset.motionKey === key && element.closest('[data-motion-scope]') === null)
    .map(({ keyframes, options, animation }) => ({ keyframes, options, animation }));
}

describe('useListMotion', () => {
  beforeEach(() => {
    animate.mockReset();
    // jsdom lays nothing out and animates nothing. Positions follow document
    // order — one slot per row, under a container with a fixed origin — which
    // is what a grid list gives, and the animation is a record of what was
    // asked for, with the finish and cancel handlers left for the test to call.
    measure = function getBoundingClientRect(this: Element): DOMRect {
      const container = this.closest('[data-testid="list"]');
      if (container === this || container === null) {
        return { top: 0, left: CONTAINER_LEFT, right: 400, bottom: 800, width: 390, height: 800, x: CONTAINER_LEFT, y: 0, toJSON: () => ({}) };
      }
      if (this.hasAttribute('data-hidden')) {
        return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) };
      }
      // Laid-out rows only, and through the container's scroll, the way a
      // viewport rect is.
      const index = [...container.querySelectorAll('[data-motion-key]:not([data-hidden])')].indexOf(this);
      const top = index * ROW - container.scrollTop;
      return { top, left: ROW_LEFT, right: ROW_LEFT + ROW_WIDTH, bottom: top + ROW, width: ROW_WIDTH, height: ROW, x: ROW_LEFT, y: top, toJSON: () => ({}) };
    };
    Element.prototype.getBoundingClientRect = measure;
    animate.mockImplementation((): FakeAnimation => ({ cancel: vi.fn(), onfinish: null, oncancel: null, pending: false }));
    Element.prototype.animate = function animateStub(this: Element, keyframes: Keyframe[] | PropertyIndexedKeyframes | null, options?: number | KeyframeAnimationOptions): Animation {
      return animate(this, keyframes, options) as Animation;
    };
  });

  afterEach(() => {
    // `animate` is deleted rather than restored: jsdom never defined it, and a
    // stub left behind would hide that gap from every test after these. jsdom
    // does define the measurement, which goes back as it was.
    delete (Element.prototype as Partial<Element>).animate;
    Element.prototype.getBoundingClientRect = jsdomMeasure;
  });

  it('animates nothing on the first render or on a render that moved nothing', () => {
    const { rerender } = render(<List rows={['a', 'b', 'c']} />);
    rerender(<List rows={['a', 'b', 'c']} />);
    expect(animate).not.toHaveBeenCalled();
  });

  it('slides a moved row out of frame and back in at its new slot while the rows between shift', () => {
    const { rerender, getByTestId } = render(<List rows={['a', 'b', 'c']} />);
    rerender(<List rows={['c', 'a', 'b']} />);

    const [mover] = played('c');
    // Far enough left to clear the container's edge, whatever the row's width.
    const away = -(ROW_LEFT + ROW_WIDTH - CONTAINER_LEFT + LIST_MOTION.exitClearancePx);
    expect(mover?.keyframes).toEqual([
      expect.objectContaining({ offset: 0, transform: `translate(0px, ${2 * ROW}px)` }),
      expect.objectContaining({ transform: `translate(${away}px, ${2 * ROW}px)` }),
      expect.objectContaining({ transform: `translate(${away}px, 0px)` }),
      expect.objectContaining({ transform: `translate(${away}px, 0px)` }),
      expect.objectContaining({ offset: 1, transform: 'translate(0px, 0px)' }),
    ]);
    expect(mover?.options).toEqual({ duration: LIST_MOTION_TOTAL_MS, fill: 'backwards' });

    for (const key of ['a', 'b']) {
      const [shifter] = played(key);
      expect(shifter?.keyframes).toEqual([{ transform: `translate(0px, ${-ROW}px)` }, { transform: 'translate(0px, 0px)' }]);
      // On the same first frame as the row leaving: no delay.
      expect(shifter?.options).toEqual({ duration: LIST_MOTION.shiftMs, easing: LIST_MOTION.shiftEasing, fill: 'backwards' });
    }
    expect(animate).toHaveBeenCalledTimes(3);
    // Rows stay targets throughout: nothing is written to their style.
    expect(getByTestId('c').getAttribute('style')).toBeNull();
  });

  it('follows a row whose element was replaced, the way a row moving between sections is', () => {
    const { rerender } = render(<List rows={['a', 'b', 'c']} />);
    rerender(<List generation={1} rows={['c', 'a', 'b']} />);
    expect(played('c')[0]?.keyframes[0]).toEqual(expect.objectContaining({ transform: `translate(0px, ${2 * ROW}px)` }));
  });

  it('shifts a held row into place rather than moving it', () => {
    const { rerender } = render(<List rows={['a', 'b', 'c']} />);
    rerender(<List hold={['c']} rows={['c', 'a', 'b']} />);
    const [held] = played('c');
    expect(held?.keyframes).toEqual([{ transform: `translate(0px, ${2 * ROW}px)` }, { transform: 'translate(0px, 0px)' }]);
    expect(held?.options).toEqual(expect.objectContaining({ duration: LIST_MOTION.shiftMs }));
  });

  // The sidebar re-renders for state that has nothing to do with the list —
  // its reveal clears itself a tick after the row it followed has moved — and
  // an animation cancelled then has not drawn a frame: the motion would simply
  // never be seen.
  it('leaves what a row is playing alone across a render that moved nothing', () => {
    const { rerender, getByTestId } = render(<List rows={['a', 'b', 'c']} />);
    rerender(<List rows={['c', 'a', 'b']} />);
    const started = animate.mock.calls.length;
    rerender(<List rows={['c', 'a', 'b']} />);
    expect(animate).toHaveBeenCalledTimes(started);
    for (const key of ['a', 'b', 'c']) expect(played(key)[0]?.animation.cancel).not.toHaveBeenCalled();
    expect(getByTestId('a')).toBeInTheDocument();
  });

  it('measures a row through its own in-flight transform rather than taking the transform for a move', () => {
    const { rerender, getByTestId } = render(<List rows={['a', 'b', 'c']} />);
    rerender(<List rows={['c', 'a', 'b']} />);
    // `a` is half-way through its shift, drawn 24px above its slot.
    drawnOffBy(getByTestId('a'), -24);
    const started = animate.mock.calls.length;

    rerender(<List rows={['c', 'a', 'b']} />);

    expect(animate).toHaveBeenCalledTimes(started);
    expect(played('a')[0]?.animation.cancel).not.toHaveBeenCalled();
  });

  it('interrupts only the rows a render moved, and starts a not-yet-drawn one from where it was going to start', () => {
    const { rerender } = render(<List rows={['a', 'b', 'c', 'd']} />);
    rerender(<List rows={['b', 'a', 'c', 'd']} />);
    // Nothing has drawn a frame, so the computed transform says nothing; the
    // animation's own first keyframe is where the row is.
    for (const key of ['a', 'b']) played(key)[0]!.animation.pending = true;
    rerender(<List rows={['b', 'a', 'd', 'c']} />);
    for (const key of ['a', 'b']) expect(played(key)[0]?.animation.cancel).not.toHaveBeenCalled();
    expect(played('c')[0]?.keyframes[0]).toEqual(expect.objectContaining({ transform: `translate(0px, ${-ROW}px)` }));

    rerender(<List rows={['a', 'b', 'd', 'c']} />);
    expect(played('a')[0]?.animation.cancel).toHaveBeenCalledTimes(1);
    // `a` was about to start from its original slot, which is where the swap
    // back has put it: no offset. Read from the layout instead, it would have
    // started one slot down and travelled up to where it already was.
    expect(played('a')[1]?.keyframes[0]).toEqual(expect.objectContaining({ transform: 'translate(0px, 0px)' }));
  });

  it('cancels an interrupted animation and continues from where it had got to', () => {
    const { rerender, getByTestId } = render(<List rows={['a', 'b', 'c']} />);
    rerender(<List rows={['c', 'a', 'b']} />);
    const [first] = played('a');
    // Halfway through its shift: the row is drawn 24px above its slot.
    drawnOffBy(getByTestId('a'), -24);

    rerender(<List rows={['c', 'b', 'a']} />);

    expect(first?.animation.cancel).toHaveBeenCalledTimes(1);
    const second = played('a')[1];
    // From 24px above its previous slot, which is now one slot above: -72px.
    expect(second?.keyframes[0]).toEqual(expect.objectContaining({ transform: `translate(0px, ${-ROW - 24}px)` }));
    // The cancelled animation's own settling lands after its successor was
    // recorded, and must not clear the successor's record: a third change
    // then still finds, and interrupts, the successor.
    // `c` did not move in the second change and was left to finish its own.
    expect(played('c')).toHaveLength(1);
    expect(played('c')[0]?.animation.cancel).not.toHaveBeenCalled();
    first?.animation.oncancel?.();
    drawnOffBy(getByTestId('a'), -12);
    rerender(<List rows={['a', 'c', 'b']} />);
    expect(second?.animation.cancel).toHaveBeenCalledTimes(1);
    // And `a` continues from the successor's drawn position: two slots down, less 12px.
    expect(played('a')[2]?.keyframes[0]).toEqual(expect.objectContaining({ transform: `translate(0px, ${2 * ROW - 12}px)` }));
  });

  it('remembers positions while playing nothing for a reader who asked for less motion', () => {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('prefers-reduced-motion') }));
    const { rerender } = render(<List rows={['a', 'b', 'c']} />);
    rerender(<List rows={['c', 'a', 'b']} />);
    expect(animate).not.toHaveBeenCalled();
    // The positions the reduced-motion render left are the ones the next
    // change starts from: `c` travels one slot, not two.
    vi.unstubAllGlobals();
    rerender(<List rows={['a', 'c', 'b']} />);
    expect(played('c')[0]?.keyframes[0]).toEqual(expect.objectContaining({ transform: `translate(0px, ${-ROW}px)` }));
  });

  it('remembers positions while playing nothing in a hidden window', () => {
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    const { rerender } = render(<List rows={['a', 'b', 'c']} />);
    rerender(<List rows={['c', 'a', 'b']} />);
    expect(animate).not.toHaveBeenCalled();
    visibility.mockReturnValue('visible');
    rerender(<List rows={['a', 'c', 'b']} />);
    expect(played('c')[0]?.keyframes[0]).toEqual(expect.objectContaining({ transform: `translate(0px, ${-ROW}px)` }));
  });

  it('measures through the container\'s scroll, so scrolling is not a move and a move is measured whole', () => {
    const { rerender, getByTestId } = render(<List rows={['a', 'b', 'c']} />);
    // jsdom keeps no scroll position of its own; the stub reads this one.
    Object.defineProperty(getByTestId('list'), 'scrollTop', { configurable: true, value: 100 });
    rerender(<List rows={['a', 'b', 'c']} />);
    expect(animate).not.toHaveBeenCalled();
    rerender(<List rows={['c', 'a', 'b']} />);
    // Two slots, whatever the viewport shows of them.
    expect(played('c')[0]?.keyframes[0]).toEqual(expect.objectContaining({ transform: `translate(0px, ${2 * ROW}px)` }));
  });

  it('holds a row that kept its element and has focus inside it, and not a remounted one', () => {
    const { rerender, getByTestId } = render(<List rows={['a', 'b', 'c']} />);
    // The reader's own move: the row they are on is placed, not sent out.
    getByTestId('c').focus();
    rerender(<List rows={['c', 'a', 'b']} />);
    expect(played('c')[0]?.keyframes).toEqual([{ transform: `translate(0px, ${2 * ROW}px)` }, { transform: 'translate(0px, 0px)' }]);
    // Focus repaired onto a row that was remounted somewhere else is not the
    // reader's doing, and that row travels.
    animate.mockClear();
    rerender(<List generation={1} rows={['a', 'b', 'c']} />);
    getByTestId('c').focus();
    expect(played('c')[0]?.keyframes[0]).toEqual(expect.objectContaining({ offset: 0, transform: `translate(0px, ${-2 * ROW}px)` }));
  });

  it('neither measures nor remembers a row with no layout', () => {
    const { rerender } = render(<List hidden={['b']} rows={['a', 'b', 'c']} />);
    rerender(<List hidden={['b']} rows={['c', 'a', 'b']} />);
    // `c` moved one laid-out slot, not two; `b` was not there to animate.
    expect(played('c')[0]?.keyframes[0]).toEqual(expect.objectContaining({ transform: `translate(0px, ${ROW}px)` }));
    expect(played('b')).toEqual([]);
    // Shown again, it is a row never seen before: left alone, not slid in
    // from the fake position an empty rect would have given it.
    animate.mockClear();
    rerender(<List rows={['c', 'a', 'b']} />);
    expect(played('b')).toEqual([]);
  });

  it('measures afresh and plays nothing when the layout it was given changes', () => {
    const { rerender } = render(<List layout="wide" rows={['a', 'b', 'c']} />);
    rerender(<List layout="wide" rows={['c', 'a', 'b']} />);
    const [first] = played('c');
    rerender(<List layout="compact" rows={['a', 'b', 'c']} />);
    expect(first?.animation.cancel).toHaveBeenCalledTimes(1);
    expect(played('c')).toHaveLength(1);
    // The next change starts from the positions the new layout was measured at.
    rerender(<List layout="compact" rows={['b', 'a', 'c']} />);
    expect(played('b').at(-1)?.keyframes[0]).toEqual(expect.objectContaining({ transform: `translate(0px, ${ROW}px)` }));
  });

  it('keeps rows in separate scopes apart even when they share a key', () => {
    function Scoped({ order }: { order: string[] }): React.JSX.Element {
      const ref = useRef<HTMLDivElement | null>(null);
      useListMotion(ref);
      return (
        <div data-testid="list" ref={ref}>
          <div data-motion-scope="project">
            <div data-motion-key="a" data-testid="project-a">a</div>
          </div>
          {order.map((key) => <div data-motion-key={key} data-testid={key} key={key}>{key}</div>)}
        </div>
      );
    }
    const { rerender } = render(<Scoped order={['a', 'b']} />);
    rerender(<Scoped order={['b', 'a']} />);
    // The project's own row did not move and is left alone; the list's did.
    const projectRow = animate.mock.calls.find((call) => (call[0] as HTMLElement).dataset.testid === 'project-a');
    expect(projectRow).toBeUndefined();
    expect(played('a').length + played('b').length).toBe(2);
  });
});
