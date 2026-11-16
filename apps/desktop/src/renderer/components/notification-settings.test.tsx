import { DEFAULT_MEMBER_PREFERENCES, MemberPreferencesSchema } from '@rally/contracts';
import * as Tooltip from '@radix-ui/react-tooltip';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { NotificationChannelSettings } from './notification-settings';

describe('the Notifications settings pane', () => {
  it('offers each kind with its channels from the person\'s preferences', async () => {
    const api = {
      getMyPreferences: vi.fn().mockResolvedValue(DEFAULT_MEMBER_PREFERENCES),
      updateMyPreferences: vi.fn().mockResolvedValue(DEFAULT_MEMBER_PREFERENCES),
      canvasNoticeChoices: vi.fn().mockResolvedValue({ canvases: [] }),
      setCanvasNoticeChoice: vi.fn(),
      joinCanvas: vi.fn(),
    };
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><Tooltip.Provider>
      <NotificationChannelSettings api={api} email="you@example.test" pushAvailable workspaceId="org" />
    </Tooltip.Provider></QueryClientProvider>);

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
      canvasNoticeChoices: vi.fn().mockResolvedValue({ canvases: [] }),
      setCanvasNoticeChoice: vi.fn(),
      joinCanvas: vi.fn(),
    };
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><Tooltip.Provider>
      <NotificationChannelSettings api={api} email="you@example.test" pushAvailable workspaceId="org" />
    </Tooltip.Provider></QueryClientProvider>);
    await waitFor(() => expect(api.getMyPreferences).toHaveBeenCalled());

    const pickers = await screen.findAllByLabelText(/^How to tell you about /u);
    expect(pickers.map((picker) => picker.getAttribute('aria-label'))).toEqual([
      'How to tell you about mentions',
      'How to tell you about new messages',
      'How to tell you about being added',
      'How to tell you about Sidekick runs',
      'How to tell you about pinned Canvas updates',
      'How to tell you about access requests',
      'How to tell you about source requests',
      'How to tell you about Canvas notices',
    ]);
    // The kinds still accepted when stored are never offered.
    expect(screen.queryByText(/thread|breakout|merge/iu)).toBeNull();

    // Push is on by default; turning it off for access requests saves that kind alone.
    // The pane has no width here, so each picker is its menu.
    fireEvent.pointerDown(pickers[5]!, { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole('menuitemcheckbox', { name: /Push/u }));
    await waitFor(() => expect(api.updateMyPreferences).toHaveBeenCalled());
    expect(api.updateMyPreferences.mock.calls[0]).toContainEqual({ notify: { accessRequests: [] } });
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('menuitemcheckbox')).toBeNull());

    // A source request also goes by email until the person says otherwise, the one kind that does.
    fireEvent.pointerDown(pickers[6]!, { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole('menuitemcheckbox', { name: /Email/u }));
    await waitFor(() => expect(api.updateMyPreferences).toHaveBeenCalledTimes(2));
    expect(api.updateMyPreferences.mock.calls[1]).toContainEqual({ notify: { sourceRequests: ['push'] } });
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
      canvasNoticeChoices: vi.fn().mockResolvedValue({ canvases: [] }),
      setCanvasNoticeChoice: vi.fn(),
      joinCanvas: vi.fn(),
    };
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><Tooltip.Provider>
      <NotificationChannelSettings api={api} email="you@example.test" pushAvailable workspaceId="org" />
    </Tooltip.Provider></QueryClientProvider>);
    await waitFor(() => expect(api.getMyPreferences).toHaveBeenCalled());

    const pickers = await screen.findAllByLabelText(/^How to tell you about /u);
    expect(pickers).toHaveLength(8);
    for (const picker of pickers.slice(1)) {
      fireEvent.pointerDown(picker, { button: 0, ctrlKey: false });
      const choices = await screen.findAllByRole('menuitemcheckbox');
      expect(choices.map((choice) => choice.textContent)).toEqual(['PushOn every device signed in', 'EmailTo you@example.test']);
      fireEvent.keyDown(choices[0]!, { key: 'Escape' });
      await waitFor(() => expect(screen.queryByRole('menuitemcheckbox')).toBeNull());
    }
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
      canvasNoticeChoices: vi.fn().mockResolvedValue({ canvases: [] }),
      setCanvasNoticeChoice: vi.fn(),
      joinCanvas: vi.fn(),
    };
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><Tooltip.Provider>
      <NotificationChannelSettings api={api} email="you@example.test" pushAvailable={false} workspaceId="org" />
    </Tooltip.Provider></QueryClientProvider>);
    await waitFor(() => expect(api.getMyPreferences).toHaveBeenCalled());

    const pickers = await screen.findAllByLabelText(/^How to tell you about /u);
    fireEvent.pointerDown(pickers[1]!, { button: 0, ctrlKey: false });
    const choices = await screen.findAllByRole('menuitemcheckbox');
    expect(choices.map((choice) => choice.textContent)).toEqual(['EmailTo you@example.test']);
    fireEvent.click(choices[0]!);
    await waitFor(() => expect(api.updateMyPreferences).toHaveBeenCalled());
    expect(api.updateMyPreferences.mock.calls[0]).toContainEqual({ notify: { newMessages: ['push', 'email'] } });
  });

  it('lists each Canvas that sends notices under the default, following it until changed there', async () => {
    const canvasId = '00000000-0000-7000-8000-00000000c0c1';
    const api = {
      getMyPreferences: vi.fn().mockResolvedValue(DEFAULT_MEMBER_PREFERENCES),
      updateMyPreferences: vi.fn().mockResolvedValue(DEFAULT_MEMBER_PREFERENCES),
      canvasNoticeChoices: vi.fn().mockResolvedValue({ canvases: [{ canvasId, title: 'Newsletter', purpose: 'New episodes.', participant: true, channels: null }] }),
      setCanvasNoticeChoice: vi.fn(),
      joinCanvas: vi.fn(),
    };
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><Tooltip.Provider>
      <NotificationChannelSettings api={api} email="you@example.test" pushAvailable workspaceId="org" />
    </Tooltip.Provider></QueryClientProvider>);

    expect(await screen.findByText('Newsletter')).toBeVisible();
    expect(screen.getByText('Follows the default above. New episodes.')).toBeVisible();
    // The row shows the default, push and email, and a change becomes this Canvas's own choice.
    const picker = screen.getByLabelText('How Newsletter tells you');
    fireEvent.pointerDown(picker, { button: 0, ctrlKey: false });
    const choices = await screen.findAllByRole('menuitemcheckbox');
    expect(choices.map((choice) => choice.getAttribute('aria-checked'))).toEqual(['true', 'true']);
    fireEvent.click(choices[1]!);
    await waitFor(() => expect(api.setCanvasNoticeChoice).toHaveBeenCalledWith(canvasId, ['push']));
  });

  it('greys a Canvas the person could join, and adds them as a participant from its row', async () => {
    const canvasId = '00000000-0000-7000-8000-00000000c0c2';
    const api = {
      getMyPreferences: vi.fn().mockResolvedValue(DEFAULT_MEMBER_PREFERENCES),
      updateMyPreferences: vi.fn().mockResolvedValue(DEFAULT_MEMBER_PREFERENCES),
      canvasNoticeChoices: vi.fn().mockResolvedValue({ canvases: [{ canvasId, title: 'Launch plan', purpose: 'Checklist changes.', participant: false, channels: null }] }),
      setCanvasNoticeChoice: vi.fn(),
      joinCanvas: vi.fn().mockResolvedValue({ id: canvasId }),
    };
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><Tooltip.Provider>
      <NotificationChannelSettings api={api} email="you@example.test" pushAvailable workspaceId="org" />
    </Tooltip.Provider></QueryClientProvider>);

    expect(await screen.findByText('You are not a participant, so these do not reach you. Checklist changes.')).toBeVisible();
    expect(screen.getByLabelText('How Launch plan tells you')).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Add as participant' }));
    await waitFor(() => expect(api.joinCanvas).toHaveBeenCalledWith(canvasId));
    // Joined: the row now follows the default and can be changed.
    expect(await screen.findByText('Follows the default above. Checklist changes.')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Add as participant' })).toBeNull();
  });
});
