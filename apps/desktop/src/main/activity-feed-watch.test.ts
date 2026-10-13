import type { ActivityItem, ActivityPage } from '@rally/contracts';
import { describe, expect, it, vi } from 'vitest';
import { ActivityFeedWatch } from './activity-feed-watch';

function item(id: string): ActivityItem {
  return {
    id,
    kind: 'run_finished',
    occurredAt: '2026-10-06T10:00:00.000Z',
    actorUserId: null,
    actorLabel: 'Rally',
    threadId: '00000000-0000-7000-8000-0000000000a1' as ActivityItem['threadId'],
    threadTitle: 'GTM review',
    breakout: null,
    channelIds: [],
    unread: true,
  };
}

/** A fetch whose answers the test hands out one at a time. */
function harness() {
  const answers: Array<(page: ActivityPage) => void> = [];
  const fetchPage = vi.fn(() => new Promise<ActivityPage>((resolve) => { answers.push(resolve); }));
  const onChange = vi.fn();
  const watch = new ActivityFeedWatch({ fetchPage, onChange, logWarning: vi.fn() });
  const answer = async (ids: string[]): Promise<void> => {
    answers.shift()!({ items: ids.map(item), nextCursor: null });
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  return { watch, fetchPage, onChange, answer };
}

describe('activity feed watch', () => {
  it('holds the page it read, and says it is whole only once one landed', async () => {
    const subject = harness();
    expect(subject.watch.snapshot()).toEqual({ items: [], complete: false });

    subject.watch.refresh();
    await subject.answer(['a']);

    expect(subject.watch.snapshot()).toEqual({ items: [item('a')], complete: true });
    expect(subject.onChange).toHaveBeenCalledTimes(1);
  });

  it('reads once more after the read in flight when asked meanwhile, however often', async () => {
    const subject = harness();
    subject.watch.refresh();
    subject.watch.refresh();
    subject.watch.refresh();
    expect(subject.fetchPage).toHaveBeenCalledTimes(1);

    await subject.answer(['a']);
    expect(subject.fetchPage).toHaveBeenCalledTimes(2);
    await subject.answer(['b']);

    expect(subject.fetchPage).toHaveBeenCalledTimes(2);
    expect(subject.watch.snapshot().items.map((row) => row.id)).toEqual(['b']);
  });

  it('forgets every row on stop, and drops a read that lands after it', async () => {
    const subject = harness();
    subject.watch.refresh();
    await subject.answer(['a']);

    subject.watch.refresh();
    subject.watch.stop();
    await subject.answer(['signed-out-account']);

    expect(subject.watch.snapshot()).toEqual({ items: [], complete: false });
  });
});
