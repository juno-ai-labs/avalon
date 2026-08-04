import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Message } from '../lib/types';
import { MessageBlock } from './workstream-blocks';

const copyText = vi.hoisted(() => vi.fn());

vi.mock('../lib/platform', () => ({
  desktopBridge: () => ({ copyText }),
}));

const baseMessage: Message = {
  id: 'message-human',
  workstreamId: 'workstream-one',
  sequenceNumber: 1,
  authorType: 'human',
  author: { id: 'user-adam', name: 'Adam', email: 'adam@example.com', timezone: 'America/Los_Angeles' },
  messageType: 'text',
  text: 'Please investigate this.',
  createdAt: '2026-07-31T19:20:00.000Z',
};

const actions = {
  onAnswerElicitation: vi.fn(async () => undefined),
  onResolveSuggestion: vi.fn(async () => undefined),
};

describe('MessageBlock human identity', () => {
  it('renders an optimistic turn as a neutral skeleton instead of previewing client text', () => {
    render(
      <MessageBlock
        {...actions}
        currentUserId="user-adam"
        message={{ ...baseMessage, deliveryState: 'sending', text: 'Client-only mention rendering' }}
      />,
    );

    const skeleton = screen.getByLabelText('Sending message');
    expect(skeleton).toHaveAttribute('aria-busy', 'true');
    expect(skeleton).toHaveClass('is-sending');
    expect(skeleton.querySelector('.message-skeleton')).toBeInTheDocument();
    expect(screen.queryByText('Client-only mention rendering')).not.toBeInTheDocument();
  });

  it('keeps the signed-in person implicit on their own compact prompt', () => {
    render(<MessageBlock {...actions} currentUserId="user-adam" message={baseMessage} />);

    expect(screen.getByLabelText('Message from Adam')).toHaveClass('own-human-message');
    expect(screen.queryByText('Adam')).not.toBeInTheDocument();
  });

  it('shows compact identity for a coworker prompt', () => {
    const coworkerMessage: Message = {
      ...baseMessage,
      id: 'message-sam',
      author: { id: 'user-sam', name: 'Sam', email: 'sam@example.com', timezone: 'America/Los_Angeles' },
    };
    render(<MessageBlock {...actions} currentUserId="user-adam" message={coworkerMessage} />);

    expect(screen.getByLabelText('Message from Sam')).toHaveClass('coworker-message');
    expect(screen.getByText('Sam')).toHaveClass('message-author');
    expect(document.querySelector('.message-author-dot')).toBeInTheDocument();
  });
});

