import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Message } from '../lib/types';
import type { CitationContext } from './markdown-citations';
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
 * What is counted is citation resolution, not elapsed time. Every settled
 * block in the sources below carries a `resource://` link, and the citation
 * cell calls `resolve` while it renders — so a settled segment that gets
 * re-parsed resolves its link again, and one whose memoised element is reused
 * resolves nothing. This used to compare `Profiler` durations, which made the
 * assertion a wall-clock budget it never meant to take: it failed a release
 * run on a loaded machine with `expected 150.557 to be less than 106.430`
 * while the memo was working perfectly. A count of renders is the fact the
 * test is after, and it does not move with the load on the runner.
 */
function resolvedCitationsPerCommit(initialText: string): { mount: number; updates: number[] } {
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
  const resolve = vi.fn((): undefined => undefined);
  // One context object for the whole run, deliberately. `MarkdownBody` derives
  // the citation render from this object's identity and publishes it through
  // context, which reaches every citation across the settled segments' memo —
  // so a fresh object per commit would re-render all of them and hide the very
  // thing this counts behind a change of the test's own making.
  const citations: CitationContext = { open: vi.fn(), resolve };
  const onAnswerElicitation = vi.fn(async () => undefined);
  const view = render(
    <MessageBlock
      citations={citations}
      message={message(text)}
      onAnswerElicitation={onAnswerElicitation}
    />,
  );
  const mount = resolve.mock.calls.length;
  const updates: number[] = [];
  for (let index = 0; index < 10; index += 1) {
    resolve.mockClear();
    text += 'more streamed tail text ';
    view.rerender(
      <MessageBlock
        citations={citations}
        message={message(text)}
        onAnswerElicitation={onAnswerElicitation}
      />,
    );
    updates.push(resolve.mock.calls.length);
  }
  view.unmount();
  return { mount, updates };
}

describe('streaming markdown commit cost', () => {
  it('appends to the tail without re-parsing the settled segments', () => {
    let text = '';
    for (let i = 0; i < 40; i += 1) {
      text += `## Heading ${i}\n\nA paragraph of reasonable length repeated to give the parser work to do, with **bold**, \`code\`, and [a source](resource://para-${i}).\n\n\`\`\`ts\nconst value${i} = ${i};\n\`\`\`\n\n`;
    }
    const { mount, updates } = resolvedCitationsPerCommit(text);
    // Every one of the forty paragraphs is parsed once, on the mount.
    expect(mount).toBe(40);
    expect(updates).toHaveLength(10);
    // Nothing at all on the appends: the open tail here is the trailing fenced
    // block, which carries no citation, and every paragraph before it is a
    // settled segment whose element is reused untouched.
    expect(updates).toEqual(new Array(10).fill(0));
  });

  it('appends to the tail of a list-dominant reply without re-parsing the settled items', () => {
    // The shape the first version of the splitter missed entirely: a reply
    // that is mostly a list. Every candidate blank-line cut point is a list
    // line, so without per-item cuts nothing settles and every commit
    // re-parses the whole body — at the paced reveal's commit rate. One loose
    // and one tight list, both long enough that a defeated split shows up as
    // every item being resolved again on every append.
    let text = 'Here is the plan:\n\n';
    for (let i = 0; i < 60; i += 1) {
      text += `- Step ${i}: a full sentence describing what this step of the plan does and why, per [its source](resource://step-${i}).\n\n`;
    }
    text += 'And the checklist:\n\n';
    for (let i = 0; i < 60; i += 1) {
      text += `${i + 1}. Check item ${i} with enough words to make the parser do real work, from [its source](resource://check-${i}).\n`;
    }
    text += '\n';
    const { mount, updates } = resolvedCitationsPerCommit(text);
    // All 120 items, once each.
    expect(mount).toBe(120);
    expect(updates).toHaveLength(10);
    // One per append — the still-growing last item, which is the open tail.
    // The 119 settled items are never rendered again.
    expect(updates).toEqual(new Array(10).fill(1));
  });
});
