import * as Tooltip from '@radix-ui/react-tooltip';
import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MessageByline } from './message-byline';

const at = '2026-09-10T12:00:00.000Z';

function partsOf(header: Element): string[] {
  return Array.from(header.children).map((child) => child.className || child.tagName.toLowerCase());
}

// The host provider is not required — `RelativeTime` brings its own — but the
// app has one above every feed, so rendering under one here is the arrangement
// production actually uses, and it proves the nested pair coexists.
describe('MessageByline', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 20, 3, 48));
  });
  afterEach(() => vi.useRealTimers());

  it('adds calendar context as an open message passes twelve hours', async () => {
    const createdAt = new Date(2026, 9, 19, 15, 48).toISOString();
    const { container } = render(<MessageByline align="start" author="Rally" createdAt={createdAt} />);

    expect(container.querySelector('time')).toHaveTextContent(/^3:48PM$/u);
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(container.querySelector('time')).toHaveTextContent('Oct 19 · 3:48PM');
    expect(container.querySelector('time')).toHaveAttribute('dateTime', createdAt);
  });

  it('lays the same parts down name-first on the leading edge and name-last on the trailing edge', () => {
    const { container, rerender } = render(
      <Tooltip.Provider>
        <MessageByline align="start" author="Rally" contextLabel="From a brief" createdAt={at} workSummary="Worked for 3s" />
      </Tooltip.Provider>,
    );
    expect(partsOf(container.querySelector('header')!)).toEqual([
      'message-author', 'message-context-label', 'time', 'message-work-summary',
    ]);

    rerender(
      <Tooltip.Provider>
        <MessageByline align="end" author="Adam" contextLabel="From a brief" createdAt={at} workSummary="Worked for 3s" />
      </Tooltip.Provider>,
    );
    expect(partsOf(container.querySelector('header')!)).toEqual([
      'message-work-summary', 'time', 'message-context-label', 'message-author',
    ]);
  });

  it('keeps the person dot inside the name so the two travel together', () => {
    const { container } = render(
      <Tooltip.Provider>
        <MessageByline align="end" author="Adam" createdAt={at} dot />
      </Tooltip.Provider>,
    );
    const author = container.querySelector('.message-author')!;
    expect(author.querySelector('.message-author-dot')).toHaveAttribute('aria-hidden', 'true');
    expect(author).toHaveTextContent('Adam');
    expect(container.querySelector('header > .message-author-dot')).toBeNull();
  });

  it('leaves Rally without a dot and dates the turn', () => {
    const { container } = render(
      <Tooltip.Provider>
        <MessageByline align="start" author="Rally" createdAt={at} />
      </Tooltip.Provider>,
    );
    expect(container.querySelector('.message-author-dot')).toBeNull();
    expect(container.querySelector('time')).toHaveAttribute('dateTime', at);
  });

  it('leads with an avatar holding the initial it is given, inside the name', () => {
    const { container } = render(
      <Tooltip.Provider>
        <MessageByline align="start" author="Rally" createdAt={at} initial="R" />
      </Tooltip.Provider>,
    );
    const author = container.querySelector('header > .message-author')!;
    expect(author.firstElementChild).toHaveClass('message-author-avatar');
    expect(author.firstElementChild).toHaveTextContent('R');
    expect(author.firstElementChild).toHaveAttribute('aria-hidden', 'true');
  });
});
