import { fireEvent, render } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { nextTranscriptFollowState, useTranscriptFollow } from './use-transcript-follow';

/**
 * jsdom performs no layout, so a scroll container reports a height of zero and
 * an assignment to `scrollTop` is discarded. The three properties are backed by
 * a plain object instead, defined on the prototype because the element under
 * test is created by the component; the setter records what the follow writes,
 * which is the whole thing being asserted on. `restore` puts jsdom's own
 * accessors back, which `restoreMocks` cannot do for a bare `defineProperty`.
 */
function stubScrollGeometry(initial: { scrollHeight: number; clientHeight: number; scrollTop: number }): {
  geometry: { scrollHeight: number; clientHeight: number; scrollTop: number };
  restore: () => void;
} {
  const geometry = { ...initial };
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
  return {
    geometry,
    restore: (): void => {
      for (const name of ['scrollHeight', 'clientHeight', 'scrollTop']) {
        Reflect.deleteProperty(HTMLElement.prototype, name);
      }
    },
  };
}

function Transcript({ canFollow = true, revision }: { canFollow?: boolean; revision: number }): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null);
  const follow = useTranscriptFollow(scrollRef, canFollow);
  return (
    <div
      data-revision={revision}
      data-testid="transcript"
      onScroll={(event) => follow.onScroll(event.currentTarget)}
      onWheel={(event) => follow.onWheel(event.deltaY)}
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
  let stub: ReturnType<typeof stubScrollGeometry> | null = null;

  afterEach(() => {
    stub?.restore();
    stub = null;
  });

  /** One streamed token: the last row grows, and the screen commits. */
  function stream(rerender: (element: React.JSX.Element) => void, revision: number, grownBy: number): void {
    stub!.geometry.scrollHeight += grownBy;
    rerender(<Transcript revision={revision} />);
    // The browser reports the scroll the follow just performed.
    fireEvent.scroll(document.querySelector('[data-testid="transcript"]')!);
  }

  it('holds the end of the transcript as a turn streams in', () => {
    stub = stubScrollGeometry({ scrollHeight: 2_000, clientHeight: 500, scrollTop: 1_500 });
    const { rerender } = render(<Transcript revision={0} />);

    stream(rerender, 1, 200);
    expect(stub.geometry.scrollTop).toBe(1_700);
    stream(rerender, 2, 200);
    expect(stub.geometry.scrollTop).toBe(1_900);
  });

  it('leaves the viewport where the reader put it for the rest of the turn', () => {
    stub = stubScrollGeometry({ scrollHeight: 2_000, clientHeight: 500, scrollTop: 1_500 });
    const { rerender } = render(<Transcript revision={0} />);
    stream(rerender, 1, 200);

    // The reader scrolls back up to read the reply from its beginning.
    stub.geometry.scrollTop = 400;
    fireEvent.scroll(document.querySelector('[data-testid="transcript"]')!);

    stream(rerender, 2, 200);
    stream(rerender, 3, 200);
    expect(stub.geometry.scrollTop).toBe(400);
  });

  it('does not read its own scroll back as the reader having asked for the end', () => {
    stub = stubScrollGeometry({ scrollHeight: 2_000, clientHeight: 500, scrollTop: 1_500 });
    const { rerender } = render(<Transcript revision={0} />);

    // A single wheel tick, landing well inside the slack — the case the old
    // screen could not escape, because its own correction reported the end and
    // re-armed the follow before the next token arrived.
    stub.geometry.scrollTop = 1_440;
    fireEvent.scroll(document.querySelector('[data-testid="transcript"]')!);

    stream(rerender, 1, 200);
    expect(stub.geometry.scrollTop).toBe(1_440);
  });

  it('follows again once the reader returns to the end', () => {
    stub = stubScrollGeometry({ scrollHeight: 2_000, clientHeight: 500, scrollTop: 1_500 });
    const { rerender } = render(<Transcript revision={0} />);

    stub.geometry.scrollTop = 400;
    fireEvent.scroll(document.querySelector('[data-testid="transcript"]')!);
    stream(rerender, 1, 200);
    expect(stub.geometry.scrollTop).toBe(400);

    stub.geometry.scrollTop = 1_700;
    fireEvent.scroll(document.querySelector('[data-testid="transcript"]')!);
    stream(rerender, 2, 200);
    expect(stub.geometry.scrollTop).toBe(1_900);
  });

  it('takes an upward wheel as intent before the scroll it causes is delivered', () => {
    stub = stubScrollGeometry({ scrollHeight: 2_000, clientHeight: 500, scrollTop: 1_500 });
    const { rerender } = render(<Transcript revision={0} />);

    // The wheel arrives; the compositor has not applied it yet, so the scroll
    // still reports the end.
    fireEvent.wheel(document.querySelector('[data-testid="transcript"]')!, { deltaY: -60 });
    stream(rerender, 1, 200);
    expect(stub.geometry.scrollTop).toBe(1_500);
  });

  it('does not let the scroll from its own correction undo the reader’s wheel', () => {
    stub = stubScrollGeometry({ scrollHeight: 2_000, clientHeight: 500, scrollTop: 1_500 });
    const { rerender } = render(<Transcript revision={0} />);
    const element = document.querySelector('[data-testid="transcript"]')!;

    // A token lands and the follow corrects to the new end. The scroll event for
    // that correction has not been delivered yet.
    stub.geometry.scrollHeight += 200;
    rerender(<Transcript revision={1} />);
    expect(stub.geometry.scrollTop).toBe(1_700);

    // The reader wheels up, and only then does the correction's own scroll
    // arrive — reporting the end, because that is where the screen put it. Read
    // as the reader's, it says "take me to the newest message", and the follow
    // re-arms behind their back.
    fireEvent.wheel(element, { deltaY: -60 });
    fireEvent.scroll(element);

    stub.geometry.scrollHeight += 200;
    rerender(<Transcript revision={2} />);
    expect(stub.geometry.scrollTop).toBe(1_700);
  });

  it('reports whether the viewport is at the end, for the jump control', () => {
    stub = stubScrollGeometry({ scrollHeight: 2_000, clientHeight: 500, scrollTop: 1_500 });
    const { getByTestId } = render(<Transcript revision={0} />);
    expect(getByTestId('at-end').textContent).toBe('true');

    stub.geometry.scrollTop = 400;
    fireEvent.scroll(getByTestId('transcript'));
    expect(getByTestId('at-end').textContent).toBe('false');

    stub.geometry.scrollTop = 1_500;
    fireEvent.scroll(getByTestId('transcript'));
    expect(getByTestId('at-end').textContent).toBe('true');
  });

  it('does not touch the viewport before the screen says it may follow', () => {
    stub = stubScrollGeometry({ scrollHeight: 2_000, clientHeight: 500, scrollTop: 900 });
    const { rerender } = render(<Transcript canFollow={false} revision={0} />);

    stub.geometry.scrollHeight += 200;
    rerender(<Transcript canFollow={false} revision={1} />);
    expect(stub.geometry.scrollTop).toBe(900);
  });
});
