import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import {
  IconArchive,
  IconChevronRight,
  IconCloudDownload,
  IconCornerDownRight,
  IconDots,
  IconLink,
  IconLock,
  IconPencil,
  IconPin,
  IconRobot,
  IconSearch,
  IconShare2,
  IconUserPlus,
  IconUsers,
  IconWorld,
} from '@tabler/icons-react';
import { useMemo, useState, type ReactNode } from 'react';

import { compareAlphabeticalTitle } from '../lib/alphabetical';
import type { SidebarPresentation, WorkspaceMember } from '../lib/types';
import { breakoutHasActivity, type BreakoutMark } from './breakout-marks';
import { Avatar } from './primitives';
import { ResourceIcon } from './resource-icon';
import { SidekickSection, type SidekickRow, type SidekickSectionFailure } from './sidekick-section';
import { TitleMenuHeader, TitleMenuItem, TitleMenuLink, TitleMenuSeparator, useTitleMenuNav, type TitleMenuView } from './title-pill';
import { WorkstreamMark } from './workstream-glyph';

/** The id a Breakout being written is selected under before it exists. */
export const PENDING_SUBSTREAM_DRAFT_ID = 'new';

export interface ConversationRowTarget { substreamId: string; title: string }

/** What a Channel's or a Breakout's menu can do; an absent action is not offered. */
export interface ConversationRowActions {
  onMakePublic?: (() => void) | undefined;
  publicDisabled?: boolean | undefined;
  onCopyLink?: ((target: ConversationRowTarget) => void) | undefined;
  onRename?: (target: ConversationRowTarget) => void;
  onShare?: (target: ConversationRowTarget) => void;
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
  onAdd: (member: WorkspaceMember) => void;
  adding: boolean;
  error?: string | undefined;
  currentUserId?: string | undefined;
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
  return <DropdownMenu.Item className="menu-item title-menu-level-row" onSelect={(event) => { event.preventDefault(); nav.open(view); }}>
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

function scopeCopy(scope: 'personal' | 'workspace' | undefined, noun: 'channel' | 'breakout'): { title: string; detail: string; icon: ReactNode } {
  return scope === 'workspace'
    ? { title: 'Public to organization', detail: `Anyone in the organization can open this ${noun}`, icon: <IconWorld aria-hidden="true" size={18} stroke={1.7} /> }
    : { title: 'Private', detail: `Only people added here can read this ${noun}`, icon: <IconLock aria-hidden="true" size={18} stroke={1.7} /> };
}

/**
 * Who is in the conversation, who could be, and who can see it: the scope with
 * its way to change, a search, the participants, and suggestions to add.
 */
function PeopleView({ manage, members, noun, people, presentUserIds, scope }: {
  manage?: (() => void) | undefined;
  members: readonly WorkspaceMember[];
  noun: 'channel' | 'breakout';
  people?: TitleMenuPeople | undefined;
  presentUserIds: readonly string[];
  scope: 'personal' | 'workspace' | undefined;
}): React.JSX.Element {
  const [query, setQuery] = useState('');
  const needle = query.trim().toLocaleLowerCase();
  const present = new Set(presentUserIds);
  const inRoom = new Set(members.map((member) => member.id));
  const addable = (people?.candidates ?? []).filter((member) => !inRoom.has(member.id)
    && (member.status ?? 'active') === 'active'
    && (!needle || member.name.toLocaleLowerCase().includes(needle) || (member.email ?? '').toLocaleLowerCase().includes(needle)));
  const suggestions = needle ? addable : addable.slice(0, PEOPLE_SUGGESTIONS);
  const copy = scopeCopy(scope, noun);
  return <>
    <div className="title-menu-scope">
      {copy.icon}
      <span className="title-menu-scope-copy">
        <span className="title-menu-scope-title">{copy.title}</span>
        <span className="title-menu-scope-detail">{copy.detail}</span>
      </span>
      {manage && <TitleMenuLink onSelect={manage}>Change</TitleMenuLink>}
    </div>
    {people && <label className="title-menu-search">
      <IconSearch aria-hidden="true" size={15} stroke={1.8} />
      <input
        aria-label="Add someone by name or email"
        // The menu's typeahead would otherwise take every letter typed here.
        onKeyDown={(event) => { if (event.key !== 'Escape') event.stopPropagation(); }}
        onChange={(event) => setQuery(event.currentTarget.value)}
        placeholder="Add someone by name or email"
        value={query}
      />
    </label>}
    {people?.error && <p className="title-menu-error" role="alert">{people.error}</p>}
    {!needle && members.map((member) => <div className="title-menu-person" key={member.id}>
      <Avatar member={member} size="medium" />
      <span className="title-menu-person-copy">
        <span className="title-menu-person-name">{member.name}{present.has(member.id) ? <span aria-label="viewing now" className="title-menu-person-present" role="img" /> : null}</span>
        <span className="title-menu-person-detail">{member.id === people?.currentUserId ? 'You' : member.email}</span>
      </span>
      <span className="title-menu-person-role">{member.role === 'admin' ? 'Admin' : member.accessClass === 'guest' ? 'Guest' : 'Member'}</span>
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
          onClick={() => people.onAdd(member)}
          type="button"
        >Add</button>
      </div>)}
    </>}
    {people && needle && suggestions.length === 0 && <p className="title-menu-empty">Nobody else matches.</p>}
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
  return <>
    {(breakouts?.length ?? 0) > BREAKOUT_PREVIEW_ROWS && <label className="title-menu-search">
      <IconSearch aria-hidden="true" size={15} stroke={1.8} />
      <input
        aria-label="Find a breakout"
        onChange={(event) => setQuery(event.currentTarget.value)}
        onKeyDown={(event) => { if (event.key !== 'Escape') event.stopPropagation(); }}
        placeholder="Find a breakout"
        value={query}
      />
    </label>}
    {breakouts === undefined
      ? <p className="title-menu-empty">Loading breakouts…</p>
      : breakouts.length === 0
        ? <p className="title-menu-empty">Start a breakout from any message.</p>
        : shown?.length === 0
          ? <p className="title-menu-empty">No breakout matches.</p>
          : shown?.map((breakout) => <DropdownMenu.Item
            aria-current={breakout.substreamId === openSubstreamId ? 'true' : undefined}
            className="menu-item title-menu-item title-menu-breakout"
            key={breakout.substreamId}
            onSelect={() => onOpenBreakout(breakout.substreamId)}
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
function SwitchRow({ checked, icon, label, onChange }: {
  checked: boolean; icon: ReactNode; label: string; onChange: (next: boolean) => void;
}): React.JSX.Element {
  return <DropdownMenu.CheckboxItem
    checked={checked}
    className="menu-item title-menu-switch-row"
    onCheckedChange={onChange}
    onSelect={(event) => event.preventDefault()}
  >
    {icon}
    <span className="title-menu-item-copy">{label}</span>
    <span aria-hidden="true" className="title-menu-switch" data-checked={checked ? '' : undefined} />
  </DropdownMenu.CheckboxItem>;
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
 * The Channel's title-pill menu. Its root is where the Channel lives, the
 * things most often done to it as tiles, and one row each for its people,
 * Sidekicks and Breakouts; each row and **More** opens a level in place,
 * which the pill names as a breadcrumb. It replaces the Channel sidebar, so
 * between its levels it carries all of that sidebar's sections.
 */
export function ChannelMenu({
  actions,
  addSidekick,
  breakouts,
  extraActions,
  onImportUpdates,
  onOpenArtifact,
  onOpenBreakout,
  onOpenSidekick,
  onParticipants,
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
  space,
  workstream,
}: {
  actions?: ConversationRowActions | undefined;
  addSidekick?: ReactNode;
  breakouts: readonly BreakoutMark[] | undefined;
  /** Host-only items placed in **More** after the shared ones, e.g. a debug copy. */
  extraActions?: ReactNode;
  onImportUpdates?: (() => void) | undefined;
  onOpenArtifact?: ((id: string, returnFocus: HTMLElement) => void) | undefined;
  onOpenBreakout: (substreamId: string) => void;
  onOpenSidekick?: (id: string) => void;
  onParticipants?: (() => void) | undefined;
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
  /** The Space this menu names, or absent for a Channel only in General. */
  space?: { icon: ReactNode; name: string; onOpen?: (() => void) | undefined } | undefined;
  workstream: SidebarPresentation;
}): React.JSX.Element {
  const nav = useTitleMenuNav();
  const target = { substreamId: '0', title: workstream.title };
  const artifacts = workstream.resources.filter((resource) => resource.direction === 'artifact');
  if (nav.view?.key === 'people') {
    return <PeopleView manage={onParticipants} members={workstream.participants} noun="channel" people={people} presentUserIds={presentUserIds} scope={workstream.scope} />;
  }
  if (nav.view?.key === 'sidekicks') {
    return <SidekicksView addSidekick={addSidekick} failure={sidekickFailure} items={sidekicks} onMenuOpen={onSidekickMenuOpen} onOpen={onOpenSidekick} onRefresh={onRefreshSidekicks} />;
  }
  if (nav.view?.key === 'breakouts') {
    return <BreakoutsView breakouts={breakouts} onOpenBreakout={onOpenBreakout} openSubstreamId={openSubstreamId} renderAge={renderAge} />;
  }
  if (nav.view?.key === 'more') {
    return <>
      {pinned && <div className="title-menu-settings">
        <SwitchRow checked={pinned.on} icon={<IconPin aria-hidden="true" size={16} stroke={1.8} />} label="Pinned in sidebar" onChange={pinned.onChange} />
      </div>}
      {actions?.onMakePublic && <TitleMenuItem disabled={actions.publicDisabled} icon={<IconWorld aria-hidden="true" size={16} stroke={1.8} />} onSelect={actions.onMakePublic}>Make public to organization</TitleMenuItem>}
      {onImportUpdates && <TitleMenuItem icon={<IconCloudDownload aria-hidden="true" size={16} stroke={1.8} />} onSelect={onImportUpdates}>Import updates</TitleMenuItem>}
      {extraActions}
      {artifacts.length > 0 && <>
        <div className="title-menu-section-heading">Artifacts</div>
        {artifacts.map((resource) => <DropdownMenu.Item
          className="menu-item title-menu-item"
          disabled={!onOpenArtifact}
          key={resource.id}
          onSelect={(event) => onOpenArtifact?.(resource.id, event.currentTarget as HTMLElement)}
        >
          <ResourceIcon resource={resource} />
          <span className="title-menu-item-copy">{resource.title}</span>
        </DropdownMenu.Item>)}
      </>}
    </>;
  }
  return <>
    {space && <TitleMenuHeader
      action={space.onOpen && <TitleMenuLink onSelect={space.onOpen}>Open space</TitleMenuLink>}
      eyebrow="In space"
      icon={space.icon}
      title={space.name}
    />}
    <ActionTiles>
      <ActionTile disabled={!onParticipants && !people} icon={<IconUserPlus aria-hidden="true" size={20} stroke={1.6} />} label="Add people" onSelect={openLevel(nav, PEOPLE_VIEW)} />
      {actions?.onRename && <ActionTile icon={<IconPencil aria-hidden="true" size={20} stroke={1.6} />} label="Rename" onSelect={() => actions.onRename?.(target)} />}
      {actions?.onCopyLink && <ActionTile icon={<IconLink aria-hidden="true" size={20} stroke={1.6} />} label="Copy link" onSelect={() => actions.onCopyLink?.(target)} />}
      {actions?.onShare && <ActionTile icon={<IconShare2 aria-hidden="true" size={20} stroke={1.6} />} label="Share" onSelect={() => actions.onShare?.(target)} />}
      <ActionTile icon={<IconDots aria-hidden="true" size={20} stroke={1.6} />} label="More" onSelect={openLevel(nav, MORE_VIEW)} />
    </ActionTiles>
    <LevelRow icon={<IconUsers aria-hidden="true" size={17} stroke={1.7} />} label="People" meta={peopleMeta(workstream.participants.length, workstream.scope, participantsPending)} view={PEOPLE_VIEW} />
    <LevelRow icon={<IconRobot aria-hidden="true" size={17} stroke={1.7} />} label="Sidekicks" meta={sidekickMeta(sidekicks)} view={SIDEKICKS_VIEW} />
    <LevelRow icon={<IconCornerDownRight aria-hidden="true" size={17} stroke={1.7} />} label="Breakouts" meta={breakouts?.length} view={BREAKOUTS_VIEW} />
    {actions?.onArchive && <>
      <TitleMenuSeparator />
      <TitleMenuItem danger icon={<IconArchive aria-hidden="true" size={16} stroke={1.8} />} onSelect={() => actions.onArchive?.(target)}>Archive channel</TitleMenuItem>
    </>}
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
  onParticipants,
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
  onParticipants?: (() => void) | undefined;
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
    return <PeopleView manage={onParticipants} members={participants} noun="breakout" people={people} presentUserIds={presentUserIds} scope={scope} />;
  }
  if (nav.view?.key === 'sidekicks') {
    return <SidekicksView addSidekick={addSidekick} failure={sidekickFailure} items={sidekicks} onMenuOpen={onSidekickMenuOpen} onOpen={onOpenSidekick} onRefresh={onRefreshSidekicks} />;
  }
  if (nav.view?.key === 'more') {
    return <>
      {appearance}
      {actions?.onMakePublic && <TitleMenuItem disabled={actions.publicDisabled} icon={<IconWorld aria-hidden="true" size={16} stroke={1.8} />} onSelect={actions.onMakePublic}>Make public to organization</TitleMenuItem>}
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
      <ActionTile disabled={!onParticipants && !people} icon={<IconUserPlus aria-hidden="true" size={20} stroke={1.6} />} label="Add people" onSelect={openLevel(nav, PEOPLE_VIEW)} />
      {actions?.onRename && <ActionTile icon={<IconPencil aria-hidden="true" size={20} stroke={1.6} />} label="Rename" onSelect={() => actions.onRename?.(breakout)} />}
      {actions?.onCopyLink && <ActionTile icon={<IconLink aria-hidden="true" size={20} stroke={1.6} />} label="Copy link" onSelect={() => actions.onCopyLink?.(breakout)} />}
      {actions?.onShare && <ActionTile icon={<IconShare2 aria-hidden="true" size={20} stroke={1.6} />} label="Share" onSelect={() => actions.onShare?.(breakout)} />}
      {(appearance || actions?.onMakePublic) && <ActionTile icon={<IconDots aria-hidden="true" size={20} stroke={1.6} />} label="More" onSelect={openLevel(nav, MORE_VIEW)} />}
    </ActionTiles>
    <LevelRow icon={<IconUsers aria-hidden="true" size={17} stroke={1.7} />} label="People" meta={peopleMeta(participants.length, scope, participantsPending)} view={PEOPLE_VIEW} />
    <LevelRow icon={<IconRobot aria-hidden="true" size={17} stroke={1.7} />} label="Sidekicks" meta={sidekickMeta(sidekicks)} view={SIDEKICKS_VIEW} />
    {actions?.onArchive && <>
      <TitleMenuSeparator />
      <TitleMenuItem danger icon={<IconArchive aria-hidden="true" size={16} stroke={1.8} />} onSelect={() => actions.onArchive?.(breakout)}>Archive breakout</TitleMenuItem>
    </>}
  </>;
}
