import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { optimisticMentionRendering } from '../lib/transcript';
import { ConversationOpeningSkeleton } from './conversation-surface';

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
});
