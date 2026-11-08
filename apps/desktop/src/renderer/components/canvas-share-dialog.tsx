import { asUserId, type CanvasDetail, type CanvasVisibility } from '@rally/contracts';
import { CreateScopeInvitationsSchema } from '@rally/contracts/scope-grants';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { IconChevronRight } from '@tabler/icons-react';
import { useState } from 'react';

import { canvasDetailQueryKey, useCanvasNameSources } from '../lib/canvases';
import { useCollaborationSession } from '../lib/collaboration-session';
import type { WorkspaceMember } from '../lib/types';
import { Avatar, Badge, Button, ErrorNotice, Modal } from './primitives';
import { useScopeInvitations } from './scope-sharing-panel';
import { SidebarSearch } from './sidebar-search';

const VISIBILITY_COPY: Record<CanvasVisibility, { label: string; description: string }> = {
  creator: { label: 'Only the creator', description: 'Nobody else can open it.' },
  participants: { label: 'Specific people', description: 'The people chosen below, guests among them.' },
  workspace: { label: 'Everyone in the Organization', description: 'Every member can open it, and any guests you add.' },
};

/**
 * Who can open a Canvas (`docs/canvases.md#who-can-open-a-canvas`). Its
 * creator, the Organization's owners and administrators, and a Sidekick's
 * managers for a Canvas it writes change it (`canManage` on the detail); anyone
 * else sees the same audience read-only. A guest is invited by email through
 * the share every conversation uses, with the Canvas as its target.
 */
export function CanvasShareDialog({ canvas, onOpenChange, open }: {
  canvas: CanvasDetail;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}): React.JSX.Element {
  return <Modal description={canvas.canManage ? 'Choose who can open this Canvas.' : 'Who can open this Canvas.'} onOpenChange={onOpenChange} open={open} title="Share Canvas">
    {open ? <CanvasShareForm canvas={canvas} onDone={() => onOpenChange(false)} /> : null}
  </Modal>;
}

