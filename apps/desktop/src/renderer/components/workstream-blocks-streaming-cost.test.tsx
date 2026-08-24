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
function measureTailAppends(initialText: string): { mount: number; updates: number[] } {
  let text = initialText;
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
  const onResolveSuggestion = vi.fn(async () => undefined);
  const view = render(
    <Profiler id="streaming-cost" onRender={onRender}>
      <MessageBlock
        message={message(text)}
        onAnswerElicitation={onAnswerElicitation}
        onResolveSuggestion={onResolveSuggestion}
      />
    </Profiler>,
  );
  for (let index = 0; index < 10; index += 1) {
    text += 'more streamed tail text ';
    view.rerender(
      <Profiler id="streaming-cost" onRender={onRender}>
        <MessageBlock
          message={message(text)}
          onAnswerElicitation={onAnswerElicitation}
          onResolveSuggestion={onResolveSuggestion}
        />
      </Profiler>,
    );
  }
  view.unmount();
  const [mount, ...updates] = durations;
  return { mount: mount!, updates };
}

describe('streaming markdown commit cost', () => {
  it('appends to the tail without re-parsing the settled segments', () => {
    let text = '';
    for (let i = 0; i < 40; i += 1) {
      text += `## Heading ${i}\n\nA paragraph of reasonable length repeated to give the parser work to do, with **bold** and \`code\`.\n\n\`\`\`ts\nconst value${i} = ${i};\n\`\`\`\n\n`;
    }
    const { mount, updates } = measureTailAppends(text);
    expect(updates).toHaveLength(10);
    const updateTotal = updates.reduce((total, duration) => total + duration, 0);
    expect(updateTotal).toBeLessThan(mount);
  });

  it('appends to the tail of a list-dominant reply without re-parsing the settled items', () => {
    // The shape the first version of the splitter missed entirely: a reply
    // that is mostly a list. Every candidate blank-line cut point is a list
    // line, so without per-item cuts nothing settles and every commit
    // re-parses the whole body — at the paced reveal's commit rate. One loose
    // and one tight list, both long enough that a defeated split shows up as
    // updates costing multiples of the mount.
    let text = 'Here is the plan:\n\n';
    for (let i = 0; i < 60; i += 1) {
      text += `- Step ${i}: a full sentence describing what this step of the plan does and why.\n\n`;
    }
    text += 'And the checklist:\n\n';
    for (let i = 0; i < 60; i += 1) {
      text += `${i + 1}. Check item ${i} with enough words to make the parser do real work.\n`;
    }
    text += '\n';
    const { mount, updates } = measureTailAppends(text);
    expect(updates).toHaveLength(10);
    const updateTotal = updates.reduce((total, duration) => total + duration, 0);
    expect(updateTotal).toBeLessThan(mount);
  });
});
