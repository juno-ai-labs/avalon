import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { SupportAccess } from '@rally/contracts';
import type { RallyApi } from '../lib/api';
import { useNow } from '../lib/clock';
import { formatDateTime } from '../lib/format';
import { SettingCopy } from '../settings/setting-label';
import { settings } from '../settings/registry';
import { Button, ErrorNotice } from './primitives';

const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;

/**
 * What is left of a grant, in the largest whole unit: "6 days left", then
 * "2 hours left", then minutes. Rounded down, so it never promises time the
 * grant does not have. Null once it has run out.
 */
export function formatSupportAccessRemaining(remainingMs: number): string | null {
  if (remainingMs <= 0) return null;
  const unit = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'} left`;
  if (remainingMs >= DAY_MS) return unit(Math.floor(remainingMs / DAY_MS), 'day');
  if (remainingMs >= HOUR_MS) return unit(Math.floor(remainingMs / HOUR_MS), 'hour');
  return unit(Math.max(1, Math.floor(remainingMs / 60_000)), 'minute');
}

export function supportAccessQueryKey(workspaceId: string) {
  return ['workspace', workspaceId, 'support-access'] as const;
}

/** The three calls the row makes. */
export type SupportAccessApi = Pick<RallyApi, 'getSupportAccess' | 'grantSupportAccess' | 'revokeSupportAccess'>;

/**
 * **Allow Rally access** under Organization preferences (`docs/impersonation.md`):
 * an administrator grants Rally staff seven days to act as the Organization's
 * people, sees the time counting down, and can revoke it. When it runs out the
 * row goes back to **Grant access** on its own.
 *
 * Everyone in the Organization sees the row; only an administrator can press
 * either button, and the server refuses a grant from a support session.
 */
export function SupportAccessSetting({ api, workspaceId, isAdmin, impersonating }: {
  api: SupportAccessApi | null;
  workspaceId: string;
  isAdmin: boolean;
  /** A support session cannot extend its own access. */
  impersonating: boolean;
}): React.JSX.Element | null {
  const queryClient = useQueryClient();
  const now = useNow();
  const key = supportAccessQueryKey(workspaceId);
  const access = useQuery({ queryKey: key, queryFn: () => api!.getSupportAccess(), enabled: Boolean(api) });
  const settle = (next: SupportAccess) => queryClient.setQueryData(key, next);
  const grant = useMutation({ mutationFn: () => api!.grantSupportAccess(), onSuccess: settle });
  const revoke = useMutation({ mutationFn: () => api!.revokeSupportAccess(), onSuccess: settle });
  if (!access.data?.available) return null;
  const expiresAt = access.data.expiresAt;
  const remaining = expiresAt ? formatSupportAccessRemaining(Date.parse(expiresAt) - now) : null;
  const pending = grant.isPending || revoke.isPending;
  const error = grant.error ?? revoke.error;
  return <>
    <div className="settings-preference-row support-access-row">
      <SettingCopy setting={settings.supportAccess} />
      <span className="support-access-controls">
        {remaining && expiresAt
          ? <>
              <span className="support-access-remaining" title={`Until ${formatDateTime(expiresAt)}`}>{remaining}</span>
              <Button className="button-secondary" disabled={!isAdmin || pending} onClick={() => revoke.mutate()}>
                Revoke access
              </Button>
            </>
          : <Button className="button-secondary" disabled={!isAdmin || impersonating || pending} onClick={() => grant.mutate()}>
              Grant access
            </Button>}
      </span>
    </div>
    {error && <ErrorNotice>{error.message}</ErrorNotice>}
  </>;
}
