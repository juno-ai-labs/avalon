import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MessageExportRequest, MessageExportResult } from '../../common/message-export';
import type { ElicitationData, Message } from '../lib/types';
import {
  createConnectorMentionToken,
  ElicitationPanel,
  MarkdownBody,
  MessageBlock,
  splitStreamingMarkdown,
  withConnectorMentionLinks,
} from './workstream-blocks';

const copyText = vi.hoisted(() => vi.fn());
const exportMessage = vi.hoisted(() => vi.fn<(request: MessageExportRequest) => Promise<MessageExportResult>>(
  async () => ({ saved: true }),
));
const desktopServicesAvailable = vi.hoisted(() => vi.fn(() => true));
const reportTelemetryProductIntent = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock('../lib/platform', () => ({
  desktopBridge: () => ({ copyText, exportMessage, reportTelemetryProductIntent }),
  desktopServicesAvailable,
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

describe('MessageBlock suggested context', () => {
  const suggestionMessage: Message = {
    ...baseMessage,
    id: 'suggestion-suggestion-one',
    authorType: 'system',
    author: undefined,
    messageType: 'activity_suggestion',
    text: undefined,
    activitySuggestion: {
      id: 'suggestion-one',
      title: 'Review requested on the privacy fix',
      source: 'GitHub',
      reason: 'The pull request changes the same work-stream authorization boundary.',
      status: 'pending',
    },
  };

  it('renders the evidence and resolves either action through the suggestion id', async () => {
    const onResolveSuggestion = vi.fn(async () => undefined);
    render(
      <MessageBlock
        {...actions}
        message={suggestionMessage}
        onResolveSuggestion={onResolveSuggestion}
      />,
    );

    expect(screen.getByText('Suggested context')).toBeInTheDocument();
    expect(screen.getByText('Review requested on the privacy fix')).toBeInTheDocument();
    expect(screen.getByText('GitHub')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Add to work stream/u }));

    await waitFor(() => expect(onResolveSuggestion).toHaveBeenCalledWith('suggestion-one', 'accept'));
  });

  it('renders an accepted suggestion without offering another decision', () => {
    render(
      <MessageBlock
        {...actions}
        message={{
          ...suggestionMessage,
          activitySuggestion: { ...suggestionMessage.activitySuggestion!, status: 'accepted' },
        }}
      />,
    );

    expect(screen.getByText('Added to this work stream')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Add to work stream/u })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Dismiss/u })).not.toBeInTheDocument();
  });
});

