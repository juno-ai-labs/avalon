import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MessageExportRequest, MessageExportResult } from '../../common/message-export';
import type { ElicitationData, Message } from '../lib/types';
import { applyTheme } from '../lib/theme';
import {
  createConnectorMentionToken,
  ElicitationPanel,
  MarkdownBody,
  MessageBlock,
  splitStreamingMarkdown,
  withConnectorMentionLinks,
} from './workstream-blocks';
import { SpeechPlaybackProvider, type SpeechApi, type SpeechPlayer } from './speech-playback';

const copyText = vi.hoisted(() => vi.fn());
const exportMessage = vi.hoisted(() => vi.fn<(request: MessageExportRequest) => Promise<MessageExportResult>>(
  async () => ({ saved: true }),
));
const desktopServicesAvailable = vi.hoisted(() => vi.fn(() => true));
const reportTelemetryProductIntent = vi.hoisted(() => vi.fn(async () => undefined));
const setWindowTheme = vi.hoisted(() => vi.fn(async () => undefined));
const initializeMermaid = vi.hoisted(() => vi.fn());
const mermaidRender = vi.hoisted(() => vi.fn());
const getMermaidDiagram = vi.hoisted(() => vi.fn(async () => ({ db: {} })));
const getMermaidConfig = vi.hoisted(() => vi.fn(() => ({ maxTextSize: 50_000 })));
const readMermaidThemeConfig = vi.hoisted(() => vi.fn(
  () => ({
    fontFamily: 'token-font',
    fontSize: 13,
    themeCSS: 'token-derived-theme',
    themeVariables: { primaryColor: 'token' },
  }),
));

