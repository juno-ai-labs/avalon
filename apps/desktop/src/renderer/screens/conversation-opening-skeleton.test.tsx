import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import type * as CollaborationSessionModule from '../lib/collaboration-session';
import { optimisticMentionRendering } from '../lib/transcript';
import { addPendingWorkstream, setCachedWorkstreams } from '../lib/workstreams-cache';
import { ConversationOpeningSkeleton } from './conversation-surface';
import { WorkstreamScreen } from './workstream';

const api = vi.hoisted(() => ({
  getWorkspaceMembers: vi.fn(async () => [{ id: 'alex', name: 'Alex Todorovic', email: 'alex@rally.test', timezone: 'UTC', role: 'member' }]),
  getWorkspaceInvitees: vi.fn(async () => []),
  getResourcePreviewContent: vi.fn(async () => new Blob(['x'])),
}));

vi.mock('../lib/collaboration-session', async (importOriginal) => {
  const actual = await importOriginal<typeof CollaborationSessionModule>();
  return { ...actual, useOptionalCollaborationSession: () => ({ api, session: null, host: 'desktop' }) };
});

describe('a thread still being started', () => {
  it('draws the opening message with its mention chips and attachments', () => {
    const loadContent = vi.fn(async () => new Blob(['x'], { type: 'application/pdf' }));
    render(
      <MemoryRouter>
        <ConversationOpeningSkeleton
          caption
          label="Starting…"
          loadAttachmentContent={loadContent}
          openingMessage={{
            ...optimisticMentionRendering(
              '@Katherine Baird what are you writing?',
              [{ type: 'person', label: '@Katherine Baird', userId: '019a0000-0000-7000-8000-00000000ca7e', connectorType: null, startOffset: 0, endOffset: 16 }],
              [{ id: '019a0000-0000-7000-8000-00000000ca7e', name: 'Katherine Baird', email: 'kate@example.com', timezone: 'UTC' }],
            ),
            attachments: [{ id: 'res-1', fileName: 'invite.pdf', mimeType: 'application/pdf', sizeBytes: 2048, contentAvailable: true, createdAt: '2026-10-19T12:00:00.000Z' }],
          }}
          parentKind="workstream"
        />
      </MemoryRouter>,
    );

    const feed = screen.getByRole('status', { name: 'Starting…' });
    expect(within(feed).getByText('Katherine Baird').closest('.mention-chip')?.getAttribute('data-person-id')).toBe('019a0000-0000-7000-8000-00000000ca7e');
    expect(within(feed).queryByText(/\[@Katherine/u)).toBeNull();
    expect(within(feed).getByRole('button', { name: 'Preview invite.pdf' })).toBeTruthy();
  });

  it('chips a member’s typed address in the opening, as the room will', async () => {
    const client = new QueryClient();
    setCachedWorkstreams(client, []);
    const id = '019a0000-0000-7000-8000-00000000c1a1';
    addPendingWorkstream(client, {
      id, spaceIds: ['space-1'], scope: 'workspace', harnessStatus: 'running', createdAt: '2026-10-19T12:00:00.000Z',
      opening: { text: 'Ask @alex@rally.test for the copy', mentions: [], attachments: [] },
    });
    const { container } = render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[`/workstreams/${id}`]}>
          <Routes><Route element={<WorkstreamScreen />} path="/workstreams/:id" /></Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await waitFor(() => expect(container.querySelector('.mention-chip')).not.toBeNull());
    expect(container.querySelector('.mention-chip')?.getAttribute('data-person-id')).toBe('alex');
  });
});
