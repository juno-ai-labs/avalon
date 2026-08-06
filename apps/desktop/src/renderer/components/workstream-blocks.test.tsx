import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ElicitationData, Message } from '../lib/types';
import { ElicitationPanel, MessageBlock } from './workstream-blocks';

const copyText = vi.hoisted(() => vi.fn());

vi.mock('../lib/platform', () => ({
  desktopBridge: () => ({ copyText }),
}));
vi.mock('thinking-orbs', () => ({
  ThinkingOrb: ({ paused = false, size, state }: { paused?: boolean; size: number; state: string }) => (
    <span data-paused={String(paused)} data-size={size} data-state={state} data-testid="thinking-orb" />
  ),
}));

afterEach(() => vi.useRealTimers());

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

describe('MessageBlock model timing', () => {
  it('live-counts an active provider stream and settles its wording when complete', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-05T12:00:00.000Z'));
    const activeMessage: Message = {
      ...baseMessage,
      id: 'thought-one',
      authorType: 'agent',
      author: undefined,
      messageType: 'thought',
      thoughtEvent: { status: 'started', durationMs: 82_000, startedAt: Date.now() },
    };
    const { container, rerender } = render(<MessageBlock {...actions} message={activeMessage} />);

    expect(screen.getByText('working for 1m 22s')).toBeInTheDocument();
    expect(container.querySelector('.agent-work-timing')).toHaveClass('agent-work-timing-active');
    expect(screen.getByTestId('thinking-orb')).toHaveAttribute('data-state', 'solving');
    expect(screen.getByTestId('thinking-orb')).toHaveAttribute('data-size', '20');
    expect(screen.getByTestId('thinking-orb')).toHaveAttribute('data-paused', 'false');

    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(screen.getByText('working for 1m 23s')).toBeInTheDocument();

    rerender(
      <MessageBlock
        {...actions}
        message={{
          ...activeMessage,
          thoughtEvent: { status: 'completed', durationMs: 83_000 },
        }}
      />,
    );
    expect(screen.getByText('worked for 1m 23s')).toBeInTheDocument();
    expect(container.querySelector('.agent-work-timing')).not.toHaveClass('agent-work-timing-active');
    expect(screen.getByTestId('thinking-orb')).toHaveAttribute('data-paused', 'true');
  });
});

const singleSelectElicitation: ElicitationData = {
  id: 'elicitation-single',
  prompt: 'What should Avalon do with these attachments?',
  responseType: 'single_select',
  options: [
    { value: 'compare', label: 'Compare offer vs. RSPA', description: 'Diff the two agreements and flag mismatches.' },
    { value: 'review', label: 'Review the draft offer', description: 'Flag risks and internal inconsistencies.' },
  ],
  minimumSelections: 1,
  maximumSelections: 1,
  status: 'open',
};

