import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ConversationAccessPreview } from '@rally/contracts';
import { WorkstreamGlyph } from '@rally/ui/components/workstream-glyph';
import { Check, LoaderCircle } from 'lucide-react';
import { useEffect, useState } from 'react';

import type { RallyApi } from '../lib/api';
import { ApiError } from '../lib/api';
import {
  claimConversationAccessRecovery,
  CONVERSATION_ACCESS_PREVIEW_QUERY_KEY,
  CONVERSATION_ACCESS_RECOVERY_QUERY_KEY,
  useConversationAccessRecovery,
  type ConversationAccessRecovery,
} from '../lib/access-requests';
import { Button, ErrorNotice, OpeningState } from './primitives';

/**
 * What a member sees on a link to a Channel or Breakout they are not in: its
 * name and mark, and "Request access", which emails its creator a one-click
 * approval. Asked only after the socket has refused, so opening a Channel
 * somebody is in costs nothing more.
 *
 * An Organization access nudge permits one fresh admission retry, even when it
 * arrived before this screen. Other failures keep their own screen, and a failed
 * retry cannot loop on remount. `docs/channel-access-requests.md`.
 */
export type ConversationAccessApi = Pick<RallyApi, 'viewerUserId' | 'conversationAccessPreview' | 'requestConversationAccess'>;

export function ConversationAccessRequest({ api, parentId, substreamId, fallback, onRetry }: {
  api: ConversationAccessApi | null;
  parentId: string;
  substreamId: string;
  fallback: React.JSX.Element;
  /**
   * Restart the conversation, including a socket stopped after revocation.
   */
  onRetry: () => void;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const recovery = useConversationAccessRecovery();
  const requesterUserId = api?.viewerUserId ?? null;
  const queryKey = [...CONVERSATION_ACCESS_PREVIEW_QUERY_KEY, requesterUserId, parentId, substreamId];
  const preview = useQuery({
    queryKey,
    queryFn: async () => {
      const recoveryVersion = queryClient.getQueryData<ConversationAccessRecovery>(CONVERSATION_ACCESS_RECOVERY_QUERY_KEY)?.version ?? 0;
      return { ...await api!.conversationAccessPreview(parentId, substreamId), recoveryVersion };
    },
    enabled: Boolean(api),
    retry: false,
  });
  const address = `${parentId}:${substreamId}`;
  const [reopening, setReopening] = useState<string | null>(null);
  const request = useMutation({
    mutationKey: ['conversation-access-request', requesterUserId, parentId, substreamId],
    mutationFn: (target: { parentId: string; substreamId: string; requesterUserId: string | null }) =>
      api!.requestConversationAccess(target.parentId, target.substreamId),
    onSuccess: async (_result, target) => {
      const submittedQueryKey = [...CONVERSATION_ACCESS_PREVIEW_QUERY_KEY, target.requesterUserId, target.parentId, target.substreamId];
      // A preview read before the write must not replace the successful result.
      await queryClient.cancelQueries({ queryKey: submittedQueryKey });
      queryClient.setQueryData<ConversationAccessPreview>(submittedQueryKey, (current) =>
        current ? { ...current, requestPending: true, requestEmailed: true } : current,
      );
    },
    onError: async (_error, target) => {
      // Email can fail after the request was stored; read that outcome back.
      await queryClient.invalidateQueries({
        queryKey: [...CONVERSATION_ACCESS_PREVIEW_QUERY_KEY, target.requesterUserId, target.parentId, target.substreamId],
      });
    },
  });
  const admitted = preview.isSuccess && preview.fetchStatus === 'idle' && preview.data?.access === 'open';
  const canRecover = admitted && recovery !== undefined
    && preview.data?.recoveryVersion === recovery.version && !recovery.retried.includes(address);
  useEffect(() => {
    if (!canRecover || !recovery || !claimConversationAccessRecovery(queryClient, address, recovery.version)) return;
    setReopening(address);
    onRetry();
  }, [address, canRecover, onRetry, queryClient, recovery]);
  // A newly admitted preview must not mount the error dialog while the retry
  // starts. The consumed nudge prevents another retry if this screen remounts.
  const noun = preview.data?.kind === 'breakout' ? 'breakout' : 'thread';
  if (admitted && (canRecover || reopening === address)) {
    return <OpeningState label={`Opening ${noun}…`} />;
  }
  if (!preview.data || preview.data.access !== 'requestable') return fallback;
  const { title, appearance, markId } = preview.data;
  return (
    <div className="screen-error-state screen-with-titlebar">
      <div className="screen-drag-strip window-drag" />
      <div className="conversation-access-request window-no-drag">
        <WorkstreamGlyph appearance={appearance ?? undefined} id={markId} size={40} />
        <h1 className="conversation-access-request-title">{title}</h1>
        {preview.data.requestPending ? (
          <p className="conversation-access-request-sent" role="status">
            <Check aria-hidden="true" size={14} /> Access requested — awaiting approval
          </p>
        ) : (
          <p>You’re not in this {noun}, ask for access below</p>
        )}
        {(!preview.data.requestPending || !preview.data.requestEmailed) && (
          <Button className="button-primary" disabled={request.isPending} onClick={() => request.mutate({ parentId, substreamId, requesterUserId })}>
            {request.isPending && <LoaderCircle aria-hidden="true" className="spin" size={14} />}
            {preview.data.requestPending ? 'Retry sending request' : 'Request access'}
          </Button>
        )}
        {preview.data.requestPending && <Button onClick={onRetry}>Try again</Button>}
        {request.error && (
          <ErrorNotice>
            {request.error instanceof ApiError && request.error.code === 'access_request_no_approver'
              ? request.error.message
              : 'The request couldn’t be sent. Try again.'}
          </ErrorNotice>
        )}
      </div>
    </div>
  );
}