vi.mock('../lib/platform', () => ({
  desktopBridge: () => ({ copyText, exportMessage, reportTelemetryProductIntent, setWindowTheme }),
  desktopServicesAvailable,
}));
vi.mock('thinking-orbs', () => ({
  ThinkingOrb: ({ paused = false, size, state }: { paused?: boolean; size: number; state: string }) => (
    <span data-paused={String(paused)} data-size={size} data-state={state} data-testid="thinking-orb" />
  ),
}));
vi.mock('mermaid', () => ({
  default: {
    initialize: initializeMermaid,
    mermaidAPI: { getConfig: getMermaidConfig, getDiagramFromText: getMermaidDiagram },
    render: mermaidRender,
  },
}));
vi.mock('./markdown-mermaid-theme', () => ({
  readMermaidThemeConfig,
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

  it('renders an in-flight turn as the bubble it is about to become', () => {
    // The words are the person's own and are already on their screen in the
    // composer they came from; a placeholder standing in for them buys nothing
    // and costs the resize when the room accepts the turn. The only thing the
    // sending state changes is that it says it is still going.
    render(
      <MessageBlock
        {...actions}
        currentUserId="user-adam"
        message={{ ...baseMessage, deliveryState: 'sending', text: 'Client-only mention rendering' }}
      />,
    );

    const inFlight = screen.getByLabelText('Sending message');
    expect(inFlight).toHaveAttribute('aria-busy', 'true');
    expect(inFlight).toHaveClass('is-sending');
    expect(inFlight.querySelector('.human-message-bubble')).toBeInTheDocument();
    expect(screen.getByText('Client-only mention rendering')).toBeInTheDocument();
  });

  it('gives an attachment-only turn the same in-flight wrapper as one with text', () => {
    // The bubble is drawn only for a turn with text, and a send can be
    // attachments alone. The shimmer hangs off the content wrapper so that turn
    // is not the one message that goes out saying nothing about itself.
    render(
      <MessageBlock
        {...actions}
        currentUserId="user-adam"
        message={{ ...baseMessage, deliveryState: 'sending', text: '' }}
      />,
    );

    const inFlight = screen.getByLabelText('Sending message');
    expect(inFlight.querySelector('.human-message-bubble')).not.toBeInTheDocument();
    expect(inFlight.querySelector('.human-message-content')).toBeInTheDocument();
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
      text: `Ask [@Spoofed label](person://${personId}) for a review.`,
      mentions: [{
        type: 'person',
        personId,
        displayName: 'Ada Lovelace',
        avatarUrl: 'https://example.com/ada.png',
        startOffset: 4,
        endOffset: 67,
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

  it('still resolves a stored bare person: mention to a chip', () => {
    const personId = '00000000-0000-7000-8000-000000000042';
    const message: Message = {
      ...baseMessage,
      id: 'message-person-mention-legacy',
      authorType: 'agent',
      author: undefined,
      text: `Ask [@Ada Lovelace](person:${personId}) for a review.`,
      mentions: [{
        type: 'person',
        personId,
        displayName: 'Ada Lovelace',
        startOffset: 4,
        endOffset: 65,
      }],
    };

    render(<MessageBlock {...actions} message={message} />);

    expect(screen.getByText('@Ada Lovelace').closest('.mention-chip'))
      .toHaveAttribute('data-person-id', personId);
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
        { type: 'connector', connectorType: 'google', startOffset: 4, endOffset: 17 },
        { type: 'connector', connectorType: 'linear', startOffset: 22, endOffset: 29 },
      ],
    };

    render(<MessageBlock {...actions} message={message} />);

    const drive = screen.getByText('Google Drive').closest('.mention-chip');
    expect(drive).toHaveAttribute('data-connector-type', 'google');
    expect(drive).toHaveAttribute('data-connector-status', 'missing');
    expect(drive?.querySelector('.mention-chip-status')).toHaveTextContent('Not connected');
    expect(drive?.tagName).toBe('SPAN');
    expect(screen.getByText('Linear').closest('.mention-chip'))
      .toHaveAttribute('data-connector-type', 'linear');
    expect(screen.queryByRole('link', { name: 'Google Drive' })).not.toBeInTheDocument();
    const body = document.querySelector('.markdown-body');
    expect(body).toHaveTextContent(/Ask.*Google Drive.*Linear.*to sync/u);
    expect(drive?.querySelector('.mention-chip-connector-icon.provider-icon')).toBeInTheDocument();
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
        { type: 'connector', connectorType: 'google', startOffset: 4, endOffset: 17 },
        { type: 'connector', connectorType: 'linear', startOffset: 58, endOffset: 65 },
      ],
    };

    render(<MessageBlock {...actions} message={message} />);

    expect(screen.getByText('Google Drive').closest('.mention-chip'))
      .toHaveAttribute('data-connector-type', 'google');
    expect(screen.getByText('Linear').closest('.mention-chip'))
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
      mentions: [{ type: 'connector', connectorType: 'google', startOffset: 0, endOffset: 3 }],
    };

    render(<MessageBlock {...actions} message={message} />);

    expect(document.querySelector('.mention-chip')).not.toBeInTheDocument();
    expect(document.querySelector('.markdown-body')).toHaveTextContent('Ask @Google Drive to sync.');
  });

  it('escapes connection labels and ignores overlapping or malformed ranges', () => {
    expect(withConnectorMentionLinks('Ping @Ops [beta]', [
      { type: 'connector', connectorType: 'ops', startOffset: 5, endOffset: 16 },
    ], 'tok')).toBe('Ping [@Ops \\[beta\\]](connector://tok:ops)');

    expect(withConnectorMentionLinks('Ping @Ops *now* & co', [
      { type: 'connector', connectorType: 'ops', startOffset: 5, endOffset: 20 },
    ], 'tok')).toBe('Ping [@Ops \\*now\\* &amp; co](connector://tok:ops)');

    expect(withConnectorMentionLinks('Ping @Ops', [
      { type: 'connector', connectorType: 'ops', startOffset: 5, endOffset: 9 },
      { type: 'connector', connectorType: 'ops', startOffset: 6, endOffset: 9 },
    ], 'tok')).toBe('Ping [@Ops](connector://tok:ops)');

    expect(withConnectorMentionLinks('Ping @Ops', [
      { type: 'connector', connectorType: 'ops', startOffset: 5, endOffset: 40 },
      { type: 'person', personId: 'user-1', startOffset: 0, endOffset: 4 },
    ], 'tok')).toBe('Ping @Ops');
  });

  it('renders ampersands in connection labels literally instead of as entities', () => {
    const message: Message = {
      ...baseMessage,
      id: 'message-connector-mention-ampersand',
      text: 'Ask @R&D and @A &copy;.',
      mentions: [
        { type: 'connector', connectorType: 'research', startOffset: 4, endOffset: 8 },
        { type: 'connector', connectorType: 'archive', startOffset: 13, endOffset: 22 },
      ],
    };

    render(<MessageBlock {...actions} message={message} />);

    expect(screen.getByText('R&D').closest('.mention-chip')).not.toBeNull();
    expect(screen.getByText('A &copy;').closest('.mention-chip')).not.toBeNull();
    expect(document.querySelector('.markdown-body')).not.toHaveTextContent('A ©');
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

    render(<MessageBlock {...actions} collapseHeadings message={markdownMessage} />);

    expect(screen.getByRole('heading', { name: 'Harness API' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Expand section' }));
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

  it('turns HTML break tags into line breaks in tables and in prose, not in code', () => {
    // Models write `<br/>` inside GFM table cells because a real newline ends
    // the row, and they write the same tag in ordinary paragraphs. Neither is
    // HTML this renderer parses — `rehype-raw` is off — so the tags used to
    // print as characters (or vanish, when micromark classifies them as html).
    render(
      <MarkdownBody>
        {[
          'Line one<br/>Line two',
          '',
          '| Phase | Deliverables |',
          '| --- | --- |',
          '| One | `src/a.ts` <br/>• migrations<br/>• tests |',
          '',
          'A <div>stay</div> and a <br class="x"> stay text.',
          '',
          'Keep a `a<br/>b` span, and a fence:',
          '',
          '```html',
          '<br/>',
          '```',
        ].join('\n')}
      </MarkdownBody>,
    );

    const body = document.querySelector('.markdown-body')!;
    const paragraph = body.querySelector('p')!;
    expect(paragraph.querySelectorAll('br')).toHaveLength(1);
    expect(paragraph.firstChild?.textContent).toBe('Line one');
    expect(paragraph.lastChild?.textContent?.trim()).toBe('Line two');

    const cell = screen.getByRole('cell', { name: /src\/a\.ts/u });
    expect(cell.querySelectorAll('br')).toHaveLength(2);
    expect(cell.textContent).not.toContain('<br');
    expect(cell.querySelector('.markdown-inline-code')?.textContent).toBe('src/a.ts');

    const taggedParagraph = Array.from(body.querySelectorAll('p'))
      .find((candidate) => candidate.textContent?.includes('<br class="x">'));
    expect(taggedParagraph).toBeDefined();
    expect(taggedParagraph?.querySelectorAll('br')).toHaveLength(0);
    expect(taggedParagraph?.textContent).toContain('<div>stay</div>');
    expect(screen.getByText('a<br/>b')).toHaveClass('markdown-inline-code');
    expect(document.querySelector('.markdown-code-block')?.textContent).toContain('<br/>');
  });

  it('rewrites break tags in a verbatim document the same way', () => {
    // The inspector and the lightbox are verbatim because TeX repair must not
    // rewrite a file. A break tag in that file is still a line break the
    // renderer should honour — it is not TeX.
    render(<MarkdownBody verbatim>{'Hello<br />there'}</MarkdownBody>);
    const paragraph = document.querySelector('.markdown-body p')!;
    expect(paragraph.querySelectorAll('br')).toHaveLength(1);
    expect(paragraph.firstChild?.textContent).toBe('Hello');
    expect(paragraph.lastChild?.textContent?.trim()).toBe('there');
  });

  it.each([false, true])('keeps escaped break-tag text when verbatim is %s', (verbatim) => {
    const source = 'Backslash \\<br/> and entity &lt;br/&gt; stay text.';
    render(<MarkdownBody verbatim={verbatim}>{source}</MarkdownBody>);

    const paragraph = document.querySelector('.markdown-body p')!;
    expect(paragraph.querySelectorAll('br')).toHaveLength(0);
    expect(paragraph.textContent).toBe('Backslash <br/> and entity <br/> stay text.');
  });

  it('renders unsupported fenced languages as plain text without losing their label', () => {
    const message: Message = {
      ...baseMessage,
      id: 'message-unsupported-language',
      authorType: 'agent',
      author: undefined,
      text: '```brainfuck\n+[-->-[>>+>-----<<]<--<---]>-.\n```',
    };

    render(<MessageBlock {...actions} message={message} />);

    expect(document.querySelector('.markdown-code-block')).toHaveAttribute('data-language', 'brainfuck');
    expect(document.querySelector('.prism-code')).toHaveClass('language-plain');
    expect(screen.getByText('+[-->-[>>+>-----<<]<--<---]>-.')).toBeVisible();
    expect(screen.getByText('Brainfuck')).toHaveClass('markdown-code-language');
  });

  it('renders a completed Mermaid fence as a strict, theme-aware diagram', async () => {
    mermaidRender.mockResolvedValueOnce({ svg: '<svg viewBox="0 0 40 20"><text>Rendered graph</text></svg>' });
    const message: Message = {
      ...baseMessage,
      id: 'message-mermaid',
      authorType: 'agent',
      author: undefined,
      text: '```mermaid\ngraph TD; A-->B\n```',
    };

    const { container } = render(<MessageBlock {...actions} message={message} />);

    expect(await screen.findByRole('img', { name: 'Mermaid diagram' })).toBeVisible();
    expect(container.querySelector('.markdown-mermaid-diagram svg')).not.toBeNull();
    expect(container.querySelector('.markdown-mermaid-svg')).toHaveStyle({ width: '40px' });
    expect(screen.getByText('Rendered graph')).toBeVisible();
    expect(initializeMermaid).toHaveBeenCalledWith(expect.objectContaining({
      altFontFamily: 'token-font',
      fontFamily: 'token-font',
      fontSize: 13,
      flowchart: { htmlLabels: false },
      htmlLabels: false,
      securityLevel: 'strict',
      startOnLoad: false,
      suppressErrorRendering: true,
      theme: 'base',
      look: 'classic',
      themeCSS: 'token-derived-theme',
      themeVariables: { primaryColor: 'token' },
    }));
    expect(initializeMermaid.mock.calls[0]?.[0]?.secure).toEqual(expect.arrayContaining([
      'securityLevel',
      'htmlLabels',
      'theme',
      'themeCSS',
      'themeVariables',
      'fontFamily',
      'altFontFamily',
      'fontSize',
      'look',
    ]));
    expect(mermaidRender).toHaveBeenCalledWith(expect.stringMatching(/^rally-mermaid-[A-Za-z0-9_-]+$/u), 'graph TD; A-->B');
    expect(screen.getByRole('img', { name: 'Mermaid diagram' })).toHaveAccessibleDescription('Diagram source: graph TD; A-->B');
    expect(screen.getByText('Mermaid')).toHaveClass('markdown-code-language');
    expect(screen.getByRole('button', { name: 'Copy code' })).toBeInTheDocument();
  });

  it('keeps invalid Mermaid readable as source', async () => {
    mermaidRender.mockRejectedValueOnce(new Error('syntax error'));

    render(<MarkdownBody>{'```mermaid\nnot a diagram\n```'}</MarkdownBody>);

    expect(await screen.findByRole('status')).toHaveTextContent('Couldn’t render diagram; showing source.');
    expect(screen.getByText('not a diagram')).toBeVisible();
  });

  it('rejects Mermaid source above its configured text limit before parsing', async () => {
    const parseCallBaseline = getMermaidDiagram.mock.calls.length;
    const renderCallBaseline = mermaidRender.mock.calls.length;
    getMermaidConfig.mockReturnValueOnce({ maxTextSize: 12 });

    render(<MarkdownBody>{'```mermaid\ngraph TD; A-->B\n```'}</MarkdownBody>);

    expect(await screen.findByRole('status')).toHaveTextContent('Couldn’t render diagram; showing source.');
    expect(getMermaidDiagram).toHaveBeenCalledTimes(parseCallBaseline);
    expect(mermaidRender).toHaveBeenCalledTimes(renderCallBaseline);
  });

  it('rejects external resources in Mermaid SVG style blocks', async () => {
    mermaidRender.mockResolvedValueOnce({
      svg: '<svg viewBox="0 0 40 20"><style>.node { fill: url(https://example.invalid/beacon); }</style><text>Unsafe graph</text></svg>',
    });

    render(<MarkdownBody>{'```mermaid\ngraph TD; A-->B\n```'}</MarkdownBody>);

    expect(await screen.findByRole('status')).toHaveTextContent('Couldn’t render diagram; showing source.');
    expect(screen.queryByText('Unsafe graph')).toBeNull();
  });

  it('rejects forbidden elements in generated Mermaid SVG', async () => {
    mermaidRender.mockResolvedValueOnce({
      svg: '<svg viewBox="0 0 40 20"><foreignObject><div>Unsafe graph</div></foreignObject></svg>',
    });

    render(<MarkdownBody>{'```mermaid\ngraph TD; A-->B\n```'}</MarkdownBody>);

    expect(await screen.findByRole('status')).toHaveTextContent('Couldn’t render diagram; showing source.');
    expect(screen.queryByText('Unsafe graph')).toBeNull();
  });

  it('rejects parsed Mermaid CSS resources before rendering', async () => {
    const renderCallBaseline = mermaidRender.mock.calls.length;
    getMermaidDiagram.mockResolvedValueOnce({
      db: { getClasses: () => new Map([['remote', { styles: ['fill:url(https://example.invalid/beacon)'] }]]) },
    });

    render(<MarkdownBody>{'```mermaid\nflowchart TD; A-->B\n```'}</MarkdownBody>);

    expect(await screen.findByRole('status')).toHaveTextContent('Couldn’t render diagram; showing source.');
    expect(mermaidRender).toHaveBeenCalledTimes(renderCallBaseline);
  });

  it('rejects parsed block styles before rendering', async () => {
    const renderCallBaseline = mermaidRender.mock.calls.length;
    getMermaidDiagram.mockResolvedValueOnce({
      db: { getBlocksFlat: () => [{ styles: ['fill:url(https://example.invalid/beacon)'] }] },
    });

    render(<MarkdownBody>{'```mermaid\nblock-beta\n  A["Review"]\n```'}</MarkdownBody>);

    expect(await screen.findByRole('status')).toHaveTextContent('Couldn’t render diagram; showing source.');
    expect(mermaidRender).toHaveBeenCalledTimes(renderCallBaseline);
  });

  it('rejects diagram-independent CSS resource functions before rendering', async () => {
    const renderCallBaseline = mermaidRender.mock.calls.length;
    const source = `block-beta
  A["Review"]
  style A fill:url(https://example.invalid/beacon.svg)`;

    render(<MarkdownBody>{`\`\`\`mermaid\n${source}\n\`\`\``}</MarkdownBody>);

    expect(await screen.findByRole('status')).toHaveTextContent('Couldn’t render diagram; showing source.');
    expect(mermaidRender).toHaveBeenCalledTimes(renderCallBaseline);
  });

  it('allows CSS-looking text in a Mermaid label', async () => {
    const renderCallBaseline = mermaidRender.mock.calls.length;
    mermaidRender.mockResolvedValueOnce({ svg: '<svg viewBox="0 0 40 20"><text>Read url(https://example.com)</text></svg>' });
    const source = 'flowchart TD\n  A["Read url(https://example.com)"]';

    render(<MarkdownBody>{`\`\`\`mermaid\n${source}\n\`\`\``}</MarkdownBody>);

    expect(await screen.findByRole('img', { name: 'Mermaid diagram' })).toBeVisible();
    expect(mermaidRender).toHaveBeenCalledTimes(renderCallBaseline + 1);
  });

  it('keeps Mermaid source in stills, glances, and streams, then renders the settled turn', async () => {
    const renderCallBaseline = mermaidRender.mock.calls.length;
    mermaidRender.mockResolvedValueOnce({ svg: '<svg viewBox="0 0 40 20"><text>Settled graph</text></svg>' });
    const markdown = '```mermaid\ngraph TD; A-->B\n```';
    const view = render(<MarkdownBody still>{markdown}</MarkdownBody>);

    expect(screen.getByText('graph TD; A-->B')).toBeVisible();
    expect(screen.queryByRole('img', { name: 'Mermaid diagram' })).toBeNull();

    view.rerender(<MarkdownBody glance>{markdown}</MarkdownBody>);
    expect(screen.getByText('graph TD; A-->B')).toBeVisible();
    expect(screen.queryByRole('img', { name: 'Mermaid diagram' })).toBeNull();

    view.rerender(<MarkdownBody streaming>{markdown}</MarkdownBody>);
    expect(screen.getByText('graph TD; A-->B')).toBeVisible();
    expect(screen.queryByRole('img', { name: 'Mermaid diagram' })).toBeNull();

    view.rerender(<MarkdownBody>{markdown}</MarkdownBody>);
    expect(await screen.findByRole('img', { name: 'Mermaid diagram' })).toBeVisible();
    expect(screen.getByText('Settled graph')).toBeVisible();
    expect(mermaidRender).toHaveBeenCalledTimes(renderCallBaseline + 1);
  });

  it('serialises Mermaid renders and resolves each theme when its queued work starts', async () => {
    let resolveFirst!: (value: { svg: string }) => void;
    const firstRender = new Promise<{ svg: string }>((resolve) => { resolveFirst = resolve; });
    const renderCallBaseline = mermaidRender.mock.calls.length;
    const themeCallBaseline = readMermaidThemeConfig.mock.calls.length;
    mermaidRender
      .mockImplementationOnce(() => firstRender)
      .mockResolvedValueOnce({ svg: '<svg viewBox="0 0 40 20"><text>Second graph</text></svg>' });

    render(
      <>
        <MarkdownBody>{'```mermaid\ngraph TD; A-->B\n```'}</MarkdownBody>
        <MarkdownBody>{'```mermaid\ngraph TD; C-->D\n```'}</MarkdownBody>
      </>,
    );

    await waitFor(() => expect(mermaidRender).toHaveBeenCalledTimes(renderCallBaseline + 1));
    expect(readMermaidThemeConfig).toHaveBeenCalledTimes(themeCallBaseline + 1);

    await act(async () => { resolveFirst({ svg: '<svg viewBox="0 0 40 20"><text>First graph</text></svg>' }); });

    await waitFor(() => expect(mermaidRender).toHaveBeenCalledTimes(renderCallBaseline + 2));
    expect(readMermaidThemeConfig).toHaveBeenCalledTimes(themeCallBaseline + 2);
    expect(screen.getByText('First graph')).toBeVisible();
    expect(await screen.findByText('Second graph')).toBeVisible();
  });

  it('skips Mermaid work that unmounts before its turn in the render queue', async () => {
    let resolveFirst!: (value: { svg: string }) => void;
    const firstRender = new Promise<{ svg: string }>((resolve) => { resolveFirst = resolve; });
    const renderCallBaseline = mermaidRender.mock.calls.length;
    mermaidRender
      .mockImplementationOnce(() => firstRender)
      .mockResolvedValueOnce({ svg: '<svg viewBox="0 0 40 20"><text>Discarded graph</text></svg>' });

    render(<MarkdownBody>{'```mermaid\ngraph TD; A-->B\n```'}</MarkdownBody>);
    const queued = render(<MarkdownBody>{'```mermaid\ngraph TD; C-->D\n```'}</MarkdownBody>);
    await waitFor(() => expect(mermaidRender).toHaveBeenCalledTimes(renderCallBaseline + 1));

    queued.unmount();
    await act(async () => {
      resolveFirst({ svg: '<svg viewBox="0 0 40 20"><text>Kept graph</text></svg>' });
      await Promise.resolve();
    });

    expect(await screen.findByText('Kept graph')).toBeVisible();
    expect(mermaidRender).toHaveBeenCalledTimes(renderCallBaseline + 1);
  });

  it('skips Mermaid rendering when work unmounts during resource preflight', async () => {
    let resolvePreflight!: (value: { db: object }) => void;
    const pendingPreflight = new Promise<{ db: object }>((resolve) => { resolvePreflight = resolve; });
    const parseCallBaseline = getMermaidDiagram.mock.calls.length;
    const renderCallBaseline = mermaidRender.mock.calls.length;
    getMermaidDiagram.mockImplementationOnce(() => pendingPreflight);
    mermaidRender.mockResolvedValue({ svg: '<svg viewBox="0 0 40 20"><text>Current graph</text></svg>' });

    const stale = render(<MarkdownBody>{'```mermaid\ngraph TD; A-->B\n```'}</MarkdownBody>);
    await waitFor(() => expect(getMermaidDiagram).toHaveBeenCalledTimes(parseCallBaseline + 1));
    stale.unmount();
    render(<MarkdownBody>{'```mermaid\ngraph TD; C-->D\n```'}</MarkdownBody>);

    await act(async () => { resolvePreflight({ db: {} }); });

    expect(await screen.findByRole('img', { name: 'Mermaid diagram' })).toBeVisible();
    expect(mermaidRender).toHaveBeenCalledTimes(renderCallBaseline + 1);
  });

  it('re-renders a settled Mermaid diagram when the resolved theme changes', async () => {
    const renderCallBaseline = mermaidRender.mock.calls.length;
    mermaidRender.mockResolvedValue({ svg: '<svg viewBox="0 0 40 20"><text>Themed graph</text></svg>' });

    const view = render(<MarkdownBody>{'```mermaid\ngraph TD; A-->B\n```'}</MarkdownBody>);
    await waitFor(() => expect(mermaidRender).toHaveBeenCalledTimes(renderCallBaseline + 1));

    act(() => { applyTheme({ family: 'air', mode: 'dark' }); });

    await waitFor(() => expect(mermaidRender).toHaveBeenCalledTimes(renderCallBaseline + 2));
    view.unmount();
    act(() => { applyTheme({ family: 'terra', mode: 'light' }); });
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

describe('MessageBlock speech action', () => {
  it('speaks the complete markdown source even after its sections are collapsed, then stops', async () => {
    const markdown = '## Visible section\n\nVisible copy.\n\n## Collapsed section\n\nThe complete hidden detail.';
    const streamMessageSpeech = vi.fn(async () => new ReadableStream<Uint8Array>());
    const stop = vi.fn();
    const player: SpeechPlayer = {
      prepare: vi.fn(async () => undefined),
      play: vi.fn(async () => new Promise<void>(() => undefined)),
      stop,
    };
    const api = { streamMessageSpeech } satisfies SpeechApi;
    render(
      <SpeechPlaybackProvider api={api} createPlayer={() => player}>
        <MessageBlock {...actions} collapseHeadings message={{
          ...baseMessage,
          id: 'message-agent-speech',
          authorType: 'agent',
          author: undefined,
          text: markdown,
        }} />
      </SpeechPlaybackProvider>,
    );
    expect(screen.getByRole('button', { name: 'Expand all sections' })).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: 'Speak response with an AI-generated voice' }));

    await waitFor(() => expect(streamMessageSpeech).toHaveBeenCalledWith(markdown, expect.any(AbortSignal)));
    const stopButton = screen.getByRole('button', { name: 'Stop speaking' });
    expect(stopButton).toHaveTextContent('Stop speaking');
    expect(stopButton.closest('.agent-message-actions')).toHaveClass('is-speaking');

    fireEvent.click(stopButton);

    expect(stop).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: 'Speak response with an AI-generated voice' })).toBeVisible();
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
    const brief = 'You are writing the scheduled digest for Adam Juhasz in the Juno Labs workspace.';

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

describe('MarkdownBody heading collapse', () => {
  const markdown = [
    'Lead paragraph.',
    '',
    '## Alpha',
    '',
    'First section body that is long enough to preview.',
    '',
    '### Nested',
    '',
    'This nested heading must not be its own accordion.',
    '',
    '## Beta',
    '',
    'Second section body.',
    '',
  ].join('\n');

  it('does not collapse headings when the renderer has not opted into heading collapse', () => {
    const { container } = render(<MarkdownBody>{markdown}</MarkdownBody>);
    expect(container.querySelector('.markdown-collapse')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Expand section' })).not.toBeInTheDocument();
  });

  it('collapses every h2 when enabled and leaves a nested h3 without a chevron', () => {
    const { container } = render(<MarkdownBody collapseHeadings>{markdown}</MarkdownBody>);
    const sections = container.querySelectorAll('.markdown-collapse');
    expect(sections).toHaveLength(2);
    expect([...sections].every((section) => section.classList.contains('is-collapsed'))).toBe(true);
    expect(screen.getAllByRole('button', { name: 'Expand section' })).toHaveLength(2);
    const nested = container.querySelector('h3');
    expect(nested).toHaveTextContent('Nested');
    expect(nested).not.toHaveClass('markdown-collapse-heading');
    expect(nested?.querySelector('.markdown-collapse-chevron')).toBeNull();
    expect(sections[0]!.querySelector('.markdown-collapse-body')).toHaveAttribute('aria-hidden', 'true');
  });

  it('toggles a section from the heading and from the chevron', () => {
    const { container } = render(<MarkdownBody collapseHeadings>{markdown}</MarkdownBody>);
    const [first, second] = container.querySelectorAll('.markdown-collapse');
    fireEvent.click(screen.getAllByRole('button', { name: 'Expand section' })[0]!);
    expect(first).toHaveClass('is-expanded');
    expect(second).toHaveClass('is-collapsed');
    fireEvent.click(container.querySelector('h2')!);
    expect(first).toHaveClass('is-collapsed');
  });

  it('does not toggle a section when the heading text is selected', () => {
    const { container } = render(<MarkdownBody collapseHeadings>{markdown}</MarkdownBody>);
    const selection = vi.spyOn(window, 'getSelection').mockReturnValue({ isCollapsed: false } as Selection);
    fireEvent.click(container.querySelector('h2')!);
    expect(container.querySelector('.markdown-collapse')).toHaveClass('is-collapsed');
    selection.mockRestore();
  });

  it('resolves a reference-style link whose definition lives under a later heading', () => {
    const { container } = render(
      <MarkdownBody collapseHeadings>
        {['## Claims', '', 'See [the note][ref].', '', '## Sources', '', '[ref]: https://example.com/note', ''].join('\n')}
      </MarkdownBody>,
    );
    const link = [...container.querySelectorAll('a')].find((anchor) => anchor.getAttribute('href') === 'https://example.com/note');
    expect(link).toHaveTextContent('the note');
  });

  it('does not collapse a glance or a still', () => {
    const glance = render(<MarkdownBody collapseHeadings glance>{markdown}</MarkdownBody>);
    expect(glance.container.querySelector('.markdown-collapse')).toBeNull();
    glance.unmount();
    const still = render(<MarkdownBody collapseHeadings still>{markdown}</MarkdownBody>);
    expect(still.container.querySelector('.markdown-collapse')).toBeNull();
    expect(still.container.querySelector('h2')).toHaveTextContent('Alpha');
  });

  it('keeps an expanded section open while a later heading streams in collapsed', () => {
    const first = '## Alpha\n\nFirst section body.\n';
    const { container, rerender } = render(<MarkdownBody collapseHeadings streaming>{first}</MarkdownBody>);
    fireEvent.click(screen.getByRole('button', { name: 'Expand section' }));
    expect(container.querySelector('.markdown-collapse')).toHaveClass('is-expanded');
    rerender(<MarkdownBody collapseHeadings streaming>{`${first}\n## Beta\n\nSecond section body.\n`}</MarkdownBody>);
    const sections = container.querySelectorAll('.markdown-collapse');
    expect(sections).toHaveLength(2);
    expect(sections[0]).toHaveClass('is-expanded');
    expect(sections[1]).toHaveClass('is-collapsed');
  });
});

describe('MessageBlock heading collapse control', () => {
  it('places a collapse-all control to the right of Worked for and toggles every section', () => {
    const message: Message = {
      ...baseMessage,
      id: 'agent-one',
      authorType: 'agent',
      author: undefined,
      text: '## Alpha\n\nFirst.\n\n## Beta\n\nSecond.\n',
      workSummary: { durationMs: 83_000 },
    };
    const { container } = render(<MessageBlock {...actions} collapseHeadings message={message} />);
    expect(screen.getByText('Worked for 1m 23s')).toBeInTheDocument();
    const header = container.querySelector('.message-block > header')!;
    const summary = header.querySelector('.message-work-summary');
    const toggle = screen.getByRole('button', { name: 'Expand all sections' });
    expect(summary?.nextElementSibling).toBe(toggle);
    expect(container.querySelectorAll('.markdown-collapse.is-collapsed')).toHaveLength(2);
    fireEvent.click(toggle);
    expect(container.querySelectorAll('.markdown-collapse.is-expanded')).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Collapse all sections' })).toBeInTheDocument();
  });

  it('hides the collapse-all control when the turn has no collapsible headings', () => {
    const message: Message = {
      ...baseMessage,
      id: 'agent-plain',
      authorType: 'agent',
      author: undefined,
      text: 'A paragraph with no headings.',
      workSummary: { durationMs: 1_000 },
    };
    render(<MessageBlock {...actions} collapseHeadings message={message} />);
    expect(screen.queryByRole('button', { name: 'Expand all sections' })).toBeNull();
  });
});

describe('an automation result in the room', () => {
  const activation = {
    ...baseMessage,
    id: 'message-activation',
    // Appended by Rally on the automation's behalf, so it carries a machine
    // author; what makes it an activation is the type, and the renderer has to
    // agree with that rather than with the author.
    authorType: 'system' as const,
    author: undefined,
    messageType: 'automation_activation' as const,
    text: '## Monday agenda\n\nTwo candidates reached final round.',
  };

  it('renders as an ordinary authored message, named Automation', () => {
    render(<MessageBlock {...actions} collapseHeadings message={activation} />);

    const article = screen.getByRole('article', { name: 'Automation result' });
    expect(article).toHaveClass('message-block', 'agent-message');
    expect(article.querySelector('.message-author')?.textContent).toBe('Automation');
    // Not "Rally": the room is being told what an automation found, and the
    // name in the author slot is the whole of what marks it as one.
    expect(article.textContent).not.toContain('Rally');
  });

  it('gets the feed treatment every other message gets', () => {
    const { container } = render(
      <MessageBlock {...actions} collapseHeadings message={activation} />,
    );

    // Headings fold, exactly as an assistant answer's do. An activation is a
    // message, not a row kind with rules of its own.
    expect(container.querySelectorAll('.markdown-collapse')).toHaveLength(1);
    expect(screen.getByText('Two candidates reached final round.')).toBeVisible();
    expect(container.querySelector('.transcript-event')).toBeNull();
  });
});

describe('the card for an automation that lost its principal', () => {
  const card = {
    ...baseMessage,
    id: 'message-principal',
    authorType: 'system' as const,
    author: undefined,
    messageType: 'system' as const,
    text: 'Candidate intake cannot reach Gmail.',
    principalUnavailable: {
      automationId: 'automation-1',
      automationName: 'Candidate intake',
      outgoingUserName: 'Dana Reeve',
      unreachableProviders: ['Gmail'],
    },
  };

  it('says what broke, who it ran as, and what still works', () => {
    render(<MessageBlock {...actions} message={card} />);

    const group = screen.getByRole('group');
    expect(group.textContent).toContain('Candidate intake');
    expect(group.textContent).toContain('Gmail');
    expect(group.textContent).toContain('Dana Reeve');
    // The reassurance is the point of naming it: a room reading "cannot reach
    // Gmail" would otherwise assume the whole automation has stopped, when
    // everything on the workspace's own connections is still running.
    expect(group.textContent).toContain('workspace’s own connections is unaffected');
  });

  it('offers the takeover to the reader, and to nobody else', () => {
    const onClaimExecutionPrincipal = vi.fn();
    render(
      <MessageBlock {...actions} message={card} onClaimExecutionPrincipal={onClaimExecutionPrincipal} />,
    );

    // "me", with no argument but the automation: nobody can lend a colleague's
    // credentials to a standing automation on their behalf.
    fireEvent.click(screen.getByRole('button', { name: 'Run these as me' }));

    expect(onClaimExecutionPrincipal).toHaveBeenCalledExactlyOnceWith('automation-1');
  });

  it('is a card rather than a clamped note, so the action is not buried', () => {
    const { container } = render(<MessageBlock {...actions} message={card} />);

    // The system row it would otherwise be clamps to five lines and offers a
    // "show more" toggle; this row's only control has to be the takeover.
    expect(container.querySelector('.principal-unavailable-card')).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'Show this note in full' })).toBeNull();
  });

  it('explains itself even where nothing can act on it', () => {
    render(<MessageBlock {...actions} message={card} />);

    // No API session on this surface. The room is still better off knowing.
    expect(screen.getByRole('button', { name: 'Run these as me' })).toBeDisabled();
    expect(screen.getByRole('group').textContent).toContain('Candidate intake');
  });
});

describe('the card proposing an automation drafted in this room', () => {
  const proposal = {
    ...baseMessage,
    id: 'message-draft',
    authorType: 'system' as const,
    author: undefined,
    messageType: 'system' as const,
    text: 'Proposed an automation: Weekly changelog.',
    draftProposed: {
      automationId: 'automation-7',
      automationName: 'Weekly changelog',
      description: 'Summarize what shipped each week.',
      triggerSummaries: ['Every Monday at 9:00 AM'],
      suggestedScope: 'workstream' as const,
      ready: true,
    },
  };

  it('shows what it would create rather than describing it', () => {
    render(<MessageBlock {...actions} message={proposal} />);

    const group = screen.getByRole('group');
    expect(group.textContent).toContain('Weekly changelog');
    expect(group.textContent).toContain('Summarize what shipped each week.');
    // The triggers are the decision. A card that said "runs on a schedule"
    // would leave somebody accepting a schedule they never saw.
    expect(within(group).getByRole('list', { name: 'Triggers' }).textContent)
      .toContain('Every Monday at 9:00 AM');
  });

  it('says who will be able to manage it, which acceptance freezes', () => {
    render(<MessageBlock {...actions} message={proposal} />);
    expect(screen.getByRole('group').textContent).toContain('This work stream can manage it');

    const personal = { ...proposal, draftProposed: { ...proposal.draftProposed, suggestedScope: 'personal' as const } };
    const { unmount } = render(<MessageBlock {...actions} message={personal} />);
    expect(screen.getAllByRole('group').at(-1)?.textContent).toContain('You can manage it');
    unmount();
  });

  it('creates the automation it names', () => {
    const onAcceptDraft = vi.fn();
    render(<MessageBlock {...actions} message={proposal} onAcceptDraft={onAcceptDraft} />);

    fireEvent.click(screen.getByRole('button', { name: 'Create this automation' }));

    expect(onAcceptDraft).toHaveBeenCalledExactlyOnceWith('automation-7');
  });

  it('offers no accept while the agent is still asking', () => {
    // Accepting an unfinished draft freezes the gap the agent is asking about,
    // so the card says what is happening and offers nothing to press.
    render(
      <MessageBlock
        {...actions}
        message={{ ...proposal, draftProposed: { ...proposal.draftProposed, ready: false } }}
      />,
    );

    expect(screen.queryByRole('button', { name: 'Create this automation' })).toBeNull();
    expect(screen.getByRole('group').textContent).toContain('Still being drafted');
  });
});
