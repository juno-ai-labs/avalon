import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionImportUpdateDialog, importedSourceUpdatable } from './session-import-update-dialog';

const openBrowserImport = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('../lib/platform', () => ({ desktopBridge: () => ({ openBrowserImport }) }));

const url = 'https://claude.ai/chat/4f2b7c1e-9a3d-4e8b-b1c2-0d9e8f7a6b5c';

describe('session import updates', () => {
  afterEach(() => vi.clearAllMocks());

  it('offers updates only for a source Rally’s browser can open again', () => {
    expect(importedSourceUpdatable({ provider: 'claude', sessionId: 's', url })).toBe(true);
    expect(importedSourceUpdatable({ provider: 'chatgpt', sessionId: 's', url: 'https://example.com/research-note' })).toBe(true);
    expect(importedSourceUpdatable({ provider: 'claude_code', sessionId: 's', url: null })).toBe(false);
    expect(importedSourceUpdatable(null)).toBe(false);
  });

  it('opens the import window on the recorded conversation, in update mode', async () => {
    const onClose = vi.fn();
    render(<SessionImportUpdateDialog onClose={onClose} open source={{ provider: 'claude', sessionId: 'original', url }} workstreamId="w1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Import updates' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(openBrowserImport).toHaveBeenCalledWith({ spaces: [], update: { workstreamId: 'w1', sourceUrl: url } });
  });
});
