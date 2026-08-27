import { fireEvent, render, screen } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  nextTranscriptFollowState,
  useTranscriptFollow,
  type TranscriptFollow,
} from './use-transcript-follow';

interface Geometry { scrollHeight: number; clientHeight: number; scrollTop: number }

/**
 * jsdom performs no layout, so a scroll container reports a height of zero and
 * an assignment to `scrollTop` is discarded. The three properties are backed by
 * a plain object instead, and the setter recording what the follow writes is the
 * assertion surface. `smoothTargets` records `scrollTo` calls without moving the
 * viewport, which is what an unfinished smooth animation looks like; `behaviors`
 * records the `behavior` option each of those calls carried, which is the
 * reduced-motion gate's whole assertion surface.
 *
 * The descriptors are captured and put back rather than deleted: they live on
 * `Element.prototype` today, so deleting the shadow happens to restore them, but
 * a jsdom that moved them to `HTMLElement.prototype` would leave the suite with
 * no accessor at all and a failure nowhere near this file.
 */
function stubScrollGeometry(initial: Geometry): {
  behaviors: (ScrollBehavior | undefined)[];
  geometry: Geometry;
  smoothTargets: number[];
  restore: () => void;
} {
  const geometry = { ...initial };
  const smoothTargets: number[] = [];
  const behaviors: (ScrollBehavior | undefined)[] = [];
  const names = ['scrollHeight', 'clientHeight', 'scrollTop', 'scrollTo'] as const;
  const original = new Map(names.map((name) =>
    [name, Object.getOwnPropertyDescriptor(HTMLElement.prototype, name)]));

  for (const name of ['scrollHeight', 'clientHeight'] as const) {
    Object.defineProperty(HTMLElement.prototype, name, {
      configurable: true,
      get: () => geometry[name],
    });
  }
  Object.defineProperty(HTMLElement.prototype, 'scrollTop', {
    configurable: true,
    get: () => geometry.scrollTop,
    set: (value: number) => { geometry.scrollTop = value; },
  });
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
    configurable: true,
    value: (options: { behavior?: ScrollBehavior; top: number }) => {
      smoothTargets.push(options.top);
      behaviors.push(options.behavior);
    },
    writable: true,
  });

  return {
    behaviors,
    geometry,
    smoothTargets,
    restore: (): void => {
      for (const [name, descriptor] of original) {
        if (descriptor) Object.defineProperty(HTMLElement.prototype, name, descriptor);
        else Reflect.deleteProperty(HTMLElement.prototype, name);
      }
    },
  };
}

let follow: TranscriptFollow;

function Transcript({
  canFollow = true,
  revision,
  workstreamId = 'workstream-a',
}: {
  canFollow?: boolean;
  revision: number;
  workstreamId?: string;
}): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null);
  follow = useTranscriptFollow(scrollRef, canFollow, workstreamId);
  return (
    <div
      data-revision={revision}
      data-testid="transcript"
      onScroll={(event) => follow.onScroll(event.currentTarget)}
      onWheel={(event) => follow.onWheel(event.currentTarget, event.deltaY)}
      ref={scrollRef}
    >
      <span data-testid="at-end">{String(follow.atEnd)}</span>
    </div>
  );
}

describe('nextTranscriptFollowState', () => {
  it('stops following on any move away from the end, including one inside the slack', () => {
    expect(nextTranscriptFollowState(true, 0, 60)).toBe(false);
    expect(nextTranscriptFollowState(true, 0, 900)).toBe(false);
  });

  it('follows again once a scroll comes to rest inside the slack', () => {
    expect(nextTranscriptFollowState(false, 400, 79)).toBe(true);
    expect(nextTranscriptFollowState(false, 400, 80)).toBe(false);
  });

  it('leaves the decision alone when a scroll neither leaves nor reaches the end', () => {
    expect(nextTranscriptFollowState(false, 900, 400)).toBe(false);
    expect(nextTranscriptFollowState(true, 900, 400)).toBe(true);
  });
});

