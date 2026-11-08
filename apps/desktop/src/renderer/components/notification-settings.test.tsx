import { DEFAULT_MEMBER_PREFERENCES } from '@rally/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { NotificationChannelSettings } from './notification-settings';

describe('the Notifications settings pane', () => {
  it('offers each kind with its channels, reading nothing but the person\'s preferences', async () => {
    const api = {
      getMyPreferences: vi.fn().mockResolvedValue(DEFAULT_MEMBER_PREFERENCES),
      updateMyPreferences: vi.fn().mockResolvedValue(DEFAULT_MEMBER_PREFERENCES),
    };
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}>
      <NotificationChannelSettings api={api} connections={[]} email="you@example.test" pushAvailable workspaceId="org" />
    </QueryClientProvider>);

    expect(screen.getByRole('heading', { name: 'Notify me about' })).toBeVisible();
    expect(screen.getByText('Mentions')).toBeVisible();
    // No digest: nothing on the pane asks for a schedule or names one.
    expect(screen.queryByText(/digest/iu)).toBeNull();
    await waitFor(() => expect(api.getMyPreferences).toHaveBeenCalled());
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('lists exactly the kinds a producer records, in order, and saves the one toggled', async () => {
    const api = {
      getMyPreferences: vi.fn().mockResolvedValue(DEFAULT_MEMBER_PREFERENCES),
      updateMyPreferences: vi.fn().mockResolvedValue(DEFAULT_MEMBER_PREFERENCES),
    };
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}>
      <NotificationChannelSettings api={api} connections={[]} email="you@example.test" pushAvailable workspaceId="org" />
    </QueryClientProvider>);
    await waitFor(() => expect(api.getMyPreferences).toHaveBeenCalled());

    const pickers = await screen.findAllByLabelText(/^How to tell you about /u);
    expect(pickers.map((picker) => picker.getAttribute('aria-label'))).toEqual([
      'How to tell you about mentions',
      'How to tell you about new messages',
      'How to tell you about being added',
      'How to tell you about sidekick runs',
      'How to tell you about pinned canvas updates',
      'How to tell you about access requests',
    ]);
    // The kinds still accepted when stored are never offered.
    expect(screen.queryByText(/thread|breakout|merge/iu)).toBeNull();

    // Push is on by default; turning it off for access requests saves that kind alone.
    // The pane has no width here, so each picker is its menu.
    fireEvent.pointerDown(pickers.at(-1)!, { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole('menuitemcheckbox', { name: /Push/u }));
    await waitFor(() => expect(api.updateMyPreferences).toHaveBeenCalled());
    expect(api.updateMyPreferences.mock.calls[0]).toContainEqual({ notify: { accessRequests: [] } });
  });
});
