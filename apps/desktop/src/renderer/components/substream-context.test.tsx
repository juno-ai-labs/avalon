import { render, screen } from '@testing-library/react';
import { SubstreamInitialContextSchema } from '@rally/contracts/substream-creation';
import { describe, expect, it } from 'vitest';
import { SubstreamContext } from './substream-context';

function context(parts: unknown[]) {
  return SubstreamInitialContextSchema.parse({
    source: { workspaceId: '00000000-0000-7000-8000-000000000001',
      workstreamId: '00000000-0000-7000-8000-000000000002', substreamId: '0' },
    throughTurnId: 'turn-1', policyRevision: 'test', contentHash: 'a'.repeat(64), parts,
  });
}

describe('read-only substream context', () => {
  it('renders the selected summary and history, not just a history count', () => {
    render(<SubstreamContext context={context([
      { kind: 'summary', text: '# Decisions\nKeep the launch date.',
        requestedModel: 'test', resolvedModel: 'test', inputTokens: 1, outputTokens: 1 },
      { kind: 'history', messages: [{ turnId: 'turn-1', transcriptSequence: 1,
        actor: 'assistant', authorUserId: null, authorLabel: 'Rally', createdAt: '2026-09-04T12:00:00.000Z',
        blocks: [{ text: 'Verbatim recent context.', mentions: [], attachments: [{
          id: '00000000-0000-7000-8000-000000000003', fileName: 'plan.md', mimeType: 'text/markdown',
          sizeBytes: 10, contentAvailable: true, createdAt: '2026-09-04T12:00:00.000Z',
        }] }],
      }] },
    ])} />);
    expect(screen.getByRole('heading', { name: 'Decisions' })).toBeInTheDocument();
    expect(screen.getByText('Verbatim recent context.')).toBeInTheDocument();
    expect(screen.getByText('Attachment: plan.md')).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('explains an empty starting context', () => {
    render(<SubstreamContext context={context([])} />);
    expect(screen.getByText('No earlier messages are included.')).toBeInTheDocument();
  });
});