describe('MessageBlock markdown', () => {
  it('renders person links as non-navigating chips resolved from mention metadata', () => {
    const personId = '00000000-0000-7000-8000-000000000042';
    const message: Message = {
      ...baseMessage,
      id: 'message-person-mention',
      authorType: 'agent',
      author: undefined,
      text: `Ask [@Spoofed label](person:${personId}) for a review.`,
      mentions: [{
        type: 'person',
        personId,
        displayName: 'Ada Lovelace',
        avatarUrl: 'https://example.com/ada.png',
        startOffset: 4,
        endOffset: 65,
      }],
    };

    render(<MessageBlock {...actions} message={message} />);

    const chip = screen.getByText('@Ada Lovelace').closest('.mention-chip');
    expect(chip).toHaveAttribute('data-person-id', personId);
    expect(chip?.tagName).toBe('SPAN');
    expect(screen.queryByRole('link', { name: '@Ada Lovelace' })).not.toBeInTheDocument();
    expect(screen.queryByText('@Spoofed label')).not.toBeInTheDocument();
    expect(chip?.querySelector('img')).toHaveAttribute('src', 'https://example.com/ada.png');
  });

  it('keeps person Markdown inert when authoritative mention metadata is absent', () => {
    const personId = '00000000-0000-7000-8000-000000000043';
    const message: Message = {
      ...baseMessage,
      id: 'message-person-mention-fallback',
      authorType: 'agent',
      author: undefined,
      text: `Ask [@Grace Hopper](person:${personId}).`,
    };

    render(<MessageBlock {...actions} message={message} />);

    expect(screen.getByText('@Grace Hopper')).toHaveClass('mention-text-fallback');
    expect(document.querySelector('.mention-chip')).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: '@Grace Hopper' })).not.toBeInTheDocument();
  });

  it('does not treat legacy mention links as person chips', () => {
    const personId = '00000000-0000-7000-8000-000000000044';
    const message: Message = {
      ...baseMessage,
      id: 'message-legacy-mention',
      authorType: 'agent',
      author: undefined,
      text: `Ask [@Legacy](mention:${personId}).`,
    };

    render(<MessageBlock {...actions} message={message} />);

    expect(document.querySelector('.mention-chip')).not.toBeInTheDocument();
    expect(screen.getByText('@Legacy').closest('a')).toHaveAttribute('href', '');
  });

  it('renders GFM structure with external links, inline code, tables, and highlighted code blocks', () => {
    const markdownMessage: Message = {
      ...baseMessage,
      id: 'message-markdown',
      authorType: 'agent',
      author: undefined,
      text: [
        '## Harness API',
        '',
        'Read **the docs** at [docs/bind.md](https://example.com/docs/bind.md) and use `load_tool_group`.',
        '',
        '| Gate | Result |',
        '| --- | --- |',
        '| `pnpm typecheck` | Pass |',
        '',
        '---',
        '',
        '```ts',
        'interface ToolGroup {',
        '  name: string;',
        '}',
        '```',
      ].join('\n'),
    };

    render(<MessageBlock {...actions} message={markdownMessage} />);

    expect(screen.getByRole('heading', { name: 'Harness API' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'docs/bind.md' })).toHaveAttribute('rel', 'noopener noreferrer');
    expect(screen.getByRole('link', { name: 'docs/bind.md' })).toHaveAttribute('target', '_blank');
    expect(screen.getByText('load_tool_group')).toHaveClass('markdown-inline-code');
    expect(screen.getByRole('table')).toHaveAttribute('data-column-count', '2');
    expect(screen.getByRole('table').parentElement).toHaveClass('markdown-table-scroll');
    expect(document.querySelector('.markdown-body hr')).toBeInTheDocument();
    expect(document.querySelector('.markdown-code-block')).toHaveAttribute('data-language', 'ts');
    expect(screen.getByRole('button', { name: 'Copy code' })).toBeInTheDocument();
  });

  it('tracks the column count so wide tables overflow instead of compressing', () => {
    const wideTableMessage: Message = {
      ...baseMessage,
      id: 'message-wide-table',
      authorType: 'agent',
      author: undefined,
      text: [
        '| Service | Region | Status | Version | Owner | Last deploy | Requests | Error rate |',
        '| --- | --- | --- | --- | --- | --- | --- | --- |',
        '| API | US West | Healthy | 2.8.4 | Platform | 12m ago | 48,291 | 0.03% |',
      ].join('\n'),
    };

    render(<MessageBlock {...actions} message={wideTableMessage} />);

    const table = screen.getByRole('table');
    expect(table).toHaveAttribute('data-column-count', '8');
    expect(table.parentElement).toHaveClass('fade-x', 'fade-scrollbar-safe-x');
  });

  it('renders unsupported fenced languages as plain text without losing their label', () => {
    const message: Message = {
      ...baseMessage,
      id: 'message-unsupported-language',
      authorType: 'agent',
      author: undefined,
      text: '```mermaid\ngraph TD; A-->B\n```',
    };

    render(<MessageBlock {...actions} message={message} />);

    expect(document.querySelector('.markdown-code-block')).toHaveAttribute('data-language', 'mermaid');
    expect(document.querySelector('.prism-code')).toHaveClass('language-plain');
    expect(screen.getByText('graph TD; A-->B')).toBeVisible();
  });

  it('keeps code copy retryable when clipboard access is unavailable', async () => {
    copyText.mockRejectedValueOnce(new Error('clipboard unavailable'));
    const message: Message = {
      ...baseMessage,
      id: 'message-copy-failure',
      authorType: 'agent',
      author: undefined,
      text: '```ts\nconst ready = true;\n```',
    };

    render(<MessageBlock {...actions} message={message} />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy code' }));

    await waitFor(() => expect(copyText).toHaveBeenCalledWith('const ready = true;'));
    expect(screen.getByRole('button', { name: 'Copy code' })).toBeEnabled();
  });
});
