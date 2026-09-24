import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionImportPreview } from '@rally/contracts';
import type { RallyApi } from '../lib/api';
import type * as BrowserConversationImport from '../lib/browser-conversation-import';
import { SessionImportUpdateDialog, importedSourceUpdatable } from './session-import-update-dialog';

const readBrowserConversation = vi.hoisted(() => vi.fn());

vi.mock('../lib/platform', () => ({ desktopBridge: () => ({}) }));
vi.mock('../lib/browser-conversation-import', async (actual) => ({
  ...await actual<typeof BrowserConversationImport>(),
  readBrowserConversation,
}));

const url = 'https://claude.ai/chat/4f2b7c1e-9a3d-4e8b-b1c2-0d9e8f7a6b5c';
const preview = (sessionId: string): SessionImportPreview => ({ title: 'Chat', source: { provider: 'claude', url, sessionId },
  content: { messages: [{ role: 'user', text: 'Hello', sourceMessageId: 'h1' }] } });

describe('session import updates', () => {
  afterEach(() => vi.clearAllMocks());

  it('offers updates only for a source Rally’s browser can open again', () => {
    expect(importedSourceUpdatable({ provider: 'claude', sessionId: 's', url })).toBe(true);
    expect(importedSourceUpdatable({ provider: 'chatgpt', sessionId: 's', url: 'https://chatgpt.com/share/6ab43c03-6b2c-83e8-9eba-f1c51fa1e7a0' })).toBe(true);
    expect(importedSourceUpdatable({ provider: 'claude_code', sessionId: 's', url: null })).toBe(false);
    expect(importedSourceUpdatable(null)).toBe(false);
  });

  it('reads the recorded conversation through the browser and refuses a different one', async () => {
    readBrowserConversation.mockResolvedValue({ provider: 'claude', text: '{"source":"original"}' });
    const previewSessionImport = vi.fn<RallyApi['previewSessionImport']>()
      .mockResolvedValueOnce(preview('other'))
      .mockResolvedValueOnce(preview('original'));
    const updateImportedSession = vi.fn<RallyApi['updateImportedSession']>().mockResolvedValue({ added: 1, updated: 0 });
    const api = { previewSessionImport, updateImportedSession } satisfies Pick<RallyApi, 'previewSessionImport' | 'updateImportedSession'>;
    const onClose = vi.fn();
    render(<SessionImportUpdateDialog
      api={api}
      onClose={onClose} open source={{ provider: 'claude', sessionId: 'original', url }} workstreamId="w1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Import updates' }));
    expect(await screen.findByText('The source must match the conversation originally imported into this channel.')).toBeInTheDocument();
    expect(updateImportedSession).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Import updates' }));
    await waitFor(() => expect(updateImportedSession).toHaveBeenCalledWith('w1', preview('original'), expect.any(String)));
    expect(readBrowserConversation).toHaveBeenCalledWith(expect.anything(), url, { openIfMissing: true });
    expect(previewSessionImport).toHaveBeenLastCalledWith({ kind: 'export', provider: 'claude', text: '{"source":"original"}', sourceUrl: url });
    expect(onClose).toHaveBeenCalled();
  });
});
