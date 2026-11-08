import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as Transcript from '../lib/transcript';
import type { Message } from '../lib/types';
import type * as UseWorkstreamSocket from '../lib/use-workstream-socket';
import { SidekickRunRow } from './sidekick-run-row';

const SIDEKICK = '00000000-0000-7000-8000-0000000000aa';
const RUN = '00000000-0000-7000-8000-0000000000bb';

const answerElicitation = vi.hoisted(() => vi.fn());
const socketOpenedFor = vi.hoisted(() => vi.fn());
const runTranscript = vi.hoisted(() => ({ messages: [] as unknown[] }));

vi.mock('../lib/collaboration-session', () => ({ useCollaborationSession: () => ({ api: {} }) }));
vi.mock('../lib/use-workstream-socket', async (importOriginal) => ({
  ...await importOriginal<typeof UseWorkstreamSocket>(),
  useWorkstreamSocket: (_api: unknown, parentId: string, _enabled: boolean, _reason: string, _lease: unknown, _open: boolean, substreamId: string) => {
    socketOpenedFor(parentId, substreamId);
    return { answerElicitation };
  },
}));
// The run's transcript as its socket would have written it.
vi.mock('../lib/transcript', async (importOriginal) => ({
  ...await importOriginal<typeof Transcript>(),
  orderedTranscriptMessages: () => runTranscript.messages,
}));

function runRow(state: 'needs_input' | 'running'): Message {
  return {
    id: 'row-1',
    workstreamId: SIDEKICK,
    authorType: 'system',
    messageType: 'automation_activation',
    text: '',
    createdAt: '2026-11-08T10:00:00.000Z',
    automationActivation: {
      automationId: SIDEKICK,
      automationName: 'Incident triage',
      runId: RUN,
      trigger: 'manual',
      run: { state, stepCount: 1, reply: '' },
    },
  } as Message;
}

function renderRow(message: Message): void {
  const client = new QueryClient();
  client.setQueryData(['substream-ordered-transcript', SIDEKICK, RUN], { ranges: [] });
  render(<QueryClientProvider client={client}><MemoryRouter><SidekickRunRow message={message} /></MemoryRouter></QueryClientProvider>);
}

beforeEach(() => {
  answerElicitation.mockReset().mockResolvedValue(undefined);
  socketOpenedFor.mockReset();
  runTranscript.messages = [{
    id: 'question',
    messageType: 'elicitation',
    elicitation: {
      id: 'elicitation-1',
      prompt: 'Which fruit, apple or pear?',
      responseType: 'single_select',
      options: [{ value: 'apple', label: 'Apple' }, { value: 'pear', label: 'Pear' }],
      status: 'open',
    },
  }];
});

describe('SidekickRunRow', () => {
  it("shows a waiting run's question on its row and answers that run", async () => {
    renderRow(runRow('needs_input'));
    const row = screen.getByRole('article', { name: 'Incident triage run' });
    expect(socketOpenedFor).toHaveBeenCalledWith(SIDEKICK, RUN);
    expect(within(row).getByText('Which fruit, apple or pear?')).toBeVisible();
    fireEvent.click(within(row).getByRole('radio', { name: /Pear/ }));
    fireEvent.click(within(row).getByRole('button', { name: 'Submit' }));
    await waitFor(() => expect(answerElicitation).toHaveBeenCalledWith('elicitation-1', 'pear', undefined));
  });

  it('opens no run conversation for a run that is not waiting', () => {
    renderRow(runRow('running'));
    expect(socketOpenedFor).not.toHaveBeenCalled();
    expect(screen.queryByText('Which fruit, apple or pear?')).toBeNull();
  });
});
