import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { CreateScopeInvitationsSchema } from '@rally/contracts/scope-grants';
import {
  IconArchive,
  IconChevronRight,
  IconCloudDownload,
  IconCornerDownRight,
  IconDots,
  IconHexagons,
  IconLink,
  IconPencil,
  IconPin,
  IconUserMinus,
  IconX,
  IconUserPlus,
  IconUsers,
  IconWorld,
} from '@tabler/icons-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { compareAlphabeticalTitle } from '../lib/alphabetical';
import type { SidebarPresentation, WorkspaceMember } from '../lib/types';
import { breakoutHasActivity, type BreakoutMark } from './breakout-marks';
import { Avatar } from './primitives';
import { ResourceIcon } from './resource-icon';
import { SidekickSection, type SidekickRow, type SidekickSectionFailure } from './sidekick-section';
import { keepSearchFocus, TitleMenuHeader, TitleMenuItem, TitleMenuLink, TitleMenuSearch, TitleMenuSeparator, useTitleMenuNav, type TitleMenuView } from './title-pill';
import { WorkstreamMark } from './workstream-glyph';

/** The id a Breakout being written is selected under before it exists. */
export const PENDING_SUBSTREAM_DRAFT_ID = 'new';

export interface ConversationRowTarget { substreamId: string; title: string }

/** What a Channel's or a Breakout's menu can do; an absent action is not offered. */
export interface ConversationRowActions {
  /** Whether the conversation is public to its Organization, and the switch that changes it. */
  isPublic?: boolean | undefined;
  onSetPublic?: ((next: boolean) => void) | undefined;
  publicDisabled?: boolean | undefined;
  onCopyLink?: ((target: ConversationRowTarget) => void) | undefined;
  onRename?: (target: ConversationRowTarget) => void;
  onArchive?: (target: ConversationRowTarget) => void;
}

/** How many Breakouts the Breakouts view lists before "Show N more". */
const BREAKOUT_PREVIEW_ROWS = 6;

/** How many people the People view suggests before a search narrows them. */
const PEOPLE_SUGGESTIONS = 5;

const PEOPLE_VIEW: TitleMenuView = { key: 'people', label: 'People' };
const SIDEKICKS_VIEW: TitleMenuView = { key: 'sidekicks', label: 'Sidekicks' };
const BREAKOUTS_VIEW: TitleMenuView = { key: 'breakouts', label: 'Breakouts' };
const MORE_VIEW: TitleMenuView = { key: 'more', label: 'More' };

/**
 * Adding people from inside the menu: everyone the reader could add, and the
 * add itself. Absent where the host cannot add people, which leaves the People
 * view as a list.
 */
export interface TitleMenuPeople {
  candidates: readonly WorkspaceMember[];
  /** Settles when the add does; the host names a failure in `error`. */
  onAdd: (member: WorkspaceMember) => Promise<void>;
  adding: boolean;
  error?: string | undefined;
  currentUserId?: string | undefined;
  /**
   * Taking someone out, the reader included. The host confirms before it
   * removes; absent where the host cannot remove people.
   */
  onRemove?: ((member: WorkspaceMember) => void) | undefined;
  /** Inviting by email address as a guest; absent where the host cannot invite. */
  invites?: TitleMenuInvites | undefined;
}

/**
 * Guest invitations from the People level's search: an address nobody in the
 * Organization has is invited to this conversation as a guest, and waits
 * among its people until they sign in with it.
 */
export interface TitleMenuInvites {
  /** Addresses invited and not yet signed in, lower case; undefined until loaded. */
  pending: readonly string[] | undefined;
  /** Loading them failed, and the way to try again. */
  loadFailed?: boolean | undefined;
  onRetryLoad?: (() => void) | undefined;
  /** Resolves once the addresses are invited; the host names a failure in `TitleMenuPeople.error`. */
  onInvite: (emails: string[]) => Promise<void>;
  /** Taking an invitation back before it is used; absent where the host cannot. */
  onRevoke?: ((email: string) => void) | undefined;
  /** The People level opened: the host loads pending invitations then, not on every open of the conversation. */
  onLoad?: (() => void) | undefined;
}

/** What may separate addresses typed into the People search. */
const ADDRESS_SEPARATORS = /[\s,;]+/u;
const EMAIL = CreateScopeInvitationsSchema.shape.emails.element;

