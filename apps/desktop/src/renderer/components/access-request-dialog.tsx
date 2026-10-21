import type { ConversationAccessRequestItem } from '@rally/contracts';
import { IconCancel, IconCheck } from '@tabler/icons-react';
import { useRef } from 'react';

import { useAccessRequestList, useDecideAccessRequest, type AccessRequestDecisionApi } from '../lib/access-requests';
import { Button, ErrorNotice, Modal } from './primitives';
import { WorkstreamGlyph } from './workstream-glyph';

/**
 * The decision a menu bar request row opens in the main window: who asked
 * for what, with Approve and Decline. The menu cannot hold buttons, so this is
 * the menu bar's version of the attention menu's two icon buttons.
 *
 * Reads the request from the list the workspace socket holds. A request no
 * longer in it was answered elsewhere (the email, the attention menu, another
 * device), and the dialog says so rather than offering buttons that would
 * only be told it is settled.
 */
export function AccessRequestDialog({ api, workspaceId, requestId, onClose }: {
  api: AccessRequestDecisionApi | null;
  workspaceId: string;
  requestId: string | null;
  onClose: () => void;
}): React.JSX.Element {
  // A menu bar click can open a fresh window before its socket has sent the list.
  const { requests, loaded } = useAccessRequestList(workspaceId);
  const decide = useDecideAccessRequest(api, workspaceId);
  const listed = requests.find((item) => item.id === requestId) ?? null;
  // Answering drops the request from the list at once; the dialog keeps
  // showing it while that answer is in flight or was refused, rather than
  // flashing "already answered" over its own pending decision.
  const held = useRef<ConversationAccessRequestItem | null>(null);
  if (listed) held.current = listed;
  else if (held.current?.id !== requestId) held.current = null;
  const request = listed ?? (decide.isPending || decide.isError ? held.current : null);
  const answer = (decision: 'approve' | 'decline'): void => {
    if (!request) return;
    decide.mutate({ id: request.id, decision }, { onSuccess: onClose });
  };
  return (
    <Modal
      description={request
        ? `${request.requesterName} asked to join this ${request.kind}.`
        : loaded ? 'This request was already answered.' : 'Loading the request…'}
      footer={request ? (
        <>
          <Button disabled={decide.isPending} onClick={() => answer('decline')}>
            <IconCancel aria-hidden="true" size={15} stroke={1.9} /> Decline
          </Button>
          <Button className="button-primary" disabled={decide.isPending} onClick={() => answer('approve')}>
            <IconCheck aria-hidden="true" size={15} stroke={1.9} /> Approve
          </Button>
        </>
      ) : <Button onClick={onClose}>Close</Button>}
      onOpenChange={(open) => { if (!open) onClose(); }}
      open={requestId !== null}
      title="Access request"
    >
      {request && (
        <div className="access-request-dialog-subject">
          <WorkstreamGlyph appearance={request.appearance ?? undefined} id={request.markId} size={32} />
          <span className="access-request-dialog-title">{request.title}</span>
        </div>
      )}
      {decide.isError && <ErrorNotice occurrence={decide.error}>That didn’t go through. Try again.</ErrorNotice>}
    </Modal>
  );
}
