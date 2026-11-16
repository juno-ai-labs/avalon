import type { MemberCardInput } from '@rally/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { LoaderCircle, UserPlus } from 'lucide-react';
import { useEffect, useRef } from 'react';

import { ApiError } from '../lib/api';
import { useOptionalCollaborationSession } from '../lib/collaboration-session';
import { useViewerIsWorkspaceAdmin } from '../lib/use-workspace';
import { Button, ErrorNotice } from './primitives';

/**
 * The card an agent's `offer_to_add_member` question shows: one press by an
 * Organization owner or administrator adds the address as a member at once
 * (`POST /workspace/members`), and `onAdded` answers the question for them so
 * the agent carries on. Someone already a member counts as added. Anyone else
 * sees the card and who can press it. `docs/workspace-member-roles.md`.
 */
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
        <strong>Add {who} to the Organization</strong>
        <p>{member.name ? `${member.email} becomes` : 'They become'} a member right away, with nothing to accept, and get an email to sign in.</p>
        {!admin && <small>Only an Organization owner or administrator can add members.</small>}
      </div>
      <div className="connector-connection-card-controls">
        <Button
          className="connector-connection-card-action button-primary"
          disabled={!api || !admin || add.isPending || add.isSuccess}
          onClick={() => add.mutate()}
          title={admin ? undefined : 'Only an Organization owner or administrator can add members.'}
        >
          {add.isPending && <LoaderCircle aria-hidden="true" className="spin" size={14} />}
          {add.isSuccess ? 'Added' : add.isPending ? 'Adding…' : 'Add as member'}
        </Button>
      </div>
    </div>
    {add.error && <ErrorNotice occurrence={add.error} title={`${who} could not be added`}>{add.error.message}</ErrorNotice>}
  </article>;
}
