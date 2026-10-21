import { ErrorNotice } from './primitives';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { IconSpy } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import type { SupportPerson, SupportWorkspace } from '@rally/contracts';
import { Check, LoaderCircle } from 'lucide-react';
import { useState } from 'react';
import { Avatar } from './primitives';

function errorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) return fallback;
  return error.message.replace(/^Error invoking remote method '[^']+': Error: /u, '');
}

/**
 * One Organization that granted Rally access, in a Rally staff member's
 * account menu (`docs/impersonation.md`). Its submenu lists the people there,
 * members then guests, read when it opens; choosing one opens a session as
 * them. The spy mark on the right says this row is somebody else's
 * Organization, entered as one of its people.
 */
export function SupportWorkspaceMenuRow({ workspace, current, loadPeople, onChoose }: {
  workspace: SupportWorkspace;
  /** The person this device is acting as here right now, if any. */
  current: string | null;
  loadPeople: (workspaceId: string) => Promise<SupportPerson[]>;
  /** Resolves once the session as `person` is the active one. */
  onChoose: (person: SupportPerson) => Promise<void>;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [choosing, setChoosing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const people = useQuery({
    queryKey: ['support-people', workspace.region, workspace.id],
    queryFn: () => loadPeople(workspace.id),
    enabled: open,
    staleTime: 0,
  });
  const members = people.data?.filter((person) => person.accessClass === 'member') ?? [];
  const guests = people.data?.filter((person) => person.accessClass === 'guest') ?? [];
  const choose = (event: Event, person: SupportPerson): void => {
    // Held open so the row's spinner and any refusal land where the person is
    // looking; the whole menu closes once the session is in front of them.
    event.preventDefault();
    if (choosing || person.id === current) return;
    setChoosing(person.id);
    setError(null);
    void onChoose(person).catch((failure: unknown) => {
      setError(errorMessage(failure, `Rally could not open ${workspace.name} as ${person.name}.`));
    }).finally(() => setChoosing(null));
  };
  const personItem = (person: SupportPerson) => (
    <DropdownMenu.Item
      aria-label={[person.name, person.accessClass === 'guest' ? 'Guest' : null, person.id === current ? 'Current' : null].filter(Boolean).join(', ')}
      className="menu-item support-person-item"
      key={person.id}
      onSelect={(event) => choose(event, person)}
    >
      <Avatar member={{ id: person.id, name: person.name, email: person.email, timezone: 'UTC', ...(person.avatarUrl ? { avatarUrl: person.avatarUrl } : {}) }} size="small" title={null} />
      <span className="workspace-menu-copy">
        <span>{person.name}</span>
        <small>{person.email}</small>
      </span>
      {choosing === person.id && <LoaderCircle aria-label="Opening" className="spin" size={14} />}
      {person.id === current && <Check aria-label="Current" size={14} />}
    </DropdownMenu.Item>
  );
  return (
    <DropdownMenu.Sub onOpenChange={setOpen} open={open}>
      <DropdownMenu.SubTrigger
        aria-label={`${workspace.name}, Rally access`}
        className="menu-item workspace-menu-item support-workspace-item"
      >
        <span aria-hidden="true" className="workspace-mark">{workspace.name.slice(0, 1).toLocaleUpperCase()}</span>
        <span className="workspace-menu-copy"><span>{workspace.name}</span></span>
        <IconSpy aria-hidden="true" className="support-workspace-mark" size={16} />
      </DropdownMenu.SubTrigger>
      <DropdownMenu.Portal>
        <DropdownMenu.SubContent alignOffset={-5} className="menu-content nested-menu-content support-people-menu" collisionPadding={8} sideOffset={3}>
          {people.isPending && <DropdownMenu.Label className="menu-label support-people-status">Loading people…</DropdownMenu.Label>}
          {people.isError && (
            <ErrorNotice>
              {errorMessage(people.error, 'Rally could not list the people here.')}
            </ErrorNotice>
          )}
          {people.data && people.data.length === 0 && (
            <DropdownMenu.Label className="menu-label support-people-status">Nobody is in this organization.</DropdownMenu.Label>
          )}
          {members.length > 0 && <DropdownMenu.Label className="menu-label workspace-menu-section">Members</DropdownMenu.Label>}
          {members.map(personItem)}
          {guests.length > 0 && <DropdownMenu.Label className="menu-label workspace-menu-section">Guests</DropdownMenu.Label>}
          {guests.map(personItem)}
          {error && <ErrorNotice>{error}</ErrorNotice>}
        </DropdownMenu.SubContent>
      </DropdownMenu.Portal>
    </DropdownMenu.Sub>
  );
}
