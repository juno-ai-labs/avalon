import { DEFAULT_MEMBER_PREFERENCES, type MemberPreferences, type MemberPreferencesUpdate } from '@rally/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { useSaveMemberPreferences } from './use-member-preferences';

describe('useSaveMemberPreferences', () => {
  it('sends a second save only once the first has been answered, so the later choice lands last', async () => {
    const answers: Array<(stored: MemberPreferences) => void> = [];
    const updateMyPreferences = vi.fn<(change: MemberPreferencesUpdate) => Promise<MemberPreferences>>(() =>
      new Promise<MemberPreferences>((resolve) => { answers.push(resolve); }));
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    const { result } = renderHook(() => useSaveMemberPreferences({ updateMyPreferences }, 'org-1'), { wrapper });

    act(() => {
      result.current.mutate({ notify: { mentions: ['push', 'email'] } });
      result.current.mutate({ notify: { mentions: ['email'] } });
    });
    await waitFor(() => expect(updateMyPreferences).toHaveBeenCalledTimes(1));
    expect(updateMyPreferences).toHaveBeenLastCalledWith({ notify: { mentions: ['push', 'email'] } });

    await act(async () => answers[0]!(DEFAULT_MEMBER_PREFERENCES));
    await waitFor(() => expect(updateMyPreferences).toHaveBeenCalledTimes(2));
    expect(updateMyPreferences).toHaveBeenLastCalledWith({ notify: { mentions: ['email'] } });
  });
});
