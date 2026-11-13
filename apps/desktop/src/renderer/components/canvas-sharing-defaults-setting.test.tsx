import "../../../../../tests/isolated-region";
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { CanvasSharingDefaults, CanvasSharingDefaultsUpdate } from '@rally/contracts/canvases';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CanvasSharingDefaultsSetting, type CanvasSharingDefaultsApi } from './canvas-sharing-defaults-setting';

function renderWithQueries(node: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

function api(initial: CanvasSharingDefaults) {
  let state = initial;
  return {
    getCanvasSharingDefaults: vi.fn(async () => state),
    updateCanvasSharingDefaults: vi.fn(async (update: CanvasSharingDefaultsUpdate) => (state = { ...state, ...update })),
  } satisfies CanvasSharingDefaultsApi;
}

afterEach(cleanup);

describe('Canvas sharing defaults', () => {
  it('shows the stored defaults and saves only the one an administrator changes', async () => {
    const client = api({ editors: 'workspace', artifacts: 'public' });
    renderWithQueries(<CanvasSharingDefaultsSetting api={client} isAdmin workspaceId="workspace-acme" />);
    const editors = screen.getByRole('combobox', { name: 'Default Editor Audience' });
    // Disabled until the stored record arrives, so nobody saves over a choice they have not seen.
    await waitFor(() => expect(editors).toBeEnabled());
    expect(editors).toHaveTextContent('Everyone in the Organization');
    fireEvent.click(editors);
    fireEvent.keyDown(screen.getByRole('option', { name: 'Creator' }), { key: 'Enter' });
    await waitFor(() => expect(client.updateCanvasSharingDefaults).toHaveBeenCalledWith({ editors: 'creator' }));
    expect(await screen.findByRole('combobox', { name: 'Default Editor Audience' })).toHaveTextContent('Creator');
    expect(screen.getByRole('combobox', { name: 'Default Artifact Audience' })).toHaveTextContent('Anyone with a link');
  });

  it('holds both choices while a save is answered, so a slow answer cannot land over a later choice', async () => {
    const client = api({ editors: 'workspace', artifacts: 'public' });
    let answer: (value: CanvasSharingDefaults) => void = () => undefined;
    client.updateCanvasSharingDefaults.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));
    renderWithQueries(<CanvasSharingDefaultsSetting api={client} isAdmin workspaceId="workspace-acme" />);
    const editors = screen.getByRole('combobox', { name: 'Default Editor Audience' });
    await waitFor(() => expect(editors).toBeEnabled());
    fireEvent.click(editors);
    fireEvent.keyDown(screen.getByRole('option', { name: 'Creator' }), { key: 'Enter' });
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Default Artifact Audience' })).toBeDisabled());
    answer({ editors: 'creator', artifacts: 'public' });
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Default Artifact Audience' })).toBeEnabled());
    expect(screen.getByRole('combobox', { name: 'Default Editor Audience' })).toHaveTextContent('Creator');
  });

  it('shows a member the defaults without letting them change either', async () => {
    renderWithQueries(<CanvasSharingDefaultsSetting api={api({ editors: 'creator', artifacts: 'editors' })} isAdmin={false} workspaceId="workspace-acme" />);
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Default Artifact Audience' })).toHaveTextContent('Editors only'));
    expect(screen.getByRole('combobox', { name: 'Default Editor Audience' })).toBeDisabled();
    expect(screen.getByRole('combobox', { name: 'Default Artifact Audience' })).toBeDisabled();
  });
});