describe('ElicitationPanel', () => {
  it('submits a numbered single selection with the keyboard shortcut', async () => {
    const onAnswer = vi.fn(async () => undefined);
    const { container } = render(<ElicitationPanel elicitation={singleSelectElicitation} onAnswer={onAnswer} />);

    expect(screen.getByRole('button', { name: /Submit/u })).toBeDisabled();
    fireEvent.keyDown(container.querySelector('.elicitation-panel')!, { key: '1' });
    expect(screen.getByRole('radio', { name: /Compare offer vs\. RSPA/u })).toBeChecked();
    expect(screen.getByRole('button', { name: /Submit/u })).toBeEnabled();

    fireEvent.keyDown(container.querySelector('.elicitation-panel')!, { key: 'Enter', metaKey: true });
    await waitFor(() => expect(onAnswer).toHaveBeenCalledWith('compare', undefined));
  });

  it('combines checked options with an inline custom response', async () => {
    const onAnswer = vi.fn(async () => undefined);
    render(
      <ElicitationPanel
        elicitation={{
          ...singleSelectElicitation,
          id: 'elicitation-multi',
          responseType: 'multi_select',
          maximumSelections: 3,
        }}
        onAnswer={onAnswer}
      />,
    );

    fireEvent.click(screen.getByRole('checkbox', { name: /Compare offer vs\. RSPA/u }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Other response' }), { target: { value: 'Summarize the payment terms' } });
    expect(screen.getByRole('checkbox', { name: 'Other' })).toBeChecked();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Other' }).closest('.elicitation-option')!);
    expect(screen.getByRole('checkbox', { name: 'Other' })).not.toBeChecked();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Other' }).closest('.elicitation-option')!);
    fireEvent.click(screen.getByRole('button', { name: /Submit/u }));

    await waitFor(() => expect(onAnswer).toHaveBeenCalledWith(
      ['compare', 'Summarize the payment terms'],
      'Summarize the payment terms',
    ));
  });

  it('resumes explicitly when the person skips the question', async () => {
    const onAnswer = vi.fn(async () => undefined);
    render(<ElicitationPanel elicitation={singleSelectElicitation} onAnswer={onAnswer} />);

    fireEvent.click(screen.getByRole('button', { name: 'Skip' }));

    await waitFor(() => expect(onAnswer).toHaveBeenCalledWith(null));
  });

  it('collapses into the compact input bar and reopens without resolving the question', () => {
    const onAnswer = vi.fn(async () => undefined);
    render(<ElicitationPanel elicitation={singleSelectElicitation} onAnswer={onAnswer} />);

    expect(screen.queryByRole('button', { name: 'Dismiss question' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Collapse question' }));
    expect(screen.queryByRole('button', { name: /Submit/u })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Avalon needs input/u }));

    expect(screen.getByRole('button', { name: /Submit/u })).toBeInTheDocument();
    expect(onAnswer).not.toHaveBeenCalled();
  });

  it('shows only a custom answer after submission', () => {
    render(
      <ElicitationPanel
        elicitation={{
          ...singleSelectElicitation,
          prompt: 'Choose one: compare, review, or something else?',
          status: 'answered',
          answer: 'Summarize the payment terms',
        }}
        onAnswer={vi.fn(async () => undefined)}
      />,
    );

    expect(screen.getByLabelText('Elicitation response')).toHaveTextContent('Summarize the payment terms');
    expect(screen.queryByText('Choose one: compare, review, or something else?')).not.toBeInTheDocument();
    expect(screen.queryByText('Compare offer vs. RSPA')).not.toBeInTheDocument();
    expect(screen.queryByText('Review the draft offer')).not.toBeInTheDocument();
    expect(screen.queryByText('Other')).not.toBeInTheDocument();
  });

  it('shows only the selected option label after submission', () => {
    render(
      <ElicitationPanel
        elicitation={{ ...singleSelectElicitation, status: 'answered', answer: 'compare' }}
        onAnswer={vi.fn(async () => undefined)}
      />,
    );

    expect(screen.getByLabelText('Elicitation response')).toHaveTextContent('Compare offer vs. RSPA');
    expect(screen.queryByText(singleSelectElicitation.prompt)).not.toBeInTheDocument();
    expect(screen.queryByText('Review the draft offer')).not.toBeInTheDocument();
  });
});

describe('MessageBlock human identity', () => {
  it('renders a completed elicitation as a right-side human response', () => {
    const elicitationMessage: Message = {
      ...baseMessage,
      id: 'message-elicitation-answer',
      authorType: 'agent',
      author: undefined,
      messageType: 'elicitation',
      text: '',
      elicitation: { ...singleSelectElicitation, status: 'answered', answer: 'compare' },
    };

    render(<MessageBlock {...actions} currentUserId="user-adam" message={elicitationMessage} />);

    const response = screen.getByLabelText('Human elicitation response');
    expect(response).toHaveClass('human-message', 'own-human-message', 'elicitation-response-message');
    expect(response).not.toHaveClass('transcript-event');
    expect(screen.getByLabelText('Elicitation response')).toHaveClass('human-message-bubble');
    expect(screen.getByLabelText('Elicitation response')).toHaveTextContent('Compare offer vs. RSPA');
  });

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

  it('renders sent attachments outside the rounded human text bubble', () => {
    const message: Message = {
      ...baseMessage,
      attachments: [{
        id: 'attachment-one',
        fileName: 'reference.png',
        mimeType: 'image/png',
        sizeBytes: 128,
        contentAvailable: true,
        createdAt: '2026-07-31T19:19:00.000Z',
      }],
    };
    const loadAttachmentContent = vi.fn(async () => new Blob(['image'], { type: 'image/png' }));
    const onOpenAttachment = vi.fn();

    render(
      <MessageBlock
        {...actions}
        currentUserId="user-adam"
        loadAttachmentContent={loadAttachmentContent}
        message={message}
        onOpenAttachment={onOpenAttachment}
      />,
    );

    const humanMessage = screen.getByLabelText('Message from Adam');
    const attachments = humanMessage.querySelector<HTMLElement>('.message-attachments');
    const bubble = humanMessage.querySelector<HTMLElement>('.human-message-bubble');
    expect(attachments).toBeInTheDocument();
    expect(bubble).toHaveTextContent('Please investigate this.');
    expect(bubble).not.toContainElement(attachments);
    expect(attachments?.nextElementSibling).toBe(bubble);
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
