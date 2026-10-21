import { useMutation, useQuery } from '@tanstack/react-query';
import { WorkstreamGlyph } from '@rally/ui/components/workstream-glyph';
import { Check, LoaderCircle } from 'lucide-react';

import type { RallyApi } from '../lib/api';
import { ApiError } from '../lib/api';
import { Button, ErrorNotice } from './primitives';

/**
 * What a member sees on a link to a Channel or Breakout they are not in: its
 * name and mark, and "Request access", which emails its creator a one-click
 * approval. Asked only after the socket has refused, so opening a Channel
 * somebody is in costs nothing more.
 *
 * Renders `fallback` while the preview loads, when it fails, and when the
 * person can open it after all, so any other failure keeps its own screen.
 * Once approved, the socket's own retry opens the conversation; nothing here
 * waits for it. `docs/channel-access-requests.md`.
 */
export type ConversationAccessApi = Pick<RallyApi, 'conversationAccessPreview' | 'requestConversationAccess'>;

export function ConversationAccessRequest({ api, parentId, substreamId, fallback, onRetry }: {
  api: ConversationAccessApi | null;
  parentId: string;
  substreamId: string;
  fallback: React.JSX.Element;
  /**
   * Dial the conversation again. A socket closed because access was revoked
   * never dials back by itself, so after an approval this is how it opens.
   */
  onRetry: () => void;
}): React.JSX.Element {
  const preview = useQuery({
    queryKey: ['conversation-access-preview', parentId, substreamId],
    queryFn: () => api!.conversationAccessPreview(parentId, substreamId),
    enabled: Boolean(api),
    retry: false,
    staleTime: 30_000,
  });
  const request = useMutation({
    mutationFn: () => api!.requestConversationAccess(parentId, substreamId),
  });
  if (!preview.data || preview.data.access !== 'requestable') return fallback;
  const { kind, title, appearance, markId } = preview.data;
  const noun = kind === 'breakout' ? 'breakout' : 'thread';
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
