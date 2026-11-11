import { asUserId, type CanvasDetail, type CanvasVisibility } from '@rally/contracts';
import { CreateScopeInvitationsSchema } from '@rally/contracts/scope-grants';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { IconChevronRight } from '@tabler/icons-react';
import { useEffect, useId, useRef, useState } from 'react';

import { canvasDetailQueryKey, useCanvasNameSources } from '../lib/canvases';
import { CANVAS_VISIBILITY_OPTIONS as VISIBILITY_OPTIONS } from '../lib/canvas-sharing';
import { useCollaborationSession } from '../lib/collaboration-session';
import type { WorkspaceMember } from '../lib/types';
import { AccessDecisionActions } from './canvas-access-request';
import { Avatar, Badge, Button, ErrorNotice, Modal } from './primitives';
import { RelativeTime } from './relative-time';
import { useScopeInvitations } from './scope-sharing-panel';
import { SidebarSearch } from './sidebar-search';

const VISIBILITY_VALUES = ['creator', 'participants', 'workspace'] as const;

/**
 * What a choice lets in. A Canvas a Sidekick writes is also open to everyone
 * the Sidekick is shared with, whichever is chosen (`canvasAdmits`'s writer
 * audience), so its copy says so rather than "Nobody else".
 */
function visibilityDescription(value: CanvasVisibility, written: boolean): string {
  if (!written || value === 'workspace') return VISIBILITY_OPTIONS[value].description;
  return value === 'creator'
    ? 'And everyone the Sidekick that writes it is shared with.'
    : 'The people chosen below, guests among them, and everyone the Sidekick that writes it is shared with.';
}

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
  const visibilityDescriptionId = useId();
  const [visibility, setVisibility] = useState<CanvasVisibility>(canvas.visibility);
  const [chosen, setChosen] = useState<ReadonlySet<string>>(() => new Set(canvas.participantUserIds));
  const [search, setSearch] = useState('');
  const [guestsOpen, setGuestsOpen] = useState(false);
  const [emails, setEmails] = useState('');
  const [invalidEmails, setInvalidEmails] = useState<{ emails: string } | null>(null);
  // Someone approved from the Requests section (or anywhere) while this form
  // is open joins the list as the detail is read again; they join the choice
  // too, so Save does not take back the access just given. Any visibility the
  // server changes while the form is open replaces the form's, whoever
  // changed it; the case that forced this is an approval on a creator-only
  // Canvas, which the server moves to Specific people: left at "Only you",
  // Save would send `creator` and remove the person just let in.
  const seenParticipants = useRef(canvas.participantUserIds);
  const seenVisibility = useRef(canvas.visibility);
  useEffect(() => {
    const added = canvas.participantUserIds.filter((id) => !seenParticipants.current.includes(id));
    seenParticipants.current = canvas.participantUserIds;
    if (added.length > 0) setChosen((current) => new Set([...current, ...added]));
  }, [canvas.participantUserIds]);
  useEffect(() => {
    if (canvas.visibility === seenVisibility.current) return;
    seenVisibility.current = canvas.visibility;
    setVisibility(canvas.visibility);
  }, [canvas.visibility]);
  // The roster sends an access class for guests and can omit it for members.
  const isMember = (member: WorkspaceMember | undefined): boolean => member !== undefined && member.accessClass !== 'guest';
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
        userIds: visibility === 'creator' ? [] : [...chosen].filter((id) => visibility !== 'workspace' || !isMember(membersById.get(id))).map(asUserId),
      });
      queryClient.setQueryData(canvasDetailQueryKey(canvas.id), updated);
      if (recipients.length > 0) await invite.mutateAsync(recipients);
    },
    onSuccess: onDone,
  });
  const submit = (): void => {
    setInvalidEmails(null);
    // Only what the person can see is sent: addresses left under a closed
    // guest section, with its "invited when you save" note hidden, stay put.
    const typed = guestsOpen ? emails.split(/[\s,;]+/u).filter(Boolean) : [];
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
      <p className="canvas-share-visibility"><strong>{VISIBILITY_OPTIONS[canvas.visibility].label}</strong>{visibilityDescription(canvas.visibility, canvas.writerSidekickId !== null)}</p>
      <PeopleList ids={[canvas.createdByUserId, ...canvas.participantUserIds]} membersById={membersById} owner={canvas.createdByUserId} />
      <p className="canvas-share-note">Only {creator ? creator.name : 'its creator'} and the Organization’s administrators can change who can open it.</p>
    </div>;
  }
  const needle = search.trim().toLocaleLowerCase();
  // The viewer and the creator stay out of the recipient list in both modes.
  const candidates = (members ?? []).filter((member) => member.id !== canvas.createdByUserId
    && member.id !== session?.user.id
    && (needle === '' || `${member.name} ${member.email}`.toLocaleLowerCase().includes(needle)));

  const missingPeople = visibility === 'participants' && chosen.size === 0;
  const requests = canvas.pendingAccessRequests ?? [];
  return <div className="canvas-share">
    {requests.length > 0 && <section aria-label="Requests" className="canvas-share-requests">
      <h3 className="canvas-share-heading">Requests</h3>
      <div className="member-action-list" role="list">
        {requests.map((request) => <div className="member-action-row canvas-share-request" key={request.userId} role="listitem">
          {membersById.get(request.userId) && <Avatar member={membersById.get(request.userId)!} size="medium" />}
          <span>
            <strong>{request.name}</strong>
            <small>
              {request.message}
              <span className="canvas-share-request-time">{request.message ? ' · ' : null}<RelativeTime value={request.requestedAt} /></span>
            </small>
          </span>
          <AccessDecisionActions canvasId={canvas.id} label={request.name} userId={request.userId} />
        </div>)}
      </div>
    </section>}
    <fieldset className="canvas-share-audience">
      <legend className="sr-only">Who can open it</legend>
      <div className="canvas-share-options">
        {VISIBILITY_VALUES.map((value) => {
          const { icon: Icon, label } = VISIBILITY_OPTIONS[value];
          return <label className="action-tile canvas-share-option" key={value}>
            <input aria-describedby={`${visibilityDescriptionId}-${value}`} checked={visibility === value} className="sr-only"
              name="canvas-visibility" onChange={() => setVisibility(value)} type="radio" value={value} />
            <Icon aria-hidden="true" size={20} stroke={1.6} />
            <span>{value === 'creator' && canvas.createdByUserId === session?.user.id ? 'Only you' : label}</span>
          </label>;
        })}
      </div>
      <p className="canvas-share-audience-description">
        {VISIBILITY_VALUES.map((value) => <span hidden={visibility !== value} id={`${visibilityDescriptionId}-${value}`} key={value}>
          {visibilityDescription(value, canvas.writerSidekickId !== null)}
        </span>)}
      </p>
    </fieldset>
    {visibility !== 'creator' && <section aria-label="People" className="canvas-share-people">
      <SidebarSearch aria-label="Search people" mode="input" onChange={(event) => setSearch(event.target.value)} placeholder="Search people" value={search} />
      <div aria-label="People who can open it" className="member-action-list" role="group">
        {candidates.map((member) => {
          const organizationMember = visibility === 'workspace' && isMember(member);
          const checked = organizationMember ? member.status === undefined || member.status === 'active' : chosen.has(member.id);
          const status = organizationMember && !checked ? (member.status === 'invited' ? 'Invitation pending' : 'Suspended') : undefined;
          const statusId = status ? `${visibilityDescriptionId}-${member.id}-status` : undefined;
          return <label className="member-action-row" key={member.id}>
            <Avatar member={member} size="medium" />
            <span><strong>{member.name}</strong><small>{member.email}</small></span>
            {member.accessClass === 'guest' && <Badge className="role-badge">Guest</Badge>}
            {status && <Badge className="role-badge" id={statusId}>{status}</Badge>}
            <input aria-describedby={statusId} aria-label={member.name} checked={checked} className="choice-control" disabled={organizationMember} onChange={(event) => {
              const next = new Set(chosen);
              if (event.target.checked) next.add(member.id);
              else next.delete(member.id);
              setChosen(next);
            }} type="checkbox" />
          </label>;
        })}
      </div>
    </section>}
    {api && workspaceId && <details className="canvas-share-guests" onToggle={(event) => setGuestsOpen(event.currentTarget.open)}>
      <summary><IconChevronRight aria-hidden="true" className="canvas-share-guests-chevron" size={14} stroke={2} />Invite a guest by email</summary>
      <label className="form-field">Email addresses<textarea aria-label="Email addresses" disabled={save.isPending}
        onChange={(event) => setEmails(event.target.value)} placeholder="person@example.com" rows={2} value={emails} /></label>
      <p className="canvas-share-note">Separate email addresses with spaces, commas, or semicolons. They are invited when you save.</p>
    </details>}
    {invalidEmails && <ErrorNotice occurrence={invalidEmails}>Enter valid email addresses, separated by spaces, commas, or semicolons.</ErrorNotice>}
    {save.error && <ErrorNotice occurrence={save.error}>{save.error === invite.error ? 'Who can open it was saved, but the guests couldn’t be invited. Try again.' : save.error.message}</ErrorNotice>}
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
