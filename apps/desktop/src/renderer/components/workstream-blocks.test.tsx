import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ElicitationData, Message } from '../lib/types';
import { createConnectorMentionToken, ElicitationPanel, MessageBlock, withConnectorMentionLinks } from './workstream-blocks';

const copyText = vi.hoisted(() => vi.fn());

const getConnections = vi.hoisted(() => vi.fn(async () => [] as unknown[]));

vi.mock('../lib/platform', () => ({
  desktopBridge: () => ({ copyText, openSettings: vi.fn(async () => undefined) }),
}));
vi.mock('../lib/app-session', () => ({
  useAppSession: () => ({ api: { getConnections } }),
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

  it('explains an own turn nobody typed, without naming the person back to themselves', () => {
    // A suggested-work brief is stored as the selecting member's turn but is
    // written by Avalon. The label is the only thing on screen that accounts for
    // a long brief appearing under their own name, so it survives the header
    // suppression that own turns otherwise get.
    const briefMessage: Message = {
      ...baseMessage,
      id: 'message-brief',
      contextLabel: 'Expanded by Avalon from suggested work',
      text: 'Trace the failed release, identify the owner, and prepare the fix.',
    };
    render(<MessageBlock {...actions} currentUserId="user-adam" message={briefMessage} />);

    expect(screen.getByText('Expanded by Avalon from suggested work'))
      .toHaveClass('message-context-label');
    expect(screen.getByLabelText('Message from Adam')).toHaveClass('own-human-message');
    expect(screen.queryByText('Adam')).not.toBeInTheDocument();
    expect(document.querySelector('.message-author-dot')).not.toBeInTheDocument();
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

  it('shows an externally attributed Slack member as a coworker rather than Avalon', () => {
    const externalMessage: Message = {
      ...baseMessage,
      id: 'message-slack-taylor',
      authorType: 'external',
      author: undefined,
      externalActor: {
        provider: 'slack',
        providerAccountId: 'T123',
        providerUserId: 'U456',
        displayName: 'Taylor',
        avatarUrl: null,
      },
    };
    render(<MessageBlock {...actions} currentUserId="user-adam" message={externalMessage} />);

    expect(screen.getByLabelText('Message from Taylor · Slack')).toHaveClass('coworker-message');
    expect(screen.getByText('Taylor · Slack')).toHaveClass('message-author');
    expect(screen.queryByText('Avalon')).not.toBeInTheDocument();
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

  it('renders connection mentions as chips from their stored offsets', () => {
    const text = 'Ask @Google Drive and @Linear to sync.';
    const message: Message = {
      ...baseMessage,
      id: 'message-connector-mention',
      text,
      mentions: [
        { type: 'connector', connectorType: 'google_drive', startOffset: 4, endOffset: 17 },
        { type: 'connector', connectorType: 'linear', startOffset: 22, endOffset: 29 },
      ],
    };

    render(<MessageBlock {...actions} message={message} />);

    const drive = screen.getByText('@Google Drive').closest('.mention-chip');
    expect(drive).toHaveAttribute('data-connector-type', 'google_drive');
    expect(drive?.tagName).toBe('SPAN');
    expect(screen.getByText('@Linear').closest('.mention-chip'))
      .toHaveAttribute('data-connector-type', 'linear');
    expect(screen.queryByRole('link', { name: '@Google Drive' })).not.toBeInTheDocument();
    expect(document.querySelector('.markdown-body')).toHaveTextContent(text);
  });

  it('leaves connection text alone when its offsets do not name a mention', () => {
    const message: Message = {
      ...baseMessage,
      id: 'message-connector-mention-stale',
      text: 'Ask @Google Drive to sync.',
      mentions: [{ type: 'connector', connectorType: 'google_drive', startOffset: 0, endOffset: 3 }],
    };

    render(<MessageBlock {...actions} message={message} />);

    expect(document.querySelector('.mention-chip')).not.toBeInTheDocument();
    expect(document.querySelector('.markdown-body')).toHaveTextContent('Ask @Google Drive to sync.');
  });

  it('escapes connection labels and ignores overlapping or malformed ranges', () => {
    expect(withConnectorMentionLinks('Ping @Ops [beta]', [
      { type: 'connector', connectorType: 'ops', startOffset: 5, endOffset: 16 },
    ], 'tok')).toBe('Ping [@Ops \\[beta\\]](connector:tok:ops)');

    expect(withConnectorMentionLinks('Ping @Ops *now* & co', [
      { type: 'connector', connectorType: 'ops', startOffset: 5, endOffset: 20 },
    ], 'tok')).toBe('Ping [@Ops \\*now\\* \\& co](connector:tok:ops)');

    expect(withConnectorMentionLinks('Ping @Ops', [
      { type: 'connector', connectorType: 'ops', startOffset: 5, endOffset: 9 },
      { type: 'connector', connectorType: 'ops', startOffset: 6, endOffset: 9 },
    ], 'tok')).toBe('Ping [@Ops](connector:tok:ops)');

    expect(withConnectorMentionLinks('Ping @Ops', [
      { type: 'connector', connectorType: 'ops', startOffset: 5, endOffset: 40 },
      { type: 'person', personId: 'user-1', startOffset: 0, endOffset: 4 },
    ], 'tok')).toBe('Ping @Ops');
  });

  it('mints a distinct connector token per call', () => {
    expect(createConnectorMentionToken()).not.toBe(createConnectorMentionToken());
    expect(createConnectorMentionToken()).toMatch(/^[0-9a-z]+$/u);
  });

  it('does not chip a hand-authored connector link that no mention backs', () => {
    const message: Message = {
      ...baseMessage,
      id: 'message-connector-forged',
      authorType: 'agent',
      author: undefined,
      text: 'Routed through [@Slack workspace](connector:slack) already.',
    };

    render(<MessageBlock {...actions} message={message} />);

    expect(document.querySelector('.mention-chip')).not.toBeInTheDocument();
    expect(screen.getByText('@Slack workspace')).toHaveClass('mention-text-fallback');
    expect(screen.queryByRole('link', { name: '@Slack workspace' })).not.toBeInTheDocument();
  });

  it('does not let a forged link borrow a label from a genuine mention beside it', () => {
    const text = 'Ping @Ops and [@Ops](connector:ops) again';
    const message: Message = {
      ...baseMessage,
      id: 'message-connector-borrowed',
      authorType: 'agent',
      author: undefined,
      text,
      mentions: [{ type: 'connector', connectorType: 'ops', startOffset: 5, endOffset: 9 }],
    };

    render(<MessageBlock {...actions} message={message} />);

    // The genuine occurrence chips; the hand-authored one beside it does not.
    const chips = [...document.querySelectorAll('.mention-chip')];
    expect(chips).toHaveLength(1);
    expect(chips[0]).toHaveAttribute('data-connector-type', 'ops');
    expect(document.querySelector('.mention-text-fallback')).toHaveTextContent('@Ops');
  });

  it('renders a message carrying a malformed connector escape without throwing', () => {
    const message: Message = {
      ...baseMessage,
      id: 'message-connector-malformed',
      authorType: 'agent',
      author: undefined,
      text: 'See [broken](connector:%) and carry on.',
    };

    expect(() => render(<MessageBlock {...actions} message={message} />)).not.toThrow();
    expect(document.querySelector('.markdown-body')).toHaveTextContent('See broken and carry on.');
    expect(document.querySelector('.mention-chip')).not.toBeInTheDocument();
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

describe('MessageBlock system rows', () => {
  const systemMessage = (id: string, text: string): Message => ({
    ...baseMessage,
    id,
    authorType: 'system',
    author: undefined,
    messageType: 'system',
    text,
  });

  /**
   * jsdom lays nothing out, so the clamp cannot cut a real block here. These
   * getters stand in for one, and they answer the way a real clamped block
   * does: `clientHeight` is the five-line cap until the clamp comes off, and
   * `scrollHeight` is the whole content throughout. Modelling the lifted clamp
   * rather than freezing two numbers is the point — it is the state in which a
   * block that measured itself would report that it fits.
   */
  function stubHeights(contentHeight: number): void {
    const clampHeight = 82;
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      get(this: HTMLElement) { return this.hasAttribute('data-expanded') ? contentHeight : Math.min(contentHeight, clampHeight); },
    });
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', { configurable: true, get: () => contentHeight });
  }

  afterEach(() => {
    for (const name of ['clientHeight', 'scrollHeight']) Reflect.deleteProperty(HTMLElement.prototype, name);
  });

  const openControl = (): HTMLElement => screen.getByRole('button', { name: 'Show this note in full' });
  const closeControl = (): HTMLElement => screen.getByRole('button', { name: 'Show less of this note' });

  it('leaves a one-line note alone', () => {
    stubHeights(20);

    render(<MessageBlock {...actions} message={systemMessage('message-woken', 'Avalon woke this work stream up as scheduled.')} />);

    expect(screen.getByText('Avalon woke this work stream up as scheduled.')).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('renders a row whose text never arrived without a control or a crash', () => {
    stubHeights(0);

    render(<MessageBlock {...actions} message={{ ...systemMessage('message-empty', ''), text: undefined }} />);

    // The transcript deep-links to a row by this id, so the rewrite from a bare
    // div to a component has to keep it on the outermost element.
    expect(document.getElementById('message-message-empty')).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('clamps a run prompt, opens it, and closes it again', () => {
    stubHeights(1_640);
    const brief = 'You are writing the scheduled digest for Morgan Ellis in the Juno Labs workspace.';

    render(<MessageBlock {...actions} message={systemMessage('message-brief', brief)} />);

    // Clamped, not truncated: the whole brief is in the document from the
    // start, so opening it needs no fetch and a find on the page reaches it.
    expect(screen.getByText(brief)).not.toHaveAttribute('data-expanded');
    expect(openControl()).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(openControl());

    // The open block no longer overflows anything, so the control survives on
    // the last measurement taken while the clamp was on. Were it to re-measure
    // here it would remove itself on the click that opened the text, leaving no
    // way back to five lines.
    expect(screen.getByText(brief)).toHaveAttribute('data-expanded', 'true');
    expect(closeControl()).toHaveAttribute('aria-expanded', 'true');

    fireEvent.click(closeControl());

    expect(screen.getByText(brief)).not.toHaveAttribute('data-expanded');
    expect(openControl()).toBeInTheDocument();
  });

  it('takes its open state from the caller when the caller keeps it', () => {
    // What a virtualizing transcript needs: the row is unmounted when it leaves
    // the window and mounted again on the way back, and it has to come back the
    // way the reader left it. Local state cannot survive that, and the
    // virtualizer holds the measured height across the gap either way — so a
    // row that returned closed would shrink under a cache that expects it open.
    stubHeights(1_640);
    const expanded = new Set<string>();
    const disclosure = { expanded, onToggle: (id: string) => { expanded.add(id); } };
    const message = systemMessage('message-kept', 'An automation run prompt of some length');

    const { unmount } = render(<MessageBlock {...actions} message={message} systemRowDisclosure={disclosure} />);
    fireEvent.click(openControl());
    expect(expanded.has('message-kept')).toBe(true);
    unmount();

    render(<MessageBlock {...actions} message={message} systemRowDisclosure={disclosure} />);

    expect(screen.getByText('An automation run prompt of some length')).toHaveAttribute('data-expanded', 'true');
    expect(closeControl()).toBeInTheDocument();
  });
});

describe('MessageBlock tool rows', () => {
  const toolMessage = (id: string, toolEvent: NonNullable<Message['toolEvent']>): Message => ({
    ...baseMessage,
    id,
    authorType: 'agent',
    author: undefined,
    messageType: 'tool_event',
    text: undefined,
    toolEvent,
  });

  it('attributes a connector row to exactly one plugin', () => {
    render(<MessageBlock {...actions} message={toolMessage('message-connector', {
      id: 'tool-connector',
      name: 'Reviewed Google Drive · Work',
      summary: 'Found the authorized Drive folder',
      status: 'completed',
      plugin: { pluginId: 'plugin_google_2', displayName: 'Google Drive · Work', icon: 'brand-google-drive' },
    })} />);

    expect(screen.getByRole('img', { name: 'Plugin: Google Drive · Work' })).toBeVisible();
    expect(screen.getAllByRole('img')).toHaveLength(1);
  });

  it('leaves a web research row unattributed', () => {
    render(<MessageBlock {...actions} message={toolMessage('message-web', {
      id: 'tool-web',
      name: 'Searched the public web',
      summary: 'Web search completed',
      status: 'completed',
    })} />);

    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.getByText('Searched the public web')).toBeVisible();
  });
});

describe('MessageBlock connector cards', () => {
  it('renders a connector-cards row as live cards rather than a system note', async () => {
    getConnections.mockResolvedValueOnce([{
      id: 'connection-slack',
      modelPluginId: 'plugin',
      connectorType: 'slack',
      displayName: 'Slack',
      scope: 'workspace',
      status: 'healthy',
      capabilities: ['slack.agent'],
    }]);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(
      <QueryClientProvider client={client}>
        <MessageBlock
          {...actions}
          message={{
            ...baseMessage,
            id: 'message-connector-cards',
            authorType: 'agent',
            author: undefined,
            messageType: 'connector_cards',
            // The row still carries the sentence an older client would show,
            // which must not be what this one renders.
            text: 'Connect Slack or GitHub to Avalon.',
            connectorCards: {
              heading: 'Connect what you already use',
              cards: [{ offeringId: 'slack', scope: 'workspace' }, { offeringId: 'github' }],
            },
          }}
        />
      </QueryClientProvider>,
    );

    expect(screen.queryByText('Connect Slack or GitHub to Avalon.')).toBeNull();
    expect(screen.getByRole('heading', { name: 'Connect what you already use' })).toBeVisible();
    await waitFor(() => expect(screen.getByText('Connected')).toBeVisible());
    expect(screen.getByText('Not connected')).toBeVisible();
  });
});
