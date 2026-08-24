import { act, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WORKSTREAM_NAMING_GRACE_MS } from '@avalon/contracts';

import { useNamingSkeleton, type NameableWorkstream } from './naming-skeleton';

/**
 * Every value the hook returned, in render order.
 *
 * The component tests around this one assert on the DOM after Testing Library
 * has flushed effects, which is the state a person eventually sees but not the
 * one they see first. A skeleton decided by an effect is correct by the time
 * those assertions run and still wrong on the frame that was painted, so the
 * only way to hold the hook to answering *on the render* is to record what it
 * answered on each one.
 */
function renderNamingSkeleton(workstream: NameableWorkstream): {
  answers: boolean[];
  show: (next: NameableWorkstream) => void;
} {
  const answers: boolean[] = [];
  function Probe({ subject }: { subject: NameableWorkstream }): null {
    answers.push(useNamingSkeleton(subject));
    return null;
  }
  const { rerender } = render(<Probe subject={workstream} />);
  return {
    answers,
    show: (next) => rerender(<Probe subject={next} />),
  };
}

const created = new Date('2026-08-24T12:00:00.000Z');

afterEach(() => {
  vi.useRealTimers();
});

describe('useNamingSkeleton', () => {
  it('holds the title inside the grace and gives it up when the grace lapses', () => {
    vi.useFakeTimers();
    vi.setSystemTime(created);
    const { answers } = renderNamingSkeleton({
      titleStatus: 'naming',
      createdAt: created.toISOString(),
    });

    expect(answers.at(-1)).toBe(true);

    // Nothing refetches a title, so this timer is the only thing that can end a
    // skeleton whose rename never arrived.
    act(() => { vi.advanceTimersByTime(WORKSTREAM_NAMING_GRACE_MS + 1_000); });

    expect(answers.at(-1)).toBe(false);
  });

  it('answers for the work stream it is given, not the one before it', () => {
    vi.useFakeTimers();
    vi.setSystemTime(created);
    // The work-stream header stays mounted across work streams by design, so
    // this hook sees a new subject without remounting — unlike a sidebar row,
    // which is keyed by work-stream id.
    const { answers, show } = renderNamingSkeleton({
      titleStatus: 'settled',
      createdAt: created.toISOString(),
    });
    expect(answers).toEqual([false]);

    act(() => show({ titleStatus: 'naming', createdAt: created.toISOString() }));

    // Every render since the switch, not merely the last one: a `false` here is
    // a frame of the request text before the skeleton replaces it.
    expect(answers.slice(1)).not.toContain(false);
    expect(answers.at(-1)).toBe(true);

    // And the reverse — a work stream whose grace lapsed long ago must not
    // shimmer for a frame on the way in.
    act(() => { vi.setSystemTime(new Date(created.getTime() + WORKSTREAM_NAMING_GRACE_MS * 10)); });
    const before = answers.length;
    act(() => show({ titleStatus: 'naming', createdAt: created.toISOString() }));

    expect(answers.slice(before)).not.toContain(true);
  });

  it('treats a creation time it cannot read as past the grace', () => {
    const { answers } = renderNamingSkeleton({ titleStatus: 'naming' });
    expect(answers.at(-1)).toBe(false);

    const unparsable = renderNamingSkeleton({ titleStatus: 'naming', createdAt: 'the other day' });
    expect(unparsable.answers.at(-1)).toBe(false);
  });
});
