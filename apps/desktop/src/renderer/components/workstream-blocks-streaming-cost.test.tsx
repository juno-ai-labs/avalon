import { render } from '@testing-library/react';
import { Profiler } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { Message } from '../lib/types';
import { MessageBlock } from './workstream-blocks';

vi.mock('../lib/platform', () => ({
  desktopBridge: () => ({ copyText: vi.fn() }),
  desktopServicesAvailable: () => false,
}));

/**
 * A tail-only append to a long streaming message must not re-parse the settled
 * body. The paced reveal commits up to once per painted frame, so a commit
 * whose cost is O(reply length) turns a long reply into a slideshow — the
 * exact regression this suite pins, measured through `MessageBlock` because
 * that is the path the transcript renders through and the path a defeated
 * memo hides in (a `mentions = []` default two components up was enough).
 *
 * The assertion is a ratio, not a wall-clock number: with the segment memo
 * working, ten tail appends together cost a few percent of the initial parse;
 * with it defeated, each append re-parses everything and the ten together
 * cost several times the mount. The factor between those outcomes is ~50x,
 * so comparing the sums stays meaningful on a machine of any speed.
 */
describe('streaming markdown commit cost', () => {
  it('appends to the tail without re-parsing the settled segments', () => {
    let text = '';
    for (let i = 0; i < 40; i += 1) {
      text += `## Heading ${i}\n\nA paragraph of reasonable length repeated to give the parser work to do, with **bold** and \`code\`.\n\n\`\`\`ts\nconst value${i} = ${i};\n\`\`\`\n\n`;
    }
    const message = (body: string): Message => ({
      id: 'message-stream',
      workstreamId: 'workstream-one',
      sequenceNumber: 5,
      authorType: 'agent',
      messageType: 'text',
      text: body,
      createdAt: '2026-08-23T12:00:00.000Z',
      streaming: true,
    });
    const durations: number[] = [];
    const onRender = (_id: string, _phase: string, actualDuration: number): void => {
      durations.push(actualDuration);
    };
    const onAnswerElicitation = vi.fn(async () => undefined);
    const view = render(
      <Profiler id="streaming-cost" onRender={onRender}>
        <MessageBlock message={message(text)} onAnswerElicitation={onAnswerElicitation} />
      </Profiler>,
    );
    for (let i = 0; i < 10; i += 1) {
      text += 'more streamed tail text ';
      view.rerender(
        <Profiler id="streaming-cost" onRender={onRender}>
          <MessageBlock message={message(text)} onAnswerElicitation={onAnswerElicitation} />
        </Profiler>,
      );
    }
    const [mount, ...updates] = durations;
    expect(updates).toHaveLength(10);
    const updateTotal = updates.reduce((total, duration) => total + duration, 0);
    expect(updateTotal).toBeLessThan(mount!);
  });
});