describe('useTranscriptFollow', () => {
  let stub: ReturnType<typeof stubScrollGeometry>;

  afterEach(() => {
    stub?.restore();
    vi.unstubAllGlobals();
  });

  const element = (): HTMLElement => screen.getByTestId('transcript');
  const atEnd = (): string => screen.getByTestId('at-end').textContent ?? '';

  /**
   * One streamed token: the last row grows and the screen commits. The browser
   * dispatches a scroll event only if something actually moved the viewport,
   * which is the whole difference between a correction the transcript performed
   * and one it decided not to.
   */
  function stream(rerender: (element: React.JSX.Element) => void, revision: number, grownBy = 200): void {
    const before = stub.geometry.scrollTop;
    stub.geometry.scrollHeight += grownBy;
    rerender(<Transcript revision={revision} />);
    if (stub.geometry.scrollTop !== before) fireEvent.scroll(element());
  }

  it('holds the end of the transcript as a turn streams in', () => {
    stub = stubScrollGeometry({ scrollHeight: 2_000, clientHeight: 500, scrollTop: 1_500 });
    const { rerender } = render(<Transcript revision={0} />);

    stream(rerender, 1);
    expect(stub.geometry.scrollTop).toBe(1_700);
    stream(rerender, 2);
    expect(stub.geometry.scrollTop).toBe(1_900);
    expect(atEnd()).toBe('true');
  });

  it('leaves the viewport where the reader put it for the rest of the turn', () => {
    stub = stubScrollGeometry({ scrollHeight: 2_000, clientHeight: 500, scrollTop: 1_500 });
    const { rerender } = render(<Transcript revision={0} />);
    stream(rerender, 1);

    stub.geometry.scrollTop = 400;
    fireEvent.scroll(element());

    stream(rerender, 2);
    stream(rerender, 3);
    expect(stub.geometry.scrollTop).toBe(400);
  });

  it('reports that it is no longer at the end after a pull-back inside the slack', () => {
    stub = stubScrollGeometry({ scrollHeight: 2_000, clientHeight: 500, scrollTop: 1_500 });
    const { rerender } = render(<Transcript revision={0} />);

    // One wheel tick's worth — well inside the 80px slack, and the case the
    // follow is built to honour. Reporting "at the end" here hides the only
    // control that leads back to the newest message, and because nothing scrolls
    // again the report never gets another chance to be corrected.
    stub.geometry.scrollTop = 1_440;
    fireEvent.scroll(element());
    expect(atEnd()).toBe('false');

    stream(rerender, 1);
    stream(rerender, 2);
    expect(stub.geometry.scrollTop).toBe(1_440);
    expect(atEnd()).toBe('false');
  });

  it('does not read its own scroll back as the reader having asked for the end', () => {
    stub = stubScrollGeometry({ scrollHeight: 2_000, clientHeight: 500, scrollTop: 1_500 });
    const { rerender } = render(<Transcript revision={0} />);

    stub.geometry.scrollTop = 1_440;
    fireEvent.scroll(element());
    stream(rerender, 1);
    expect(stub.geometry.scrollTop).toBe(1_440);
  });

  it('honours a reader scroll that lands in the same frame as a correction', () => {
    stub = stubScrollGeometry({ scrollHeight: 2_000, clientHeight: 500, scrollTop: 1_500 });
    const { rerender } = render(<Transcript revision={0} />);

    // A correction is written, and before its scroll event is delivered the
    // reader pages up. The browser coalesces both into one event reporting the
    // reader's position — which is not the position the transcript wrote, and
    // is the only thing that distinguishes them. A keyboard scroll produces no
    // wheel event, so nothing else can rescue this.
    stub.geometry.scrollHeight += 200;
    rerender(<Transcript revision={1} />);
    expect(stub.geometry.scrollTop).toBe(1_700);

    stub.geometry.scrollTop = 1_200;
    fireEvent.scroll(element());

    stream(rerender, 2);
    expect(stub.geometry.scrollTop).toBe(1_200);
    expect(atEnd()).toBe('false');
  });

  it('does not spend its claim on a write the browser clamps away', () => {
    stub = stubScrollGeometry({ scrollHeight: 2_000, clientHeight: 500, scrollTop: 1_500 });
    const { rerender } = render(<Transcript revision={0} />);

    // `scrollHeight` and `clientHeight` are integers while the reachable
    // maximum is fractional, so the follow can write a target the browser
    // clamps to where it already was. No scroll event follows; a claim that had
    // to be spent exactly once would be spent on the reader instead.
    stub.geometry.scrollHeight += 200;
    Object.defineProperty(HTMLElement.prototype, 'scrollTop', {
      configurable: true,
      get: () => stub.geometry.scrollTop,
      set: () => { /* every write clamps back to where it was */ },
    });
    rerender(<Transcript revision={1} />);

    // Restore a working setter, then scroll away as the reader.
    Object.defineProperty(HTMLElement.prototype, 'scrollTop', {
      configurable: true,
      get: () => stub.geometry.scrollTop,
      set: (value: number) => { stub.geometry.scrollTop = value; },
    });
    stub.geometry.scrollTop = 900;
    fireEvent.scroll(element());
    expect(atEnd()).toBe('false');

    // A claim spent on that scroll would leave the follow armed, and the next
    // token would take the viewport straight back.
    stub.geometry.scrollHeight += 200;
    rerender(<Transcript revision={2} />);
    expect(stub.geometry.scrollTop).toBe(900);
  });

  it('follows again once the reader returns to the end', () => {
    stub = stubScrollGeometry({ scrollHeight: 2_000, clientHeight: 500, scrollTop: 1_500 });
    const { rerender } = render(<Transcript revision={0} />);

    stub.geometry.scrollTop = 400;
    fireEvent.scroll(element());
    stream(rerender, 1);
    expect(stub.geometry.scrollTop).toBe(400);

    stub.geometry.scrollTop = 1_700;
    fireEvent.scroll(element());
    expect(atEnd()).toBe('true');
    stream(rerender, 2);
    expect(stub.geometry.scrollTop).toBe(1_900);
  });

  it('takes an upward wheel as intent before the scroll it causes is delivered', () => {
    stub = stubScrollGeometry({ scrollHeight: 2_000, clientHeight: 500, scrollTop: 1_500 });
    const { rerender } = render(<Transcript revision={0} />);

    fireEvent.wheel(element(), { deltaY: -60 });
    expect(atEnd()).toBe('false');
    stream(rerender, 1);
    expect(stub.geometry.scrollTop).toBe(1_500);
  });

  it('ignores an upward wheel the transcript cannot act on', () => {
    // A wheel over a code block, a wide table, or an expanded tool output
    // bubbles here too, and a transcript already at its top cannot move — so no
    // scroll event follows to correct the guess, and the follow would stay off
    // for the rest of the turn on a gesture that never touched it.
    stub = stubScrollGeometry({ scrollHeight: 2_000, clientHeight: 2_000, scrollTop: 0 });
    const { rerender } = render(<Transcript revision={0} />);

    fireEvent.wheel(element(), { deltaY: -60 });
    expect(atEnd()).toBe('true');

    stub.geometry.scrollHeight = 3_000;
    rerender(<Transcript revision={1} />);
    expect(stub.geometry.scrollTop).toBe(1_000);
  });

  it('does not carry one work stream’s decision into the next', () => {
    stub = stubScrollGeometry({ scrollHeight: 2_000, clientHeight: 500, scrollTop: 1_500 });
    const { rerender } = render(<Transcript revision={0} workstreamId="workstream-a" />);

    stub.geometry.scrollTop = 400;
    fireEvent.scroll(element());
    expect(atEnd()).toBe('false');

    // The screen is one component across every work stream, so nothing else
    // clears this.
    rerender(<Transcript revision={1} workstreamId="workstream-b" />);
    expect(atEnd()).toBe('true');
    stub.geometry.scrollHeight += 200;
    rerender(<Transcript revision={2} workstreamId="workstream-b" />);
    expect(stub.geometry.scrollTop).toBe(1_700);
  });

  it('stops following when the screen puts the viewport somewhere else', () => {
    stub = stubScrollGeometry({ scrollHeight: 2_000, clientHeight: 500, scrollTop: 1_500 });
    const { rerender } = render(<Transcript revision={0} />);

    follow.release();
    rerender(<Transcript revision={1} />);
    expect(atEnd()).toBe('false');

    stub.geometry.scrollHeight += 200;
    rerender(<Transcript revision={2} />);
    expect(stub.geometry.scrollTop).toBe(1_500);
  });

  it('moves the viewport on the screen’s behalf without reading it back as the reader', () => {
    stub = stubScrollGeometry({ scrollHeight: 4_000, clientHeight: 500, scrollTop: 3_500 });
    const { rerender } = render(<Transcript revision={0} />);
    follow.release();
    rerender(<Transcript revision={1} />);

    // An older page was prepended; the position that keeps the same message
    // under the reader's eye is restored, and moves nothing about following.
    follow.scrollTo(1_200);
    expect(stub.geometry.scrollTop).toBe(1_200);
    fireEvent.scroll(element());
    expect(atEnd()).toBe('false');

    stub.geometry.scrollHeight += 200;
    rerender(<Transcript revision={2} />);
    expect(stub.geometry.scrollTop).toBe(1_200);
  });

  it('goes to the end and follows from there when asked', () => {
    stub = stubScrollGeometry({ scrollHeight: 4_000, clientHeight: 500, scrollTop: 3_500 });
    const { rerender } = render(<Transcript revision={0} />);
    follow.release();
    follow.scrollTo(400);
    rerender(<Transcript revision={1} />);

    follow.scrollToEnd();
    expect(stub.geometry.scrollTop).toBe(3_500);
    rerender(<Transcript revision={2} />);
    expect(atEnd()).toBe('true');

    stub.geometry.scrollHeight += 200;
    rerender(<Transcript revision={3} />);
    expect(stub.geometry.scrollTop).toBe(3_700);
  });

  it('waits for a smooth jump to arrive before following again', () => {
    stub = stubScrollGeometry({ scrollHeight: 4_000, clientHeight: 500, scrollTop: 3_500 });
    const { rerender } = render(<Transcript revision={0} />);
    // The reader has read their way back up; the screen owns that position.
    follow.release();
    follow.scrollTo(400);
    rerender(<Transcript revision={1} />);

    follow.scrollToEnd({ smooth: true });
    expect(stub.smoothTargets).toEqual([3_500]);
    // The animation has not started moving yet, and must not be snapped past.
    expect(stub.geometry.scrollTop).toBe(400);
    stub.geometry.scrollHeight += 200;
    rerender(<Transcript revision={2} />);
    expect(stub.geometry.scrollTop).toBe(400);

    // Each frame of it reports a position further from the end than the last,
    // which is what a reader pulling away looks like — and must not be read as
    // one, because they asked for this.
    stub.geometry.scrollTop = 1_000;
    fireEvent.scroll(element());
    stub.geometry.scrollTop = 3_700;
    fireEvent.scroll(element());

    stub.geometry.scrollHeight += 200;
    rerender(<Transcript revision={3} />);
    expect(stub.geometry.scrollTop).toBe(3_900);
  });

  // The stylesheet's global reduced-motion kill switch
  // (`scroll-behavior: auto !important`) cannot override an explicit `smooth`
  // passed to `scrollTo` — the option wins over the page's CSS per spec — so
  // the preference has to be read here in script, the same way `sidebar.tsx`
  // reads it for its own jump.
  it('jumps instantly instead of smoothly when the reader prefers reduced motion', () => {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('prefers-reduced-motion') }));
    stub = stubScrollGeometry({ scrollHeight: 4_000, clientHeight: 500, scrollTop: 3_500 });
    const { rerender } = render(<Transcript revision={0} />);
    follow.release();
    follow.scrollTo(400);
    rerender(<Transcript revision={1} />);

    follow.scrollToEnd({ smooth: true });

    expect(stub.smoothTargets).toEqual([3_500]);
    expect(stub.behaviors).toEqual(['auto']);
  });

  it('keeps the jump smooth when the reader has not asked for less motion', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    stub = stubScrollGeometry({ scrollHeight: 4_000, clientHeight: 500, scrollTop: 3_500 });
    const { rerender } = render(<Transcript revision={0} />);
    follow.release();
    follow.scrollTo(400);
    rerender(<Transcript revision={1} />);

    follow.scrollToEnd({ smooth: true });

    expect(stub.smoothTargets).toEqual([3_500]);
    expect(stub.behaviors).toEqual(['smooth']);
  });

  it('does not touch the viewport before the screen says it may follow', () => {
    stub = stubScrollGeometry({ scrollHeight: 2_000, clientHeight: 500, scrollTop: 900 });
    const { rerender } = render(<Transcript canFollow={false} revision={0} />);

    stub.geometry.scrollHeight += 200;
    rerender(<Transcript canFollow={false} revision={1} />);
    expect(stub.geometry.scrollTop).toBe(900);
  });
});
