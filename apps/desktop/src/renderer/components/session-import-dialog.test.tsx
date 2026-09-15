import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { SessionImportPreview } from '@rally/contracts';
import { describe, expect, it, vi } from 'vitest';
import { SessionImportForm } from './session-import-dialog';

describe('session import form', () => {
  it('freezes the submitted content while pending and retries an uncertain result with the same identity', async () => {
    const preview: SessionImportPreview = {
      title: 'Original title', source: { provider: 'claude', url: null },
      content: { messages: [{ role: 'user', text: 'Original question' }] },
    };
    let rejectImport!: (reason: Error) => void;
    const importSession = vi.fn(() => new Promise<string>((_resolve, reject) => { rejectImport = reject; }));
    render(<SessionImportForm open onOpenChange={vi.fn()} onImported={vi.fn()}
      api={{ previewSessionImport: vi.fn().mockResolvedValue(preview), importSession }} />);
    fireEvent.change(screen.getByLabelText('Shared conversation link'), { target: { value: 'https://claude.ai/share/f027df6e-0004-460c-8ec7-0666310a2ee2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Read conversation' }));
    const title = await screen.findByLabelText('Work stream title');
    fireEvent.click(screen.getByRole('button', { name: 'Import into new work stream' }));
    await waitFor(() => expect(importSession).toHaveBeenCalledTimes(1));
    expect(title).toBeDisabled();
    const firstRequest = importSession.mock.calls[0];
    await act(async () => rejectImport(new Error('Response unavailable')));
    expect(title).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Import into new work stream' }));
    await waitFor(() => expect(importSession).toHaveBeenCalledTimes(2));
    expect(importSession.mock.calls[1]).toEqual(firstRequest);
    await act(async () => rejectImport(new Error('Response unavailable')));
  });
});
