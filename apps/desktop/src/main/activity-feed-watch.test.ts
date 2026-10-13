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
  const failures: Array<(error: Error) => void> = [];
  const fetchPage = vi.fn(() => new Promise<ActivityPage>((resolve, reject) => {
    answers.push(resolve);
    failures.push(reject);
  }));
  const onChange = vi.fn();
  const watch = new ActivityFeedWatch({ fetchPage, onChange, logWarning: vi.fn() });
  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
  const answer = async (ids: string[]): Promise<void> => {
    failures.shift();
    answers.shift()!({ items: ids.map(item), nextCursor: null });
    await settle();
  };
  const fail = async (): Promise<void> => {
    answers.shift();
    failures.shift()!(new Error('request timed out'));
    await settle();
  };
  return { watch, fetchPage, onChange, answer, fail };
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

  it('says a read failed until the next one lands, keeping the rows it held', async () => {
    const subject = harness();
    subject.watch.refresh();
    await subject.answer(['a']);
    expect(subject.watch.missedLastRead()).toBe(false);

    subject.watch.refresh();
    await subject.fail();
    expect(subject.watch.missedLastRead()).toBe(true);
    expect(subject.watch.snapshot()).toEqual({ items: [item('a')], complete: true });

    subject.watch.refresh();
    await subject.answer(['b']);
    expect(subject.watch.missedLastRead()).toBe(false);
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
