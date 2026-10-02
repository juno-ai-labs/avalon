import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import {
  IconArchive,
  IconCloudDownload,
  IconCornerDownRight,
  IconLink,
  IconLock,
  IconPencil,
  IconSearch,
  IconShare2,
  IconUserPlus,
  IconWorld,
} from '@tabler/icons-react';
import { useMemo, useState, type ReactNode } from 'react';

import { compareAlphabeticalTitle } from '../lib/alphabetical';
import type { SidebarPresentation, WorkspaceMember } from '../lib/types';
import { breakoutHasActivity, type BreakoutMark } from './breakout-marks';
import { AvatarStack } from './primitives';
import { ResourceIcon } from './resource-icon';
import { SidekickSection, type SidekickRow, type SidekickSectionFailure } from './sidekick-section';
import { TitleMenuHeader, TitleMenuItem, TitleMenuLink, TitleMenuSeparator } from './title-pill';
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

/** How many Breakouts the Channel menu lists before "Show N more". */
const BREAKOUT_PREVIEW_ROWS = 6;

function PeopleRow({ chip, count, members, pending, presentUserIds, onManage }: {
  chip?: ReactNode;
  count?: number;
  members: readonly WorkspaceMember[];
  pending: boolean;
  presentUserIds: readonly string[];
  onManage: (() => void) | undefined;
}): React.JSX.Element {
  const total = count ?? members.length;
  return <div className="title-menu-people">
    <DropdownMenu.Item className="title-menu-people-trigger" disabled={pending || !onManage} onSelect={() => onManage?.()}>
      {pending
        ? <span aria-hidden="true" className="skeleton-avatar-stack"><span className="skeleton-bar" /><span className="skeleton-bar" /></span>
        : members.length > 0
          ? <AvatarStack limit={3} members={[...members]} presentUserIds={presentUserIds} showTooltip={false} />
          : <IconUserPlus aria-hidden="true" size={18} stroke={1.8} />}
      <span>{pending ? 'People' : `${total} ${total === 1 ? 'person' : 'people'}`}</span>
    </DropdownMenu.Item>
    {chip}
  </div>;
}