const singleSelectElicitation: ElicitationData = {
  id: 'elicitation-single',
  prompt: 'What should Rally do with these attachments?',
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
  it('repairs TeX in the question and in the option labels beside it', () => {
    // The options come from the same model call as the question: a repaired
    // heading above an unrepaired option reads as a bug in the repair itself.
    const elicitation: ElicitationData = {
      ...singleSelectElicitation,
      prompt: 'Move Backlog $\\rightarrow$ Review now?',
      options: [
        { value: 'yes', label: 'Backlog $\\rightarrow$ Review', description: 'Runs the checks $\\times$ two, and costs $50.' },
        { value: 'no', label: 'Hold', description: 'Wait for sign-off.' },
      ],
    };

    render(<ElicitationPanel elicitation={elicitation} onAnswer={vi.fn(async () => undefined)} />);

    expect(screen.getByText('Move Backlog → Review now?')).toBeInTheDocument();
    expect(screen.getByText('Backlog → Review')).toBeInTheDocument();
    expect(screen.getByText('Runs the checks × two, and costs $50.')).toBeInTheDocument();
  });

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

  it('does not answer on a Cmd+Enter that is only committing an IME composition', async () => {
    const onAnswer = vi.fn(async () => undefined);
    render(
      <ElicitationPanel
        elicitation={{
          ...singleSelectElicitation,
          id: 'elicitation-text',
          responseType: 'text',
          options: undefined,
        }}
        onAnswer={onAnswer}
      />,
    );

    const response = screen.getByRole('textbox', { name: 'Response' });
    fireEvent.change(response, { target: { value: 'nihao' } });

    // A chord carries the composition flag like any other key, and this answer
    // is what resumes a paused run: submitting here sends the pre-conversion
    // reading in place of the characters the person was typing.
    fireEvent.keyDown(response, { key: 'Enter', metaKey: true, isComposing: true });
    fireEvent.keyDown(response, { key: 'Enter', ctrlKey: true, keyCode: 229 });
    expect(onAnswer).not.toHaveBeenCalled();

    fireEvent.keyDown(response, { key: 'Enter', metaKey: true });
    await waitFor(() => expect(onAnswer).toHaveBeenCalledWith('nihao', undefined));
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
    fireEvent.click(screen.getByRole('button', { name: /Rally needs input/u }));

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
      authorType: 'human',
      author: { id: 'user-adam', name: 'Adam', email: 'adam@example.com', timezone: 'UTC' },
      messageType: 'elicitation',
      text: '',
      elicitation: { ...singleSelectElicitation, status: 'answered', answer: 'compare' },
    };

    render(<MessageBlock {...actions} currentUserId="user-adam" message={elicitationMessage} />);

    const response = screen.getByLabelText('Your elicitation response');
    expect(response).toHaveClass('human-message', 'own-human-message', 'elicitation-response-message');
    expect(response).not.toHaveClass('transcript-event');
    expect(screen.getByLabelText('Elicitation response')).toHaveClass('human-message-bubble');
    expect(screen.getByLabelText('Elicitation response')).toHaveTextContent('Compare offer vs. RSPA');
  });

  it('keeps a coworker visible on their elicitation response', () => {
    const elicitationMessage: Message = {
      ...baseMessage,
      id: 'message-coworker-elicitation-answer',
      authorType: 'human',
      author: { id: 'user-sam', name: 'Sam', email: 'sam@example.com', timezone: 'UTC' },
      messageType: 'elicitation',
      text: '',
      elicitation: { ...singleSelectElicitation, status: 'answered', answer: 'compare' },
    };

    render(<MessageBlock {...actions} currentUserId="user-adam" message={elicitationMessage} />);

    expect(screen.getByLabelText('Response from Sam')).toHaveClass('coworker-message');
    expect(screen.getByText('Sam')).toBeInTheDocument();
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
    // written by Rally. The label is the only thing on screen that accounts for
    // a long brief appearing under their own name, so it survives the header
    // suppression that own turns otherwise get.
    const briefMessage: Message = {
      ...baseMessage,
      id: 'message-brief',
      contextLabel: 'Expanded by Rally from suggested work',
      text: 'Trace the failed release, identify the owner, and prepare the fix.',
    };
    render(<MessageBlock {...actions} currentUserId="user-adam" message={briefMessage} />);

    expect(screen.getByText('Expanded by Rally from suggested work'))
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

  it('shows an externally attributed Slack member as a coworker rather than Rally', () => {
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
    expect(screen.queryByText('Rally')).not.toBeInTheDocument();
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
  it('reports a successful response copy by opaque message and work-stream id', async () => {
    copyText.mockReset().mockResolvedValue(undefined);
    reportTelemetryProductIntent.mockReset().mockResolvedValue(undefined);
    const message: Message = {
      ...baseMessage,
      id: '00000000-0000-4000-8000-000000000301',
      workstreamId: '00000000-0000-4000-8000-000000000302',
      authorType: 'agent',
      author: undefined,
      text: 'The bounded response.',
    };

    render(<MessageBlock {...actions} message={message} />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy response' }));

    await waitFor(() => expect(copyText).toHaveBeenCalledWith(message.text));
    expect(reportTelemetryProductIntent).toHaveBeenCalledWith({
      kind: 'content_copied', contentType: 'message_response', resourceType: 'message',
      resourceId: message.id, workstreamId: message.workstreamId,
    });
  });

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

  it('repairs a model\'s TeX without disturbing the mention offsets beside it', () => {
    // The offsets are measured against the stored text, so normalization has to
    // run after the links are injected. Reversing the two shifts the offsets
    // past the first repair, so a slice no longer starts with `@` and its
    // mention is silently dropped rather than chipped.
    const message: Message = {
      ...baseMessage,
      authorType: 'agent',
      id: 'message-connector-mention-tex',
      text: 'Ask @Google Drive to move Backlog $\\rightarrow$ Done, and @Linear to log it.',
      mentions: [
        { type: 'connector', connectorType: 'google_drive', startOffset: 4, endOffset: 17 },
        { type: 'connector', connectorType: 'linear', startOffset: 58, endOffset: 65 },
      ],
    };

    render(<MessageBlock {...actions} message={message} />);

    expect(screen.getByText('@Google Drive').closest('.mention-chip'))
      .toHaveAttribute('data-connector-type', 'google_drive');
    expect(screen.getByText('@Linear').closest('.mention-chip'))
      .toHaveAttribute('data-connector-type', 'linear');
    expect(document.querySelector('.markdown-body')).toHaveTextContent('Backlog → Done');
    expect(document.querySelector('.markdown-body')?.textContent).not.toContain('rightarrow');
  });

  it('shows a person\'s own message exactly as they typed it, TeX and all', () => {
    // The repair is of what a model wrote. A member who types `$\rightarrow$`
    // gets a bubble that agrees with their keyboard, not a rewrite.
    const message: Message = {
      ...baseMessage,
      id: 'message-human-tex',
      text: 'I typed $\\rightarrow$ deliberately, and paid $50.',
    };

    render(<MessageBlock {...actions} message={message} />);

    expect(document.querySelector('.human-message-bubble')?.textContent)
      .toContain('$\\rightarrow$ deliberately, and paid $50.');
  });

  it('renders a person: target that is not an id as text, never as a link', () => {
    // `defaultUrlTransform` would empty the href; the urlTransform whitelist
    // is what lets the fallback branch see the scheme and refuse the anchor.
    const message: Message = {
      ...baseMessage,
      authorType: 'agent',
      id: 'message-person-not-an-id',
      text: 'Ask [@Ada](person:ada-lovelace) please.',
    };

    render(<MessageBlock {...actions} message={message} />);

    expect(screen.getByText('@Ada').closest('.mention-text-fallback')).not.toBeNull();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
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
    expect(screen.getByText('TypeScript')).toHaveClass('markdown-code-language');
    const copyButton = screen.getByRole('button', { name: 'Copy code' });
    expect(copyButton).toBeInTheDocument();
    // The point of the header is that the button sits outside the scrolling
    // `pre`, reachable at any scroll position — this pins that structure down
    // rather than just the button's presence somewhere in the document.
    expect(copyButton.closest('.markdown-code-block-header')).not.toBeNull();
  });

  it('gives an unlabelled fence no language caption, just the copy button', () => {
    const message: Message = {
      ...baseMessage,
      id: 'message-unlabelled-fence',
      authorType: 'agent',
      author: undefined,
      text: '```\nconst ready = true;\n```',
    };

    render(<MessageBlock {...actions} message={message} />);

    expect(document.querySelector('.markdown-code-block')).toHaveAttribute('data-language', 'plain');
    expect(document.querySelector('.markdown-code-language')).toHaveTextContent('');
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
    expect(screen.getByText('Mermaid')).toHaveClass('markdown-code-language');
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

describe('MessageBlock export actions', () => {
  const agentMessage: Message = {
    ...baseMessage,
    id: 'message-agent-export',
    authorType: 'agent',
    author: undefined,
    text: '## Quarterly pipeline review\n\nThe **Northwind** renewal is at risk.',
    createdAt: '2026-08-13T09:00:00.000Z',
  };

  beforeEach(() => {
    vi.setSystemTime(new Date('2026-08-13T18:00:00.000Z'));
    // The renderer reads the Rally mark out of its own bundle before it can
    // ask for an export; jsdom has no server to fetch it from.
    vi.stubGlobal('fetch', vi.fn(async () => ({
      blob: async () => new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' }),
    })));
  });

  afterEach(() => {
    vi.useRealTimers();
    exportMessage.mockClear();
    exportMessage.mockResolvedValue({ saved: true });
    desktopServicesAvailable.mockReturnValue(true);
  });

  it('sends the same markdown the feed rendered, under a name taken from the message', async () => {
    render(<MessageBlock {...actions} message={agentMessage} />);

    fireEvent.click(screen.getByRole('button', { name: 'Download response as an image' }));

    await waitFor(() => expect(exportMessage).toHaveBeenCalledTimes(1));
    const request = exportMessage.mock.calls[0]?.[0];
    expect(request?.format).toBe('image');
    expect(request?.fileName).toBe('quarterly-pipeline-review-2026-08-13');
    // The card is built from `MarkdownBody`'s own DOM, so a heading is a heading
    // and emphasis survives — not the raw markdown, and not text.
    expect(request?.contentHtml).toContain('<h2>Quarterly pipeline review</h2>');
    expect(request?.contentHtml).toContain('<strong>Northwind</strong>');
    expect(request?.logoDataUrl).toMatch(/^data:image\/png;base64,/u);
  });

  it('asks for a PDF from the button beside it', async () => {
    render(<MessageBlock {...actions} message={agentMessage} />);

    fireEvent.click(screen.getByRole('button', { name: 'Save response as a PDF' }));

    await waitFor(() => expect(exportMessage).toHaveBeenCalledWith(expect.objectContaining({ format: 'pdf' })));
  });

  it('holds both buttons closed while one export is in flight', async () => {
    let finish = (): void => undefined;
    exportMessage.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => { finish = resolve; });
      return { saved: true };
    });
    render(<MessageBlock {...actions} message={agentMessage} />);

    fireEvent.click(screen.getByRole('button', { name: 'Download response as an image' }));

    await waitFor(() => expect(screen.getByRole('button', { name: 'Save response as a PDF' })).toBeDisabled());
    await act(async () => { finish(); });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save response as a PDF' })).toBeEnabled());
  });

  it('says so when the file could not be made, and stays quiet when the dialog was dismissed', async () => {
    exportMessage.mockRejectedValueOnce(new Error('no surface'));
    const { rerender } = render(<MessageBlock {...actions} message={agentMessage} />);

    fireEvent.click(screen.getByRole('button', { name: 'Download response as an image' }));
    await waitFor(() => expect(screen.getByText('Image failed')).toBeVisible());

    exportMessage.mockResolvedValueOnce({ saved: false });
    rerender(<MessageBlock {...actions} message={{ ...agentMessage, id: 'message-agent-dismissed' }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Save response as a PDF' }));
    await waitFor(() => expect(exportMessage).toHaveBeenCalledTimes(2));
    expect(screen.queryByText('PDF failed')).not.toBeInTheDocument();
  });

  it('forgets a failure once the pointer leaves the row', async () => {
    exportMessage.mockRejectedValueOnce(new Error('no surface'));
    const { container } = render(<MessageBlock {...actions} message={agentMessage} />);

    fireEvent.click(screen.getByRole('button', { name: 'Download response as an image' }));
    await waitFor(() => expect(screen.getByText('Image failed')).toBeVisible());

    fireEvent.pointerLeave(container.querySelector('.agent-message-actions')!);

    expect(screen.queryByText('Image failed')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download response as an image' })).toBeEnabled();
  });

  it('offers nothing to save where there is no desktop to save it with', () => {
    desktopServicesAvailable.mockReturnValue(false);

    render(<MessageBlock {...actions} message={agentMessage} />);

    expect(screen.getByRole('button', { name: 'Copy response' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Download response as an image' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save response as a PDF' })).not.toBeInTheDocument();
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

    render(<MessageBlock {...actions} message={systemMessage('message-woken', 'Rally woke this work stream up as scheduled.')} />);

    expect(screen.getByText('Rally woke this work stream up as scheduled.')).toBeInTheDocument();
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

describe('MessageBlock plugin activity rows', () => {
  // Most rows use the default phrasing, so the helper supplies it and a case
  // that cares about wording overrides it explicitly.
  const pluginRow = (
    id: string,
    pluginActivity: Omit<NonNullable<Message['pluginActivity']>, 'activeVerb' | 'completedVerb'>
      & Partial<Pick<NonNullable<Message['pluginActivity']>, 'activeVerb' | 'completedVerb'>>,
  ): Message => ({
    ...baseMessage,
    id,
    authorType: 'agent',
    author: undefined,
    messageType: 'plugin_activity',
    text: undefined,
    pluginActivity: {
      activeVerb: `${pluginActivity.name} is working`,
      completedVerb: `${pluginActivity.name} worked`,
      ...pluginActivity,
    },
  });

  it('names the plugin rather than the calls it made, and pulses its mark while it works', () => {
    const { container } = render(<MessageBlock {...actions} message={pluginRow('message-slack', {
      groupKey: 'name:Slack', name: 'Slack', icon: 'slack', active: true, durationMs: 242_000,
    })} />);

    expect(screen.getByText('Slack is working for 4m 02s')).toBeVisible();
    // Stable while the number ticks; the elapsed time is not read aloud.
    expect(screen.getByRole('status')).toHaveAccessibleName('Slack is working');
    const mark = screen.getByRole('img', { name: 'Plugin: Slack' });
    expect(mark).toHaveClass('plugin-face-active');
    // The mark replaces the spinner rather than joining it.
    expect(container.querySelector('.agent-work-timing-orb')).toBeNull();
  });

  it('settles to the past tense with a still mark once the plugin is done', () => {
    render(<MessageBlock {...actions} message={pluginRow('message-slack-done', {
      groupKey: 'name:Slack', name: 'Slack', icon: 'slack', active: false, durationMs: 302_000,
    })} />);

    expect(screen.getByText('Slack worked for 5m 02s')).toBeVisible();
    expect(screen.getByRole('img', { name: 'Plugin: Slack' })).not.toHaveClass('plugin-face-active');
  });

  it('draws a company mark in the row\'s own colour, as real markup', () => {
    // The mark is a React component, so nothing is injected as HTML, and the
    // monochrome variant paints in `currentColor` — which is what keeps eight
    // companies legible on four grounds without per-theme artwork.
    const { container } = render(<MessageBlock {...actions} message={pluginRow('message-granola', {
      groupKey: 'name:Granola', name: 'Granola', icon: 'granola', active: false, durationMs: 3_000,
    })} />);

    const mark = container.querySelector('.plugin-face-mark.connector-mark');
    expect(mark?.querySelector('svg')).toBeTruthy();
    expect(mark?.innerHTML).not.toContain('data:image/svg+xml');
  });

  it('gives the virtual groups their own names and marks', () => {
    render(<MessageBlock {...actions} message={pluginRow('message-rally', {
      groupKey: 'rally', name: 'Rally', icon: 'rally', active: false, durationMs: 4_000,
    })} />);

    expect(screen.getByText('Rally worked for 4s')).toBeVisible();
    expect(screen.getByRole('img', { name: 'Plugin: Rally' })).toBeVisible();
  });
});

describe('splitStreamingMarkdown', () => {
  it('cuts settled segments at blank-line boundaries and reassembles losslessly', () => {
    // The cut before the final line is deferred until that line completes —
    // an arriving line's classification can change as it grows — so the last
    // settled block travels with the tail until a newline lands after it.
    const source = 'First paragraph.\n\n## A heading\n\nStill growing tail';
    const { settled, tail } = splitStreamingMarkdown(source);
    expect(settled).toEqual(['First paragraph.\n\n']);
    expect(tail).toBe('## A heading\n\nStill growing tail');
    expect(settled.join('') + tail).toBe(source);
    const grown = splitStreamingMarkdown(`${source}\nmore\n`);
    expect(grown.settled).toEqual(['First paragraph.\n\n', '## A heading\n\n']);
  });

  it('never cuts inside a code fence, whatever the fence contains', () => {
    const source = 'Intro.\n\n```ts\nconst a = 1;\n\nconst b = 2;\n```\n\nAfter the fence\n\nNext';
    const { settled, tail } = splitStreamingMarkdown(source);
    expect(settled).toEqual(['Intro.\n\n', '```ts\nconst a = 1;\n\nconst b = 2;\n```\n\n']);
    expect(tail).toBe('After the fence\n\nNext');
    expect(settled.join('') + tail).toBe(source);
  });

  it('keeps an unclosed fence in the tail', () => {
    const source = 'Intro.\n\n```ts\nconst a = 1;\n\nstill inside';
    const { settled, tail } = splitStreamingMarkdown(source);
    expect(settled).toEqual(['Intro.\n\n']);
    expect(tail).toBe('```ts\nconst a = 1;\n\nstill inside');
  });

  it('does not cut before a blockquote or indented continuation across a blank line', () => {
    const source = 'Start.\n\n> quoted\n\n  continued at item depth\n\nA new paragraph\n\nNext';
    const { settled, tail } = splitStreamingMarkdown(source);
    expect(settled).toEqual(['Start.\n\n> quoted\n\n  continued at item depth\n\n']);
    expect(tail).toBe('A new paragraph\n\nNext');
    expect(settled.join('') + tail).toBe(source);
  });

  it('settles a loose list item by item', () => {
    // A blank line does not end a list, but the next same-marker item is a
    // boundary the previous item cannot extend across. Without these cuts a
    // list-dominant reply produces no settled segments at all and re-parses
    // whole on every commit.
    const source = 'The plan:\n\n- one\n\n- two\n\n- three\n\nAfter\n\nNext';
    const { settled, tail } = splitStreamingMarkdown(source);
    expect(settled).toEqual(['The plan:\n\n', '- one\n\n', '- two\n\n', '- three\n\n']);
    expect(tail).toBe('After\n\nNext');
    expect(settled.join('') + tail).toBe(source);
  });

  it('settles a tight list item by item', () => {
    const source = '1. first\n2. second\n3. third\n4. fourth\n';
    const { settled, tail } = splitStreamingMarkdown(source);
    expect(settled).toEqual(['1. first\n', '2. second\n', '3. third\n']);
    expect(tail).toBe('4. fourth\n');
    expect(settled.join('') + tail).toBe(source);
  });

  it('keeps nested items and continuation paragraphs with their parent item', () => {
    const source = '- parent\n  - child\n\n  continuation of parent\n- sibling\nend\n';
    const { settled, tail } = splitStreamingMarkdown(source);
    expect(settled).toEqual(['- parent\n  - child\n\n  continuation of parent\n']);
    expect(tail).toBe('- sibling\nend\n');
    expect(settled.join('') + tail).toBe(source);
  });

  it('is prefix-stable as the source grows, marker-by-marker arrival included', () => {
    // A bare `1` is a paragraph until the `.` lands and makes it a list item.
    // Cuts are decided only at complete lines, so the classification flip
    // cannot un-settle anything: every earlier split is a prefix of every
    // later one, character by character.
    const grown = 'A paragraph.\n\nAnother one.\n\n1. item\n\n2. item two\n\nDone.\n';
    for (let end = 1; end < grown.length; end += 1) {
      const before = splitStreamingMarkdown(grown.slice(0, end)).settled;
      const after = splitStreamingMarkdown(grown.slice(0, end + 1)).settled;
      expect(after.slice(0, before.length)).toEqual(before);
    }
  });
});

describe('MarkdownBody streaming mode', () => {
  it('renders the same visible content streaming as settled', () => {
    const markdown = 'A paragraph with **bold**.\n\n```ts\nconst a = 1;\n```\n\nA middle paragraph.\n\nA tail paragraph';
    const settled = render(<MarkdownBody>{markdown}</MarkdownBody>);
    const settledBody = settled.container.querySelector('.markdown-body')!;
    // Compared block by block: react-markdown separates top-level blocks with
    // newline text nodes and a segment boundary drops one, which is invisible
    // in laid-out HTML — blocks are their own boxes — but changes the joined
    // textContent. The block elements and their text must match exactly.
    const blocks = (root: Element): { tag: string; text: string | null }[] =>
      [...root.children].map((child) => ({ tag: child.tagName, text: child.textContent }));
    const settledBlocks = blocks(settledBody);
    settled.unmount();
    const streaming = render(<MarkdownBody streaming>{markdown}</MarkdownBody>);
    const streamingBody = streaming.container.querySelector('.markdown-body')!;
    expect(blocks(streamingBody)).toEqual(settledBlocks);
    // The split really happened: the body holds more than one rendered chunk.
    expect(streamingBody.querySelectorAll('p, pre').length).toBeGreaterThan(2);
  });

  it('streams a list as per-item lists carrying the same items, and heals when settled', () => {
    // The documented approximation: while streaming, each settled list item is
    // its own single-item list (ordered numbering survives via `start`); the
    // settled render joins them back into one list.
    const markdown = 'The plan:\n\n1. first\n\n2. second\n\n3. third\n\nAfter.\n';
    const streaming = render(<MarkdownBody streaming>{markdown}</MarkdownBody>);
    const streamingBody = streaming.container.querySelector('.markdown-body')!;
    const streamingItems = [...streamingBody.querySelectorAll('li')].map((item) => item.textContent?.trim());
    expect(streamingItems).toEqual(['first', 'second', 'third']);
    expect(streamingBody.querySelectorAll('ol').length).toBeGreaterThan(1);
    expect([...streamingBody.querySelectorAll('ol')].at(-1)?.getAttribute('start')).toBe('3');
    streaming.unmount();
    const settledView = render(<MarkdownBody>{markdown}</MarkdownBody>);
    const settledBody = settledView.container.querySelector('.markdown-body')!;
    expect([...settledBody.querySelectorAll('li')].map((item) => item.textContent?.trim()))
      .toEqual(['first', 'second', 'third']);
    expect(settledBody.querySelectorAll('ol')).toHaveLength(1);
  });
});
