import type { CanvasAccess } from '@rally/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { canvasAccessQueryKey, canvasDetailQueryKey } from '../lib/canvases';
import { useCollaborationSession } from '../lib/collaboration-session';
import { formatRelative } from '../lib/format';
import { PaneState } from './pane-state';
import { Button, ErrorNotice, Modal } from './primitives';
import { RelativeTime } from './relative-time';

/**
 * A Canvas that exists in this person's Organization but does not admit them
 * (`GET /canvases/:id/access` answered `requestable`): the pane says so,
 * without its title, and offers Request access, one dialog with an optional
 * message. While their request is pending the button stays disabled under
 * "Request sent · <when>"; a denied request reads as none, because a denial
 * tells the requester nothing (`docs/canvases.md#asking-to-open-a-canvas`).
 * The grant reopens the pane into the Canvas on its own: the screen refetches
 * the Canvas when it appears in the list or an `access_granted` row arrives.
 */
export function CanvasAccessRequestPane({ access, canvasId }: { access: CanvasAccess; canvasId: string }): React.JSX.Element {
  const { api } = useCollaborationSession();
  const queryClient = useQueryClient();
  const [asking, setAsking] = useState(false);
  const [message, setMessage] = useState('');
  const send = useMutation({
    mutationFn: (text: string) => api!.requestCanvasAccess(canvasId, text.trim() || undefined),
    onSuccess: async (result) => {
      setAsking(false);
      setMessage('');
      // Added by other means meanwhile: the Canvas opens now.
      if (result.status === 'already_participant') {
        await queryClient.invalidateQueries({ queryKey: canvasDetailQueryKey(canvasId) });
        return;
      }
      queryClient.setQueryData<CanvasAccess>(canvasAccessQueryKey(canvasId), (cached) => cached && {
        ...cached,
        request: cached.request?.state === 'pending' ? cached.request : { state: 'pending', requestedAt: new Date().toISOString() },
      });
      // The server's own time for the request replaces the one painted above.
      void queryClient.invalidateQueries({ queryKey: canvasAccessQueryKey(canvasId) });
    },
  });
  const pending = access.request?.state === 'pending' ? access.request : null;
  const close = (): void => {
    if (send.isPending) return;
    send.reset();
    setAsking(false);
  };
  return <>
    <PaneState
      action={<div className="canvas-access-request-actions">
        <Button className="button-primary" disabled={!api || pending !== null || send.isPending} onClick={() => setAsking(true)}>Request access</Button>
        {pending && <p className="canvas-access-request-sent" role="status">
          Request sent · <RelativeTime format={formatRelative} value={pending.requestedAt} />
        </p>}
      </div>}
      description={pending
        ? 'The people who manage it have been asked. It opens here once someone lets you in.'
        : 'Ask the people who manage it to let you in.'}
      title="You don't have access to this Canvas"
    />
    <Modal
      description="The Canvas's creator and your Organization's administrators are asked to let you in."
      footer={<>
        <Button disabled={send.isPending} onClick={close}>Cancel</Button>
        <Button className="button-primary" disabled={send.isPending} onClick={() => send.mutate(message)}>
          {send.isPending ? 'Sending…' : 'Send request'}
        </Button>
      </>}
      onOpenChange={(open) => { if (!open) close(); }}
      open={asking}
      title="Request access"
    >
      <label className="form-field">Message (optional)
        <input
          aria-label="Message (optional)"
          disabled={send.isPending}
          onChange={(event) => setMessage(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.nativeEvent.isComposing) send.mutate(message);
          }}
          placeholder="Why you'd like to open it"
          type="text"
          value={message}
        />
      </label>
      {send.error && <ErrorNotice occurrence={send.error} title="The request could not be sent">{send.error.message}</ErrorNotice>}
    </Modal>
  </>;
}

/**
 * Approve and Deny for one person's pending request to open a Canvas, the
 * same call wherever a decider meets it: their `access_request` Activity row
 * and the Share panel's Requests section
 * (`POST /canvases/:id/access-requests/:userId/decision`). The write moves
 * every decider's Activity row, which the list push carries; the detail is
 * read again so the Share panel's list drops the request. A refusal (another
 * decider settled it first, or this person no longer manages the Canvas)
 * names itself through the error notice.
 */
export function AccessDecisionActions({ canvasId, label, userId }: {
  canvasId: string;
  /** Who asked, for the buttons' accessible names: "Approve Maya Lin". */
  label: string;
  userId: string;
}): React.JSX.Element {
  const { api } = useCollaborationSession();
  const queryClient = useQueryClient();
  const decide = useMutation({
    mutationFn: (decision: 'approve' | 'deny') => api!.decideCanvasAccess(canvasId, userId, decision),
    onSettled: () => queryClient.invalidateQueries({ queryKey: canvasDetailQueryKey(canvasId) }),
  });
  return <div className="access-decision-actions">
    <Button aria-label={`Deny ${label}`} disabled={!api || decide.isPending} onClick={() => decide.mutate('deny')}>Deny</Button>
    <Button aria-label={`Approve ${label}`} className="button-primary" disabled={!api || decide.isPending} onClick={() => decide.mutate('approve')}>Approve</Button>
    {decide.error && <ErrorNotice occurrence={decide.error} title="The request could not be answered">{decide.error.message}</ErrorNotice>}
  </div>;
}
