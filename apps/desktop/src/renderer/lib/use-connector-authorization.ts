import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';
import type { ConnectorOAuthProvider } from '@avalon/contracts';
import type { AvalonApi } from './api';
import { desktopBridge } from './platform';
import type { Scope } from './types';

export const connectorProviderName: Record<ConnectorOAuthProvider, string> = {
  google: 'Google',
  github: 'GitHub',
  granola: 'Granola',
  linear: 'Linear',
  notion: 'Notion',
  slack: 'Slack',
};

export interface PendingConnectorAuthorization {
  attemptId: string;
  provider: ConnectorOAuthProvider;
  startedAt: number;
}

export interface ConnectorAuthorization {
  /** The authorization waiting on the system browser, or null when none is. */
  pending: PendingConnectorAuthorization | null;
  /** Set once an authorization has succeeded, for a surface that says so. */
  message: string | null;
  error: string | null;
  begin: (input: {
    provider: ConnectorOAuthProvider;
    scope: Scope;
    capabilities: string[];
  }) => Promise<void>;
  reconnect: (connectionId: string) => Promise<void>;
  reset: () => void;
}

/**
 * Starting a connector authorization and waiting for it to land.
 *
 * The wait is the whole reason this is a hook rather than a mutation. The
 * authorization completes in the system browser, in a redirect the desktop
 * client never sees, so the only way to learn the outcome is to ask the API
 * about the attempt until it stops being pending. Every surface that offers to
 * connect something needs that loop, and running two different versions of it
 * would mean a card in a transcript and the Settings pane disagreeing about
 * whether a connection exists.
 *
 * `['connections']` is what a card resolves its live state from, so a
 * successful attempt invalidates it here rather than leaving each caller to
 * remember — a caller that forgot would leave a connected connector still
 * showing a Connect button until something else happened to refetch.
 */
export function useConnectorAuthorization(api: AvalonApi | null): ConnectorAuthorization {
  const queryClient = useQueryClient();
  const [pending, setPending] = useState<PendingConnectorAuthorization | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reset = useCallback((): void => {
    setMessage(null);
    setError(null);
  }, []);

  const begin = useCallback(async (input: {
    provider: ConnectorOAuthProvider;
    scope: Scope;
    capabilities: string[];
  }): Promise<void> => {
    if (!api) return;
    setMessage(null);
    setError(null);
    const authorization = await api.startProviderConnection(
      input.provider,
      input.scope,
      input.capabilities,
    );
    await desktopBridge().openExternal(authorization.url);
    setPending({ attemptId: authorization.attemptId, provider: input.provider, startedAt: Date.now() });
  }, [api]);

  const reconnect = useCallback(async (connectionId: string): Promise<void> => {
    if (!api) return;
    setMessage(null);
    setError(null);
    const authorization = await api.reconnectConnection(connectionId);
    // The connection knows its provider; the start response does not carry it,
    // and the wait below needs it for every sentence it writes.
    const attempt = await api.getConnectorOAuthAttempt(authorization.attemptId);
    await desktopBridge().openExternal(authorization.url);
    setPending({ attemptId: authorization.attemptId, provider: attempt.provider, startedAt: Date.now() });
  }, [api]);

  useEffect(() => {
    if (!api || !pending) return;
    let cancelled = false;
    let timer: number | undefined;
    let retryDelayMs = 750;
    const providerName = connectorProviderName[pending.provider];

    const poll = async (): Promise<void> => {
      try {
        const attempt = await api.getConnectorOAuthAttempt(pending.attemptId);
        if (cancelled) return;
        if (attempt.status === 'pending') {
          retryDelayMs = 1_000;
          timer = window.setTimeout(() => void poll(), retryDelayMs);
          return;
        }
        setPending(null);
        if (attempt.status === 'succeeded') {
          setError(null);
          setMessage(`${providerName} is connected.`);
          void Promise.all([
            queryClient.invalidateQueries({ queryKey: ['connections'] }),
            queryClient.invalidateQueries({ queryKey: ['workstream'] }),
            queryClient.invalidateQueries({ queryKey: ['automation'] }),
          ]);
          return;
        }
        setMessage(null);
        setError(
          attempt.status === 'denied'
            ? `${providerName} authorization was cancelled.`
            : attempt.errorCode === 'oauth_attempt_expired'
              ? `${providerName} authorization expired. Try connecting again.`
              : `${providerName} could not be connected. Try again.`,
        );
      } catch {
        if (cancelled) return;
        // The attempt outlives a transient failure to ask about it, so the poll
        // backs off rather than giving up — but not forever: past the attempt's
        // own lifetime there is nothing left to learn.
        if (Date.now() - pending.startedAt >= 16 * 60_000) {
          setPending(null);
          setError(`${providerName} authorization could not be confirmed. Refresh connections or try again.`);
          return;
        }
        retryDelayMs = Math.min(5_000, retryDelayMs * 2);
        timer = window.setTimeout(() => void poll(), retryDelayMs);
      }
    };

    void poll();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [api, pending, queryClient]);

  return { pending, message, error, begin, reconnect, reset };
}
