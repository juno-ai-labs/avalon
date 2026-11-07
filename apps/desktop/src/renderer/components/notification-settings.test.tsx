import { DEFAULT_MEMBER_PREFERENCES } from '@rally/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
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
});