/** One action on a person's row, behind a dots button. */
function RowAction({ disabled, icon, label, name, onSelect }: {
  disabled?: boolean | undefined; icon: ReactNode; label: string; name: string; onSelect: () => void;
}): React.JSX.Element {
  return <DropdownMenu.Root modal={false}>
    <DropdownMenu.Trigger aria-label={`${name} actions`} className="title-menu-person-actions">
      <IconDots aria-hidden="true" size={16} stroke={1.8} />
    </DropdownMenu.Trigger>
    <DropdownMenu.Portal>
      <DropdownMenu.Content align="end" className="menu-content" sideOffset={4}>
        <DropdownMenu.Item className="menu-item menu-item-danger" disabled={disabled} onSelect={onSelect}>
          {icon}{label}
        </DropdownMenu.Item>
      </DropdownMenu.Content>
    </DropdownMenu.Portal>
  </DropdownMenu.Root>;
}

/** A row of square actions under the menu's header, the most used things done to it. */
function ActionTiles({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="title-menu-tiles" role="group" aria-label="Actions">{children}</div>;
}

function ActionTile({ icon, label, onSelect, disabled }: {
  icon: ReactNode; label: string; onSelect: (event: Event) => void; disabled?: boolean | undefined;
}): React.JSX.Element {
  return <DropdownMenu.Item className="title-menu-tile" disabled={disabled} onSelect={onSelect}>
    {icon}<span>{label}</span>
  </DropdownMenu.Item>;
}

/** A row that opens a level of the menu in place: People, Sidekicks, Breakouts. */
function LevelRow({ icon, label, meta, view }: {
  icon: ReactNode; label: string; meta?: ReactNode; view: TitleMenuView;
}): React.JSX.Element {
  const nav = useTitleMenuNav();
  return <DropdownMenu.Item className="menu-item title-menu-level-row" data-title-menu-level={view.key} onSelect={(event) => { event.preventDefault(); nav.open(view); }}>
    {icon}
    <span className="title-menu-item-copy">{label}</span>
    {meta !== undefined && <span className="title-menu-level-meta">{meta}</span>}
    <IconChevronRight aria-hidden="true" className="title-menu-level-chevron" size={15} stroke={1.8} />
  </DropdownMenu.Item>;
}

/** Selecting a tile that leads to a level keeps the menu open and moves to it. */
function openLevel(nav: ReturnType<typeof useTitleMenuNav>, view: TitleMenuView) {
  return (event: Event): void => { event.preventDefault(); nav.open(view); };
}

/**
 * Who is in the conversation and who could be: a search that also takes email
 * addresses, the participants, invitations still waiting, and suggestions to
 * add. Enter adds what was typed and keeps the menu open for the next one.
 */
function PeopleView({ members, noun, people, presentUserIds }: {
  members: readonly WorkspaceMember[];
  noun: 'channel' | 'breakout';
  people?: TitleMenuPeople | undefined;
  presentUserIds: readonly string[];
}): React.JSX.Element {
  const [query, setQuery] = useState('');
  const [entryError, setEntryError] = useState<string | null>(null);
  // One submission at a time: adds run in order, so a later roster never lands before an earlier one.
  const submitting = useRef(false);
  const invites = people?.invites;
  const onLoad = useRef(invites?.onLoad);
  useEffect(() => { onLoad.current?.(); }, []);
  const needle = query.trim().toLocaleLowerCase();
  const present = new Set(presentUserIds);
  const inRoom = new Set(members.map((member) => member.id));
  const addable = (people?.candidates ?? []).filter((member) => !inRoom.has(member.id)
    && (member.status ?? 'active') === 'active'
    && (!needle || member.name.toLocaleLowerCase().includes(needle) || (member.email ?? '').toLocaleLowerCase().includes(needle)));
  const suggestions = needle ? addable : addable.slice(0, PEOPLE_SUGGESTIONS);
  const tokens = needle.split(ADDRESS_SEPARATORS).filter(Boolean);
  const typedEmails = tokens.length > 0 && tokens.every((token) => EMAIL.safeParse(token).success);
  const change = (value: string): void => { setQuery(value); setEntryError(null); };
  /** Adds and invites in order; what failed stays in the box to retry, unless more was typed meanwhile. */
  const run = async (submitted: string, adds: readonly WorkspaceMember[], strangers: string[]): Promise<void> => {
    if (!people) return;
    submitting.current = true;
    const failed: string[] = [];
    try {
      for (const member of adds) {
        await people.onAdd(member).catch(() => { failed.push(member.email ?? member.name); });
      }
      if (strangers.length > 0) await invites?.onInvite(strangers).catch(() => { failed.push(...strangers); });
    } finally {
      submitting.current = false;
    }
    setQuery((current) => current === submitted ? failed.join(', ') : current);
  };
  const submit = (): void => {
    if (!people || tokens.length === 0 || submitting.current) return;
    if (!typedEmails) {
      // A name narrowed to one person adds them, as clicking Add would.
      const only = suggestions.length === 1 ? suggestions[0] : undefined;
      if (only) void run(query, [only], []);
      else setEntryError('Enter email addresses separated by spaces, commas or semicolons.');
      return;
    }
    // Who is already invited decides who is invited again, so it has to be known first.
    if (invites && invites.pending === undefined) {
      setEntryError(invites.loadFailed ? 'Invitations couldn’t be loaded. Try again.' : 'Invitations are still loading. Try again in a moment.');
      return;
    }
    const byEmail = new Map(people.candidates.flatMap((member) => member.email ? [[member.email.toLocaleLowerCase(), member] as const] : []));
    const here = new Set([...members.flatMap((member) => member.email ? [member.email.toLocaleLowerCase()] : []), ...invites?.pending ?? []]);
    const adds: WorkspaceMember[] = [];
    const inactive: string[] = [];
    const strangers: string[] = [];
    for (const email of new Set(tokens)) {
      if (here.has(email)) continue;
      const member = byEmail.get(email);
      if (!member) strangers.push(email);
      else if ((member.status ?? 'active') === 'active') adds.push(member);
      else inactive.push(email);
    }
    if (inactive.length > 0) {
      setEntryError(`${inactive.join(', ')} ${inactive.length === 1 ? 'has' : 'have'} an organization account that isn’t active.`);
      return;
    }
    if (strangers.length > 0 && !invites) {
      setEntryError('Only people in the organization can be added here.');
      return;
    }
    void run(query, adds, strangers);
  };
  const error = entryError ?? people?.error;
  return <>
    {people && <TitleMenuSearch className="title-menu-people-search" label="Add someone by name or email" onChange={change} onEnter={submit} value={query} />}
    {error && <p className="title-menu-error" role="alert">{error}</p>}
    {invites?.loadFailed && <div className="title-menu-load-failed" role="alert">
      <span>Invitations waiting to sign in couldn’t be loaded.</span>
      {invites.onRetryLoad && <button className="title-menu-add" onClick={invites.onRetryLoad} type="button">Try again</button>}
    </div>}
    {!needle && members.map((member) => <div className="title-menu-person" key={member.id}>
      <Avatar member={member} size="medium" />
      <span className="title-menu-person-copy">
        <span className="title-menu-person-name">{member.name}{present.has(member.id) ? <span aria-label="viewing now" className="title-menu-person-present" role="img" /> : null}</span>
        <span className="title-menu-person-detail">{member.id === people?.currentUserId ? 'You' : member.email}</span>
      </span>
      <span className="title-menu-person-role">{member.role === 'admin' ? 'Admin' : member.accessClass === 'guest' ? 'Guest' : 'Member'}</span>
      {people?.onRemove && <RowAction
        disabled={members.length <= 1}
        icon={<IconUserMinus aria-hidden="true" size={16} stroke={1.8} />}
        label={member.id === people.currentUserId ? `Leave the ${noun}` : `Remove from ${noun}`}
        name={member.name}
        onSelect={() => people.onRemove?.(member)}
      />}
    </div>)}
    {!needle && invites?.pending?.map((email) => <div className="title-menu-person" key={email}>
      <Avatar member={{ id: email, name: email, email, timezone: 'UTC' }} size="medium" />
      <span className="title-menu-person-copy">
        <span className="title-menu-person-name">{email}</span>
        <span className="title-menu-person-detail">Joins when they sign in</span>
      </span>
      <span className="title-menu-person-role">Invited</span>
      {invites.onRevoke && <RowAction
        icon={<IconX aria-hidden="true" size={16} stroke={1.8} />}
        label="Cancel invite"
        name={email}
        onSelect={() => invites.onRevoke?.(email)}
      />}
    </div>)}
    {people && suggestions.length > 0 && <>
      <div className="title-menu-section-heading">{needle ? 'Add to this ' + noun : 'Suggested'}</div>
      {suggestions.map((member) => <div className="title-menu-person" key={member.id}>
        <Avatar member={member} size="medium" />
        <span className="title-menu-person-copy">
          <span className="title-menu-person-name">{member.name}</span>
          <span className="title-menu-person-detail">{member.email}</span>
        </span>
        <button
          aria-label={`Add ${member.name}`}
          className="title-menu-add"
          disabled={people.adding}
          onClick={() => { void people.onAdd(member).catch(() => undefined); }}
          type="button"
        >Add</button>
      </div>)}
    </>}
    {people && needle && suggestions.length === 0 && <p className="title-menu-empty">{typedEmails && invites
      ? `Press Enter to invite ${tokens.length === 1 ? 'them' : 'everyone'} as ${tokens.length === 1 ? 'a guest' : 'guests'}.`
      : 'Nobody else matches.'}</p>}
  </>;
}

function SidekicksView({ addSidekick, failure, items, onMenuOpen, onOpen, onRefresh }: {
  addSidekick?: ReactNode;
  failure?: SidekickSectionFailure | undefined;
  items?: SidekickRow[] | undefined;
  onMenuOpen?: () => void;
  onOpen?: (id: string) => void;
  onRefresh?: (() => void) | undefined;
}): React.JSX.Element {
  return <div className="title-menu-sidekicks">
    <SidekickSection failure={failure} items={items} layoutId="section:sidekicks" onMenuOpen={onMenuOpen} onOpen={onOpen} onRefresh={onRefresh} />
    {addSidekick}
  </div>;
}

function BreakoutsView({ breakouts, onOpenBreakout, openSubstreamId, renderAge }: {
  breakouts: readonly BreakoutMark[] | undefined;
  onOpenBreakout: (substreamId: string) => void;
  openSubstreamId: string | null;
  renderAge?: ((breakout: BreakoutMark) => ReactNode) | undefined;
}): React.JSX.Element {
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState(false);
  const ordered = useMemo(() => breakouts === undefined ? undefined : [...breakouts].sort((a, b) => (
    (b.lastActivityAt ?? b.createdAt ?? '').localeCompare(a.lastActivityAt ?? a.createdAt ?? '')
    || compareAlphabeticalTitle(a, b)
  )), [breakouts]);
  const needle = query.trim().toLocaleLowerCase();
  const matching = ordered?.filter((breakout) => !needle || breakout.title.toLocaleLowerCase().includes(needle));
  const shown = expanded || needle ? matching : matching?.slice(0, BREAKOUT_PREVIEW_ROWS);
  const hidden = (matching?.length ?? 0) - (shown?.length ?? 0);
  const firstRevealed = useRef<HTMLDivElement>(null);
  // "Show N more" unmounts as it is chosen; focus goes to the first row it revealed.
  useLayoutEffect(() => {
    if (expanded) firstRevealed.current?.focus({ preventScroll: true });
  }, [expanded]);
  return <>
    {(breakouts?.length ?? 0) > BREAKOUT_PREVIEW_ROWS && <TitleMenuSearch label="Find a breakout" onChange={setQuery} value={query} />}
    {breakouts === undefined
      ? <p className="title-menu-empty">Loading breakouts…</p>
      : breakouts.length === 0
        ? <p className="title-menu-empty">Start a breakout from any message.</p>
        : shown?.length === 0
          ? <p className="title-menu-empty">No breakout matches.</p>
          : shown?.map((breakout, index) => <DropdownMenu.Item
            aria-current={breakout.substreamId === openSubstreamId ? 'true' : undefined}
            className="menu-item title-menu-item title-menu-breakout"
            key={breakout.substreamId}
            onSelect={() => onOpenBreakout(breakout.substreamId)}
            ref={index === BREAKOUT_PREVIEW_ROWS ? firstRevealed : undefined}
            {...keepSearchFocus}
          >
            <IconCornerDownRight aria-hidden="true" size={14} stroke={1.8} />
            <span className="title-menu-item-copy">{breakout.title}</span>
            {renderAge && <span className="title-menu-item-age">{renderAge(breakout)}</span>}
            {breakoutHasActivity(breakout) && <span aria-label="New activity" className="title-menu-item-dot" role="img" />}
          </DropdownMenu.Item>)}
    {hidden > 0 && <DropdownMenu.Item className="title-menu-more" onSelect={(event) => { event.preventDefault(); setExpanded(true); }}>
      Show {hidden} more
    </DropdownMenu.Item>}
  </>;
}

/** A setting kept on the conversation, drawn as a switch the row toggles. */
function SwitchRow({ checked, disabled, icon, label, onChange }: {
  checked: boolean; disabled?: boolean | undefined; icon: ReactNode; label: string; onChange: (next: boolean) => void;
}): React.JSX.Element {
  return <DropdownMenu.CheckboxItem
    checked={checked}
    className="menu-item title-menu-switch-row"
    disabled={disabled}
    onCheckedChange={onChange}
    onSelect={(event) => event.preventDefault()}
  >
    {icon}
    <span className="title-menu-item-copy">{label}</span>
    <span aria-hidden="true" className="title-menu-switch" data-checked={checked ? '' : undefined} />
  </DropdownMenu.CheckboxItem>;
}

/** The conversation's Organization audience, as a switch; nothing where it cannot change. */
function PublicSwitch({ actions }: { actions: ConversationRowActions | undefined }): React.JSX.Element | null {
  const onSetPublic = actions?.onSetPublic;
  if (!onSetPublic) return null;
  return <SwitchRow
    checked={actions.isPublic ?? false}
    disabled={actions.publicDisabled}
    icon={<IconWorld aria-hidden="true" size={16} stroke={1.8} />}
    label="Public to organization"
    onChange={onSetPublic}
  />;
}

function sidekickMeta(sidekicks: SidekickRow[] | undefined): string | undefined {
  if (sidekicks === undefined) return undefined;
  return sidekicks.length === 0 ? 'None yet' : `${sidekicks.length}`;
}

function peopleMeta(count: number, scope: 'personal' | 'workspace' | undefined, pending: boolean): string | undefined {
  if (pending) return undefined;
  return scope ? `${count} · ${scope === 'workspace' ? 'Public' : 'Private'}` : `${count}`;
}

/**
 * The Channel's title-pill menu. Its root is the things most often done to
 * it as tiles, and one row each for its people,
 * Sidekicks and Breakouts; each row and **More** opens a level in place,
 * which the pill names as a breadcrumb. It replaces the Channel sidebar, so
 * between its levels it carries all of that sidebar's sections.
 */
export function ChannelMenu({
  actions,
  addSidekick,
  appearance,
  breakouts,
  extraActions,
  onImportUpdates,
  onOpenArtifact,
  onOpenBreakout,
  onOpenResource,
  onOpenSidekick,
  onRefreshSidekicks,
  onSidekickMenuOpen,
  openSubstreamId,
  participantsPending = false,
  people,
  pinned,
  presentUserIds,
  renderAge,
  sidekickFailure,
  sidekicks,
  workstream,
}: {
  actions?: ConversationRowActions | undefined;
  addSidekick?: ReactNode;
  /** The Channel's icon-and-colour choice, as a submenu, when the viewer may change it. */
  appearance?: ReactNode;
  breakouts: readonly BreakoutMark[] | undefined;
  /** Host-only items placed in **More** after the shared ones, e.g. a debug copy. */
  extraActions?: ReactNode;
  onImportUpdates?: (() => void) | undefined;
  onOpenArtifact?: ((id: string, returnFocus: HTMLElement) => void) | undefined;
  onOpenBreakout: (substreamId: string) => void;
  /** Opens a resource that is not an artifact; absent where the host has no view for one. */
  onOpenResource?: ((id: string, returnFocus: HTMLElement) => void) | undefined;
  onOpenSidekick?: (id: string) => void;
  onRefreshSidekicks?: (() => void) | undefined;
  onSidekickMenuOpen?: () => void;
  openSubstreamId: string | null;
  participantsPending?: boolean;
  people?: TitleMenuPeople | undefined;
  /** Whether the Channel is pinned in the sidebar, and the switch; absent where pinning is not offered. */
  pinned?: { on: boolean; onChange: (next: boolean) => void } | undefined;
  presentUserIds: readonly string[];
  renderAge?: (breakout: BreakoutMark) => ReactNode;
  sidekickFailure?: SidekickSectionFailure | undefined;
  sidekicks?: SidekickRow[] | undefined;
  workstream: SidebarPresentation;
}): React.JSX.Element {
  const nav = useTitleMenuNav();
  const target = { substreamId: '0', title: workstream.title };
  const artifacts = workstream.resources.filter((resource) => resource.direction === 'artifact');
  const otherResources = workstream.resources.filter((resource) => resource.direction !== 'artifact');
  if (nav.view?.key === 'people') {
    return <PeopleView members={workstream.participants} noun="channel" people={people} presentUserIds={presentUserIds} />;
  }
  if (nav.view?.key === 'sidekicks') {
    return <SidekicksView addSidekick={addSidekick} failure={sidekickFailure} items={sidekicks} onMenuOpen={onSidekickMenuOpen} onOpen={onOpenSidekick} onRefresh={onRefreshSidekicks} />;
  }
  if (nav.view?.key === 'breakouts') {
    return <BreakoutsView breakouts={breakouts} onOpenBreakout={onOpenBreakout} openSubstreamId={openSubstreamId} renderAge={renderAge} />;
  }
  if (nav.view?.key === 'more') {
    return <>
      {appearance}
      {pinned && <SwitchRow checked={pinned.on} icon={<IconPin aria-hidden="true" size={16} stroke={1.8} />} label="Pinned in my sidebar" onChange={pinned.onChange} />}
      <PublicSwitch actions={actions} />
      {onImportUpdates && <TitleMenuItem icon={<IconCloudDownload aria-hidden="true" size={16} stroke={1.8} />} onSelect={onImportUpdates}>Import updates</TitleMenuItem>}
      {extraActions}
      <ResourceList label="Artifacts" onOpen={onOpenArtifact} resources={artifacts} />
      {onOpenResource && <ResourceList label="Resources" onOpen={onOpenResource} resources={otherResources} />}
      {actions?.onArchive && <>
        <TitleMenuSeparator />
        <TitleMenuItem danger icon={<IconArchive aria-hidden="true" size={16} stroke={1.8} />} onSelect={() => actions.onArchive?.(target)}>Archive channel</TitleMenuItem>
      </>}
    </>;
  }
  return <>
    <ActionTiles>
      <ActionTile disabled={!people} icon={<IconUserPlus aria-hidden="true" size={20} stroke={1.6} />} label="Add people" onSelect={openLevel(nav, PEOPLE_VIEW)} />
      {actions?.onRename && <ActionTile icon={<IconPencil aria-hidden="true" size={20} stroke={1.6} />} label="Rename" onSelect={() => actions.onRename?.(target)} />}
      {actions?.onCopyLink && <ActionTile icon={<IconLink aria-hidden="true" size={20} stroke={1.6} />} label="Copy link" onSelect={() => actions.onCopyLink?.(target)} />}
      <ActionTile icon={<IconDots aria-hidden="true" size={20} stroke={1.6} />} label="More" onSelect={openLevel(nav, MORE_VIEW)} />
    </ActionTiles>
    <LevelRow icon={<IconUsers aria-hidden="true" size={17} stroke={1.7} />} label="People" meta={peopleMeta(workstream.participants.length, workstream.scope, participantsPending)} view={PEOPLE_VIEW} />
    <LevelRow icon={<IconHexagons aria-hidden="true" size={17} stroke={1.7} />} label="Sidekicks" meta={sidekickMeta(sidekicks)} view={SIDEKICKS_VIEW} />
    <LevelRow icon={<IconCornerDownRight aria-hidden="true" size={17} stroke={1.7} />} label="Breakouts" meta={breakouts?.length} view={BREAKOUTS_VIEW} />
  </>;
}

/**
 * The Breakout's title-pill menu: which Channel it belongs to and the message
 * it started from, its most used actions as tiles, and rows for its people and
 * Sidekicks, each opening a level in place.
 */
export function BreakoutMenu({
  actions,
  addSidekick,
  appearance,
  breakout,
  channel,
  onOpenSidekick,
  onRefreshSidekicks,
  onShowInChannel,
  onSidekickMenuOpen,
  origin,
  participants,
  participantsPending = false,
  people,
  presentUserIds,
  scope,
  sidekickFailure,
  sidekicks,
}: {
  actions?: ConversationRowActions | undefined;
  addSidekick?: ReactNode;
  /** The Breakout's icon-and-colour choice, as a submenu, when the viewer may change it. */
  appearance?: ReactNode;
  onOpenSidekick?: (id: string) => void;
  onRefreshSidekicks?: (() => void) | undefined;
  onSidekickMenuOpen?: () => void;
  sidekickFailure?: SidekickSectionFailure | undefined;
  sidekicks?: SidekickRow[] | undefined;
  breakout: ConversationRowTarget;
  channel: { id: string; title: string; appearance?: SidebarPresentation['appearance'] };
  onShowInChannel?: (() => void) | undefined;
  origin?: { byline: ReactNode; text: string } | undefined;
  participants: readonly WorkspaceMember[];
  participantsPending?: boolean;
  people?: TitleMenuPeople | undefined;
  presentUserIds: readonly string[];
  scope?: 'personal' | 'workspace' | undefined;
}): React.JSX.Element {
  const nav = useTitleMenuNav();
  if (nav.view?.key === 'people') {
    return <PeopleView members={participants} noun="breakout" people={people} presentUserIds={presentUserIds} />;
  }
  if (nav.view?.key === 'sidekicks') {
    return <SidekicksView addSidekick={addSidekick} failure={sidekickFailure} items={sidekicks} onMenuOpen={onSidekickMenuOpen} onOpen={onOpenSidekick} onRefresh={onRefreshSidekicks} />;
  }
  if (nav.view?.key === 'more') {
    return <>
      {appearance}
      <PublicSwitch actions={actions} />
      {actions?.onArchive && <>
        {(appearance || actions.onSetPublic) && <TitleMenuSeparator />}
        <TitleMenuItem danger icon={<IconArchive aria-hidden="true" size={16} stroke={1.8} />} onSelect={() => actions.onArchive?.(breakout)}>Archive breakout</TitleMenuItem>
      </>}
    </>;
  }
  return <>
    <TitleMenuHeader
      action={onShowInChannel && <TitleMenuLink onSelect={onShowInChannel}>Show in channel</TitleMenuLink>}
      eyebrow="Breakout of"
      icon={<WorkstreamMark appearance={channel.appearance} id={channel.id} size={20} />}
      title={channel.title}
    />
    {origin && <div className="title-menu-origin">
      <span className="title-menu-origin-byline">{origin.byline}</span>
      <span className="title-menu-origin-text">{origin.text}</span>
    </div>}
    <ActionTiles>
      <ActionTile disabled={!people} icon={<IconUserPlus aria-hidden="true" size={20} stroke={1.6} />} label="Add people" onSelect={openLevel(nav, PEOPLE_VIEW)} />
      {actions?.onRename && <ActionTile icon={<IconPencil aria-hidden="true" size={20} stroke={1.6} />} label="Rename" onSelect={() => actions.onRename?.(breakout)} />}
      {actions?.onCopyLink && <ActionTile icon={<IconLink aria-hidden="true" size={20} stroke={1.6} />} label="Copy link" onSelect={() => actions.onCopyLink?.(breakout)} />}
      {(appearance || actions?.onSetPublic || actions?.onArchive) && <ActionTile icon={<IconDots aria-hidden="true" size={20} stroke={1.6} />} label="More" onSelect={openLevel(nav, MORE_VIEW)} />}
    </ActionTiles>
    <LevelRow icon={<IconUsers aria-hidden="true" size={17} stroke={1.7} />} label="People" meta={peopleMeta(participants.length, scope, participantsPending)} view={PEOPLE_VIEW} />
    <LevelRow icon={<IconHexagons aria-hidden="true" size={17} stroke={1.7} />} label="Sidekicks" meta={sidekickMeta(sidekicks)} view={SIDEKICKS_VIEW} />
  </>;
}

/** A headed list of a Channel's resources in **More**; nothing when there are none. */
function ResourceList({ label, onOpen, resources }: {
  label: string;
  onOpen: ((id: string, returnFocus: HTMLElement) => void) | undefined;
  resources: SidebarPresentation['resources'];
}): React.JSX.Element | null {
  if (resources.length === 0) return null;
  return <>
    <div className="title-menu-section-heading">{label}</div>
    {resources.map((resource) => <DropdownMenu.Item
      className="menu-item title-menu-item"
      disabled={!onOpen}
      key={resource.id}
      onSelect={(event) => onOpen?.(resource.id, event.currentTarget as HTMLElement)}
    >
      <ResourceIcon resource={resource} />
      <span className="title-menu-item-copy">{resource.title}</span>
    </DropdownMenu.Item>)}
  </>;
}
