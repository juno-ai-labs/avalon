import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RallyApi } from '../lib/api';
import { SessionImportUpdateDialog } from './session-import-update-dialog';

const listLocalClaudeSessions = vi.hoisted(() => vi.fn());
const readLocalClaudeSession = vi.hoisted(() => vi.fn());

vi.mock('../lib/platform', () => ({
  desktopBridge: () => ({
    listLocalClaudeSessions,
    onApplicationForegroundChanged: () => () => undefined,
    readLocalClaudeSession,
  }),
}));

describe('session import updates', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('reads the recorded Claude conversation without offering another source', async () => {
    vi.stubGlobal('rally', {});
    listLocalClaudeSessions.mockResolvedValue([
      { id: 'other', kind: 'chat', title: 'Other conversation', updatedAt: 2, sourceSessionId: 'other' },
      { id: 'original', kind: 'chat', title: 'Original conversation', updatedAt: 1, sourceSessionId: 'original' },
    ]);
    readLocalClaudeSession.mockResolvedValue({ text: '{"source":"original"}' });
    const previewSessionImport = vi.fn().mockResolvedValue({ source: { provider: 'claude', sessionId: 'original' } });
    const updateImportedSession = vi.fn().mockResolvedValue({ added: 0, updated: 0 });
    const api = { previewSessionImport, updateImportedSession } satisfies Pick<RallyApi, 'previewSessionImport' | 'updateImportedSession'>;

    render(<SessionImportUpdateDialog api={api} open onClose={vi.fn()}
      source={{ provider: 'claude', sessionId: 'original', url: null }} workstreamId="channel" />);

    expect(await screen.findByText('Original conversation')).toBeInTheDocument();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(screen.queryByText('Other conversation')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Import updates' }));

    await waitFor(() => expect(updateImportedSession).toHaveBeenCalledOnce());
    expect(readLocalClaudeSession).toHaveBeenCalledWith('original');
    expect(previewSessionImport).toHaveBeenCalledWith({ kind: 'export', provider: 'claude', text: '{"source":"original"}' });
  });
});