function CanvasShareForm({ canvas, onDone }: { canvas: CanvasDetail; onDone: () => void }): React.JSX.Element {
  const { api, session } = useCollaborationSession();
  const queryClient = useQueryClient();
  const { members, membersById } = useCanvasNameSources(api);
  const [visibility, setVisibility] = useState<CanvasVisibility>(canvas.visibility);
  const [chosen, setChosen] = useState<ReadonlySet<string>>(() => new Set(canvas.participantUserIds));
  const [search, setSearch] = useState('');
  const [guestsOpen, setGuestsOpen] = useState(false);
  const [emails, setEmails] = useState('');
  const [invalidEmails, setInvalidEmails] = useState<{ emails: string } | null>(null);
  const isMember = (id: string): boolean => membersById.get(id)?.accessClass === 'member';
  const workspaceId = session?.workspace?.id;
  // The guest invite is part of this form: Save sends it, so the dialog has
  // one primary action. A Canvas is shared whole (`docs/canvases.md#guests`).
  const { invite } = useScopeInvitations({ api: api!, workspaceId: workspaceId ?? '', parentId: canvas.id, substreamId: '0',
    target: 'workstream', listsPending: false, enabled: false });
  const save = useMutation({
    mutationFn: async (recipients: string[]) => {
      const updated = await api!.setCanvasAudience(canvas.id, {
        visibility,
        // Everyone in the Organization already includes its members, so only
        // the guests chosen are sent with it.
        userIds: visibility === 'creator' ? [] : [...chosen].filter((id) => visibility !== 'workspace' || !isMember(id)).map(asUserId),
      });
      queryClient.setQueryData(canvasDetailQueryKey(canvas.id), updated);
      if (recipients.length > 0) await invite.mutateAsync(recipients);
    },
    onSuccess: onDone,
  });
  const submit = (): void => {
    setInvalidEmails(null);
    const typed = emails.split(/[\s,;]+/u).filter(Boolean);
    let recipients: string[] = [];
    if (typed.length > 0) {
      const parsed = CreateScopeInvitationsSchema.shape.emails.safeParse(typed);
      if (!parsed.success) { setInvalidEmails({ emails }); return; }
      recipients = [...new Set(parsed.data)].sort();
    }
    save.mutate(recipients);
  };
  const creator = membersById.get(canvas.createdByUserId);
  if (!canvas.canManage) {
    return <div className="canvas-share">
      <p className="canvas-share-visibility"><strong>{VISIBILITY_COPY[canvas.visibility].label}</strong>{VISIBILITY_COPY[canvas.visibility].description}</p>
      <PeopleList ids={[canvas.createdByUserId, ...canvas.participantUserIds]} membersById={membersById} owner={canvas.createdByUserId} />
      <p className="canvas-share-note">Only {creator ? creator.name : 'its creator'} and the Organization’s administrators can change who can open it.</p>
    </div>;
  }
  const needle = search.trim().toLocaleLowerCase();
  // With the whole Organization in, only guests are left to pick, so the
  // search shows once there is a guest to find or the person opens the guest
  // section; an empty search over nothing is what it replaced.
  const hasGuests = (members ?? []).some((member) => member.accessClass === 'guest' && member.id !== session?.user.id);
  const showPeople = visibility === 'participants' || (visibility === 'workspace' && (hasGuests || guestsOpen));
  // Nobody picks themselves or the creator, who can always open it; with the
  // whole Organization in, only guests are left to choose ("the guests chosen
  // below").
  const candidates = (members ?? []).filter((member) => member.id !== canvas.createdByUserId
    && member.id !== session?.user.id
    && (visibility !== 'workspace' || member.accessClass === 'guest')
    && (needle === '' || `${member.name} ${member.email}`.toLocaleLowerCase().includes(needle)));

  const missingPeople = visibility === 'participants' && chosen.size === 0;
  return <div className="canvas-share">
    <fieldset className="canvas-share-options">
      <legend className="sr-only">Who can open it</legend>
      {(['creator', 'participants', 'workspace'] as const).map((value) => <label className="canvas-share-option" key={value}>
        <input checked={visibility === value} className="choice-control" name="canvas-visibility" onChange={() => setVisibility(value)} type="radio" value={value} />
        <span><strong>{value === 'creator' && canvas.createdByUserId === session?.user.id ? 'Only you' : VISIBILITY_COPY[value].label}</strong><small>{VISIBILITY_COPY[value].description}</small></span>
      </label>)}
    </fieldset>
    {showPeople && <section aria-label="People" className="canvas-share-people">
      <SidebarSearch aria-label="Search people" mode="input" onChange={(event) => setSearch(event.target.value)} placeholder="Search people" value={search} />
      <div aria-label="People who can open it" className="member-action-list" role="group">
        {candidates.map((member) => <label className="member-action-row" key={member.id}>
          <Avatar member={member} size="medium" />
          <span><strong>{member.name}</strong><small>{member.email}</small></span>
          {member.accessClass === 'guest' && <Badge className="role-badge">Guest</Badge>}
          <input aria-label={member.name} checked={chosen.has(member.id)} className="choice-control" onChange={(event) => {
            const next = new Set(chosen);
            if (event.target.checked) next.add(member.id);
            else next.delete(member.id);
            setChosen(next);
          }} type="checkbox" />
        </label>)}
      </div>
    </section>}
    {api && workspaceId && <details className="canvas-share-guests" onToggle={(event) => setGuestsOpen(event.currentTarget.open)}>
      <summary><IconChevronRight aria-hidden="true" className="canvas-share-guests-chevron" size={14} stroke={2} />Invite a guest by email</summary>
      <label className="form-field">Email addresses<textarea aria-label="Email addresses" disabled={save.isPending}
        onChange={(event) => setEmails(event.target.value)} placeholder="person@example.com" rows={2} value={emails} /></label>
      <p className="canvas-share-note">Separate email addresses with spaces, commas, or semicolons. They are invited when you save.</p>
    </details>}
    {invalidEmails && <ErrorNotice occurrence={invalidEmails}>Enter valid email addresses, separated by spaces, commas, or semicolons.</ErrorNotice>}
    {save.error && <ErrorNotice occurrence={save.error}>{invite.isError ? 'Who can open it was saved, but the guests couldn’t be invited. Try again.' : save.error.message}</ErrorNotice>}
    {missingPeople && <p className="canvas-share-note">Choose at least one person.</p>}
    {/* The dialog's one set of actions, at its foot, below the guest invite. */}
    <div className="canvas-share-actions">
      <Button onClick={onDone}>Cancel</Button>
      <Button className="button-primary" disabled={save.isPending || missingPeople || !api} onClick={submit}>{save.isPending ? 'Saving…' : 'Save'}</Button>
    </div>
  </div>;
}

function PeopleList({ ids, membersById, owner }: {
  ids: readonly string[];
  membersById: ReadonlyMap<string, WorkspaceMember>;
  owner: string;
}): React.JSX.Element {
  return <div aria-label="People who can open it" className="member-action-list" role="group">
    {ids.map((id) => {
      const member = membersById.get(id);
      return <div className="member-action-row" key={id}>
        {member && <Avatar member={member} size="medium" />}
        <span><strong>{member?.name ?? 'Someone'}</strong>{member?.email && <small>{member.email}</small>}</span>
        {id === owner ? <Badge className="role-badge">Creator</Badge> : member?.accessClass === 'guest' ? <Badge className="role-badge">Guest</Badge> : null}
      </div>;
    })}
  </div>;
}
