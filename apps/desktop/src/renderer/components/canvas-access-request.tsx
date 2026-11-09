import type { CanvasAccess } from '@rally/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';

import { canvasAccessDecisionRefusal, canvasAccessQueryKey, canvasDetailQueryKey } from '../lib/canvases';
import { useCollaborationSession } from '../lib/collaboration-session';
import { formatRelative } from '../lib/format';
import { PaneState } from './pane-state';
import { Button, ErrorNotice, Modal } from './primitives';
import { RelativeTime } from './relative-time';

/**
 * A Canvas that exists in this person's Organization but does not admit them
 * (`GET /canvases/:id/access` answered `requestable`): the pane says so,
 * without its title, and offers Request access, one dialog with an optional
 * message. While their request is pending the button gives way to
 * "Request sent · <when>" alone. A declined request reads "Request declined
 * · <when>" with Request access offered again, since a denial allows a new
 * request (`docs/canvas-access-requests.md`, "In the client"). The grant
 * reopens the pane into the Canvas on its own: the screen refetches the
 * Canvas when it appears in the list or an `access_granted` row arrives, and
 * re-reads the access when an `access_denied` row does.
 */
export function CanvasAccessRequestPane({ access, canvasId }: { access: CanvasAccess; canvasId: string }): React.JSX.Element {
  const { api } = useCollaborationSession();
  const queryClient = useQueryClient();
  const [asking, setAsking] = useState(false);
  const [message, setMessage] = useState('');
  // The dialog is there to type the message, so it opens on the field.
  const field = useRef<HTMLInputElement>(null);
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
  const declined = access.request?.state === 'denied' ? access.request : null;
  const close = (): void => {
    if (send.isPending) return;
    send.reset();
    setAsking(false);
  };
  return <>
    <PaneState
      action={<div className="canvas-access-request-actions">
        {pending === null && <Button className="button-primary" disabled={!api || send.isPending} onClick={() => setAsking(true)}>Request access</Button>}
        {pending && <p className="canvas-access-request-sent" role="status">
          Request sent · <RelativeTime format={formatRelative} value={pending.requestedAt} />
        </p>}
        {/* A server older than `decidedAt` sends only when it was asked. */}
        {declined && <p className="canvas-access-request-sent" role="status">
          Request declined · <RelativeTime format={formatRelative} value={declined.decidedAt ?? declined.requestedAt} />
        </p>}
      </div>}
      description={pending
        ? 'The people who manage it have been asked. It opens here once someone lets you in.'
        : declined
          ? 'Ask again if you still need it.'
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
      initialFocusRef={field}
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
          ref={field}
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
export function AccessDecisionActions({ canvasId, canvasTitle, label, userId }: {
  canvasId: string;
  /**
   * The Canvas asked for, where a list holds requests for several, so each
   * request's buttons have a name of their own ("Approve Maya Lin for Launch
   * plan") when one person asks for more than one. The Share panel is one
   * Canvas's and leaves it out.
   */
  canvasTitle?: string | undefined;
  /**
   * Who asked, for the buttons' accessible names ("Approve Maya Lin"); while
   * their name is not known yet the buttons are "Approve request" and
   * "Deny request", never a placeholder name.
   */
  label: string | undefined;
  userId: string;
}): React.JSX.Element {
  const { api } = useCollaborationSession();
  const queryClient = useQueryClient();
  const decide = useMutation({
    mutationFn: (decision: 'approve' | 'deny') => api!.decideCanvasAccess(canvasId, userId, decision),
    onSettled: () => queryClient.invalidateQueries({ queryKey: canvasDetailQueryKey(canvasId) }),
  });
  // Answered: both stay disabled until the push or the read replaces this
  // row, so a second press cannot meet the person's own answer as "settled".
  const held = !api || decide.isPending || decide.isSuccess;
  const who = `${label ?? 'request'}${canvasTitle ? ` for ${canvasTitle}` : ''}`;
  return <div className="access-decision-actions">
    <Button aria-label={`Deny ${who}`} disabled={held} onClick={() => decide.mutate('deny')}>Deny</Button>
    <Button aria-label={`Approve ${who}`} className="button-primary" disabled={held} onClick={() => decide.mutate('approve')}>Approve</Button>
    {decide.error && <ErrorNotice occurrence={decide.error} title="The request could not be answered">{canvasAccessDecisionRefusal(decide.error)}</ErrorNotice>}
  </div>;
}
