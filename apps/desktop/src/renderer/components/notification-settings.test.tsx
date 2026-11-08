import { DEFAULT_MEMBER_PREFERENCES, MemberPreferencesSchema } from '@rally/contracts';
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
      <NotificationChannelSettings api={api} email="you@example.test" pushAvailable workspaceId="org" />
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
      <NotificationChannelSettings api={api} email="you@example.test" pushAvailable workspaceId="org" />
    </QueryClientProvider>);
    await waitFor(() => expect(api.getMyPreferences).toHaveBeenCalled());

    const pickers = await screen.findAllByLabelText(/^How to tell you about /u);
    expect(pickers.map((picker) => picker.getAttribute('aria-label'))).toEqual([
      'How to tell you about mentions',
      'How to tell you about new messages',
      'How to tell you about being added',
      'How to tell you about Sidekick runs',
      'How to tell you about pinned Canvas updates',
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

  it('offers Push and Email for every kind, never draws a stored Slack choice, and does not save it back', async () => {
    // As the API client reads it: through the contract, from a record that
    // still names Slack.
    const stored = MemberPreferencesSchema.parse({
      ...DEFAULT_MEMBER_PREFERENCES,
      notify: { ...DEFAULT_MEMBER_PREFERENCES.notify, mentions: ['push', 'slack_agent_dm'] },
    });
    const api = {
      getMyPreferences: vi.fn().mockResolvedValue(stored),
      updateMyPreferences: vi.fn().mockResolvedValue(stored),
    };
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}>
      <NotificationChannelSettings api={api} email="you@example.test" pushAvailable workspaceId="org" />
    </QueryClientProvider>);
    await waitFor(() => expect(api.getMyPreferences).toHaveBeenCalled());

    const pickers = await screen.findAllByLabelText(/^How to tell you about /u);
    expect(pickers).toHaveLength(6);
    fireEvent.pointerDown(pickers[0]!, { button: 0, ctrlKey: false });
    const choices = await screen.findAllByRole('menuitemcheckbox');
    expect(choices.map((choice) => choice.textContent)).toEqual(['PushOn every device signed in', 'EmailTo you@example.test']);
    expect(screen.queryByText(/slack/iu)).toBeNull();

    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: /Email/u }));
    await waitFor(() => expect(api.updateMyPreferences).toHaveBeenCalled());
    expect(api.updateMyPreferences.mock.calls[0]).toContainEqual({ notify: { mentions: ['push', 'email'] } });
  });

  it('keeps a hidden Push choice on a save where this deployment cannot push', async () => {
    const api = {
      getMyPreferences: vi.fn().mockResolvedValue(DEFAULT_MEMBER_PREFERENCES),
      updateMyPreferences: vi.fn().mockResolvedValue(DEFAULT_MEMBER_PREFERENCES),
    };
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}>
      <NotificationChannelSettings api={api} email="you@example.test" pushAvailable={false} workspaceId="org" />
    </QueryClientProvider>);
    await waitFor(() => expect(api.getMyPreferences).toHaveBeenCalled());

    const pickers = await screen.findAllByLabelText(/^How to tell you about /u);
    fireEvent.pointerDown(pickers[1]!, { button: 0, ctrlKey: false });
    const choices = await screen.findAllByRole('menuitemcheckbox');
    expect(choices.map((choice) => choice.textContent)).toEqual(['EmailTo you@example.test']);
    fireEvent.click(choices[0]!);
    await waitFor(() => expect(api.updateMyPreferences).toHaveBeenCalled());
    expect(api.updateMyPreferences.mock.calls[0]).toContainEqual({ notify: { newMessages: ['push', 'email'] } });
  });
});