/**
 * The Channel's title-pill menu: where it lives, who is in it, its Sidekicks
 * and artifacts, what can be done to it, and every Breakout the reader can
 * open. It replaces the Channel sidebar, so it carries all of that sidebar's
 * sections; the Breakout rows are a second way into the split pane, the
 * first being the chips under each origin message.
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
  /** Host-only items placed after the shared actions, e.g. a debug copy. */
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
  presentUserIds: readonly string[];
  renderAge?: (breakout: BreakoutMark) => ReactNode;
  sidekickFailure?: SidekickSectionFailure | undefined;
  sidekicks?: SidekickRow[] | undefined;
  /** The Space this menu names, or absent for a Channel only in General. */
  space?: { icon: ReactNode; name: string; onOpen?: (() => void) | undefined } | undefined;
  workstream: SidebarPresentation;
}): React.JSX.Element {
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState(false);
  const target = { substreamId: '0', title: workstream.title };
  const artifacts = workstream.resources.filter((resource) => resource.direction === 'artifact');
  const ordered = useMemo(() => breakouts === undefined ? undefined : [...breakouts].sort((a, b) => (
    (b.lastActivityAt ?? b.createdAt ?? '').localeCompare(a.lastActivityAt ?? a.createdAt ?? '')
    || compareAlphabeticalTitle(a, b)
  )), [breakouts]);
  const needle = query.trim().toLocaleLowerCase();
  const matching = ordered?.filter((breakout) => !needle || breakout.title.toLocaleLowerCase().includes(needle));
  const shown = expanded || needle ? matching : matching?.slice(0, BREAKOUT_PREVIEW_ROWS);
  const hidden = (matching?.length ?? 0) - (shown?.length ?? 0);
  return <>
    {space && <TitleMenuHeader
      action={space.onOpen && <TitleMenuLink onSelect={space.onOpen}>Open space</TitleMenuLink>}
      eyebrow="In space"
      icon={space.icon}
      title={space.name}
    />}
    <PeopleRow
      chip={workstream.scope && <span className="title-menu-chip">
        {workstream.scope === 'workspace'
          ? <><IconWorld aria-hidden="true" size={13} stroke={1.8} /> Public</>
          : <><IconLock aria-hidden="true" size={13} stroke={1.8} /> Private</>}
      </span>}
      members={workstream.participants}
      onManage={onParticipants}
      pending={participantsPending}
      presentUserIds={presentUserIds}
    />
    <TitleMenuSeparator />
    {onParticipants && <TitleMenuItem icon={<IconUserPlus aria-hidden="true" size={16} stroke={1.8} />} onSelect={onParticipants}>Add people</TitleMenuItem>}
    {actions?.onRename && <TitleMenuItem icon={<IconPencil aria-hidden="true" size={16} stroke={1.8} />} onSelect={() => actions.onRename?.(target)}>Rename</TitleMenuItem>}
    {actions?.onMakePublic && <TitleMenuItem disabled={actions.publicDisabled} icon={<IconWorld aria-hidden="true" size={16} stroke={1.8} />} onSelect={actions.onMakePublic}>Make public to organization</TitleMenuItem>}
    {actions?.onCopyLink && <TitleMenuItem icon={<IconLink aria-hidden="true" size={16} stroke={1.8} />} onSelect={() => actions.onCopyLink?.(target)}>Copy channel link</TitleMenuItem>}
    {actions?.onShare && <TitleMenuItem icon={<IconShare2 aria-hidden="true" size={16} stroke={1.8} />} onSelect={() => actions.onShare?.(target)}>Share</TitleMenuItem>}
    {onImportUpdates && <TitleMenuItem icon={<IconCloudDownload aria-hidden="true" size={16} stroke={1.8} />} onSelect={onImportUpdates}>Import updates</TitleMenuItem>}
    {extraActions}
    {artifacts.length > 0 && <>
      <TitleMenuSeparator />
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
    {(sidekicks !== undefined || addSidekick) && <div className="title-menu-sidekicks">
      <SidekickSection
        failure={sidekickFailure}
        items={sidekicks}
        layoutId="section:sidekicks"
        onMenuOpen={onSidekickMenuOpen}
        onOpen={onOpenSidekick}
        onRefresh={onRefreshSidekicks}
      />
      {addSidekick}
    </div>}
    <TitleMenuSeparator />
    <div className="title-menu-section-heading">
      <span>Breakouts{breakouts ? ` · ${breakouts.length}` : ''}</span>
    </div>
    {(breakouts?.length ?? 0) > BREAKOUT_PREVIEW_ROWS && <label className="title-menu-search">
      <IconSearch aria-hidden="true" size={14} stroke={1.8} />
      <input
        aria-label="Find a breakout"
        onChange={(event) => setQuery(event.currentTarget.value)}
        // The menu's typeahead would otherwise take every letter typed here.
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
    {actions?.onArchive && <>
      <TitleMenuSeparator />
      <TitleMenuItem danger icon={<IconArchive aria-hidden="true" size={16} stroke={1.8} />} onSelect={() => actions.onArchive?.(target)}>Archive channel</TitleMenuItem>
    </>}
  </>;
}

/**
 * The Breakout's title-pill menu: which Channel it belongs to, the message it
 * started from, who is in it, and its actions.
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
  presentUserIds: readonly string[];
  scope?: 'personal' | 'workspace' | undefined;
}): React.JSX.Element {
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
    <PeopleRow
      chip={<span className="title-menu-chip">
        {scope === 'workspace'
          ? <><IconWorld aria-hidden="true" size={13} stroke={1.8} /> Public</>
          : <><IconLock aria-hidden="true" size={13} stroke={1.8} /> Private</>}
      </span>}
      members={participants}
      onManage={onParticipants}
      pending={participantsPending}
      presentUserIds={presentUserIds}
    />
    <TitleMenuSeparator />
    {onParticipants && <TitleMenuItem icon={<IconUserPlus aria-hidden="true" size={16} stroke={1.8} />} onSelect={onParticipants}>Add people</TitleMenuItem>}
    {actions?.onRename && <TitleMenuItem icon={<IconPencil aria-hidden="true" size={16} stroke={1.8} />} onSelect={() => actions.onRename?.(breakout)}>Rename</TitleMenuItem>}
    {appearance}
    {actions?.onMakePublic && <TitleMenuItem disabled={actions.publicDisabled} icon={<IconWorld aria-hidden="true" size={16} stroke={1.8} />} onSelect={actions.onMakePublic}>Make public to organization</TitleMenuItem>}
    {actions?.onCopyLink && <TitleMenuItem icon={<IconLink aria-hidden="true" size={16} stroke={1.8} />} onSelect={() => actions.onCopyLink?.(breakout)}>Copy breakout link</TitleMenuItem>}
    {actions?.onShare && <TitleMenuItem icon={<IconShare2 aria-hidden="true" size={16} stroke={1.8} />} onSelect={() => actions.onShare?.(breakout)}>Share</TitleMenuItem>}
    {(sidekicks !== undefined || addSidekick) && <div className="title-menu-sidekicks">
      <SidekickSection
        failure={sidekickFailure}
        items={sidekicks}
        layoutId="section:sidekicks"
        onMenuOpen={onSidekickMenuOpen}
        onOpen={onOpenSidekick}
        onRefresh={onRefreshSidekicks}
      />
      {addSidekick}
    </div>}
    {actions?.onArchive && <>
      <TitleMenuSeparator />
      <TitleMenuItem danger icon={<IconArchive aria-hidden="true" size={16} stroke={1.8} />} onSelect={() => actions.onArchive?.(breakout)}>Archive breakout</TitleMenuItem>
    </>}
  </>;
}
