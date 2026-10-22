import * as Tooltip from '@radix-ui/react-tooltip';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MessageIssueProvider } from './message-issue-dialog';
import { ApiError } from '../lib/api';
import { AssistantMessageContent, MessageActions } from './workstream-blocks';
import { asSubstreamId } from '@rally/contracts';

const target = { kind: 'conversation' as const, parentId: '00000000-0000-7000-8000-00000000db13', substreamId: asSubstreamId('0') };
function api() {
  return {
    createMessageIssue: vi.fn().mockResolvedValue({ id: '00000000-0000-7000-8000-00000000db15', createdAt: '2026-10-22T00:00:00.000Z' }),
    getTranscriptionSocketTicket: vi.fn(), prefetchTranscriptionSocketTicket: vi.fn(),
  };
}

describe('Oopsie reports', () => {
  it('opens from user actions even when text actions are hidden and retains the canonical turn', () => {
    const client = api();
    render(<Tooltip.Provider><MessageIssueProvider api={client} target={target}>
      <MessageActions subject="message" telemetry={{ messageId: 'turn-1:text:0', turnId: 'turn-1' }} text="User words" textActions={false} />
    </MessageIssueProvider></Tooltip.Provider>);
    fireEvent.click(screen.getByRole('button', { name: 'Oopsie' }));
    expect(screen.getByRole('dialog', { name: 'Something go wrong?' })).toBeInTheDocument();
    expect(screen.getByText('Let us know what you expected so we can improve Rally.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start voice input' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  });

  it('shows empty assistant actions only when reporting is available', () => {
    const { container, rerender } = render(<Tooltip.Provider>
      <AssistantMessageContent telemetry={{ messageId: 'empty-turn', workstreamId: target.parentId }} text="" />
    </Tooltip.Provider>);
    expect(container.querySelector('.message-actions')).toBeNull();
    rerender(<Tooltip.Provider><MessageIssueProvider api={api()} target={target}>
      <AssistantMessageContent telemetry={{ messageId: 'empty-turn', workstreamId: target.parentId }} text="" />
    </MessageIssueProvider></Tooltip.Provider>);
    expect(screen.getByRole('button', { name: 'Oopsie' })).toBeVisible();
  });

  it.each(['button', 'Enter'])('closes immediately after %s submission and stays closed if delivery fails', async (trigger) => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const client = api();
    let rejectReport!: (error: Error) => void;
    client.createMessageIssue.mockReturnValueOnce(new Promise((_resolve, reject) => { rejectReport = reject; }));
    render(<Tooltip.Provider><MessageIssueProvider api={client} target={target}>
      <MessageActions telemetry={{ messageId: 'turn-1:text:0', turnId: 'turn-1' }} text="Answer" />
    </MessageIssueProvider></Tooltip.Provider>);
    fireEvent.click(screen.getByRole('button', { name: 'Oopsie' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Describe the issue' }), { target: { value: 'I expected a useful answer.' } });
    if (trigger === 'Enter') {
      const input = screen.getByRole('textbox', { name: 'Describe the issue' });
      expect(fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })).toBe(true);
      expect(client.createMessageIssue).not.toHaveBeenCalled();
      fireEvent.keyDown(input, { key: 'Enter' });
    } else {
      fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    }
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(client.createMessageIssue).toHaveBeenCalledExactlyOnceWith({
      id: expect.any(String), target, messageId: 'turn-1', blockId: 'turn-1:text:0', description: 'I expected a useful answer.',
    });
    await act(async () => { rejectReport(new ApiError('sensitive response text', 404, 'message_issue_message_not_found', undefined, 'request-1')); });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(warning).toHaveBeenCalledExactlyOnceWith('[rally] message_issue_delivery_failed', {
      code: 'message_issue_message_not_found', status: 404, requestId: 'request-1',
    });
  });
});
