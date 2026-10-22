import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { WorkstreamGlyph } from '@rally/ui/components/workstream-glyph';
import { Check, LoaderCircle } from 'lucide-react';
import { useEffect, useState } from 'react';

import type { RallyApi } from '../lib/api';
import { ApiError } from '../lib/api';
import { CONVERSATION_ACCESS_PREVIEW_QUERY_KEY } from '../lib/access-requests';
import { Button, ErrorNotice, OpeningState } from './primitives';

/**
 * What a member sees on a link to a Channel or Breakout they are not in: its
 * name and mark, and "Request access", which emails its creator a one-click
 * approval. Asked only after the socket has refused, so opening a Channel
 * somebody is in costs nothing more.
 *
 * Renders `fallback` while the preview loads, when it fails, and when the
 * person could already open it, so any other failure keeps its own screen.
 * An Organization reach-change push refreshes the preview. When access opens,
 * retry the conversation immediately, including after a revoked socket stopped
 * retrying. `docs/channel-access-requests.md`.
 */
export type ConversationAccessApi = Pick<RallyApi, 'conversationAccessPreview' | 'requestConversationAccess'>;

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
  const preview = useQuery({
    queryKey: [...CONVERSATION_ACCESS_PREVIEW_QUERY_KEY, parentId, substreamId],
    queryFn: () => api!.conversationAccessPreview(parentId, substreamId),
    enabled: Boolean(api),
    retry: false,
    staleTime: 30_000,
  });
  const address = `${parentId}:${substreamId}`;
  const [waitingFor, setWaitingFor] = useState<string | null>(null);
  const request = useMutation({
    mutationFn: () => api!.requestConversationAccess(parentId, substreamId),
  });
  useEffect(() => queryClient.getQueryCache().subscribe((event) => {
    if (event.type !== 'updated' || event.action.type !== 'invalidate') return;
    const [root, parent, substream] = event.query.queryKey;
    if (root === CONVERSATION_ACCESS_PREVIEW_QUERY_KEY[0] && parent === parentId && substream === substreamId) {
      // A push may replace the very first preview before it ever says
      // requestable. Record that explicit refresh before its result arrives.
      setWaitingFor(address);
    }
  }), [address, parentId, queryClient, substreamId]);
  useEffect(() => {
    if (preview.data?.access === 'requestable') setWaitingFor(address);
    // Refetching keeps cached data visible; only the completed check can
    // confirm that an earlier open decision still applies.
    else if (preview.isSuccess && !preview.isFetching && preview.data?.access === 'open' && waitingFor === address) onRetry();
  }, [address, onRetry, preview.data?.access, preview.isFetching, preview.isSuccess, waitingFor]);
  // A newly admitted preview must not mount the error dialog while the retry
  // starts. An initially open preview still belongs to the ordinary error path:
  // retrying that on every mount would loop on unrelated connection failures.
  const noun = preview.data?.kind === 'breakout' ? 'breakout' : 'thread';
  if (preview.isSuccess && !preview.isFetching && preview.data?.access === 'open' && waitingFor === address) {
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
        <p>You’re not in this {noun}, ask for access below</p>
        {request.isSuccess ? (
          <>
            <p className="conversation-access-request-sent" role="status">
              <Check aria-hidden="true" size={14} /> Request sent. This {noun} opens once you’re approved.
            </p>
            <Button onClick={onRetry}>Try again</Button>
          </>
        ) : (
          <Button className="button-primary" disabled={request.isPending} onClick={() => request.mutate()}>
            {request.isPending && <LoaderCircle aria-hidden="true" className="spin" size={14} />} Request access
          </Button>
        )}
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
