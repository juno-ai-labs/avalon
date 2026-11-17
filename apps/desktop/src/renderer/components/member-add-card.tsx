import type { MemberCardInput } from '@rally/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { LoaderCircle, UserPlus } from 'lucide-react';
import { useEffect, useRef } from 'react';

import { ApiError } from '../lib/api';
import { useOptionalCollaborationSession } from '../lib/collaboration-session';
import { useViewerIsWorkspaceAdmin } from '../lib/use-workspace';
import { Button, ErrorNotice } from './primitives';

/** `offer_to_add_member`'s card: an admin's press adds them, and `onAdded` answers the question. */
export function MemberAddCard({ member, onAdded }: { member: MemberCardInput; onAdded: () => void }): React.JSX.Element {
  const collaboration = useOptionalCollaborationSession();
  const api = collaboration?.api ?? null;
  const admin = useViewerIsWorkspaceAdmin(collaboration ?? null);
  const queryClient = useQueryClient();
  const add = useMutation({
    mutationFn: async () => {
      try { await api!.addWorkspaceMember(member.email, 'member'); }
      catch (error) {
        // Already a member is what the press was for.
        if (!(error instanceof ApiError && error.code === 'already_workspace_member')) throw error;
      }
    },
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ['workspace-members'] }); },
  });
  // Answer once per success, from an effect so a re-render never answers twice.
  const answered = useRef(false);
  useEffect(() => {
    if (add.isSuccess && !answered.current) { answered.current = true; onAdded(); }
  }, [add.isSuccess, onAdded]);
  const who = member.name ?? member.email;
  return <article aria-label={`Add ${who} as a member`} className="connector-connection-card member-add-card">
    <div className="connector-connection-card-header">
      <span aria-hidden="true" className="provider-icon"><UserPlus size={22} /></span>
      <div className="connector-connection-card-body">
        {/* The question above it already asks "Add Nancy as a member?": the card only names who. */}
        <strong>{who}</strong>
        {member.name && <p>{member.email}</p>}
        {!admin && <small>Only admins can add members.</small>}
      </div>
      <div className="connector-connection-card-controls">
        <Button
          className="connector-connection-card-action button-primary"
          disabled={!api || !admin || add.isPending || add.isSuccess}
          onClick={() => add.mutate()}
          title={admin ? undefined : 'Only admins can add members.'}
        >
          {add.isPending && <LoaderCircle aria-hidden="true" className="spin" size={14} />}
          {add.isSuccess ? 'Added' : add.isPending ? 'Adding…' : 'Add'}
        </Button>
      </div>
    </div>
    {add.error && <ErrorNotice occurrence={add.error} title={`${who} could not be added`}>{add.error.message}</ErrorNotice>}
  </article>;
}
