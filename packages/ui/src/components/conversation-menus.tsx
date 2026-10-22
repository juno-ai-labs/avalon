import { ErrorNotice } from './primitives';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import {
  IconArchive,
  IconBrain,
  IconCancel,
  IconCheck,
  IconCloudDownload,
  IconCornerDownRight,
  IconCornerUpLeft,
  IconDots,
  IconFiles,
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
import type { MemoryReviewSource, PeopleRanking } from '@rally/contracts';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { compareAlphabeticalName, compareAlphabeticalTitle } from '../lib/alphabetical';
import {
  ADDRESS_FORMAT_MESSAGE,
  areAddresses,
  inactiveAccountsMessage,
  MEMBERS_ONLY_MESSAGE,
  resolveTypedAddresses,
  typedTokens,
} from '../lib/typed-addresses';
import type { SidebarPresentation, WorkspaceMember } from '../lib/types';
import { breakoutHasActivity, type BreakoutMark } from './breakout-marks';
import { MemoryFactRows, type MemoryFactsState } from './memory-fact-rows';
import { MenuActionItem } from './menu-action-item';
import { Avatar, Tip } from './primitives';
import { ResourceIcon } from './resource-icon';
import { SidekickSection, type SidekickRow, type SidekickSectionFailure } from './sidekick-section';
import { ActionTile, ActionTiles, keepSearchFocus, LevelRow, openLevel, TitleMenuHeader, TitleMenuItem, TitleMenuButton, TitleMenuSearch, TitleMenuSeparator, useTitleMenuNav, type TitleMenuView } from './title-pill';
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
  /** Mark this conversation done while keeping it visible. */
  onResolve?: ((target: ConversationRowTarget) => void) | undefined;
  resolveDisabled?: boolean | undefined;
  resolveDisabledReason?: string | undefined;
  /**
   * Merge this conversation's result up: a Breakout into its Thread, a Thread
   * into one of its Channels. The label names the target ("Merge to Launch Thread",
   * "Merge to GTM"); absent where nothing here can merge.
   */
  /** Optional trailing context: a multiple-Channel count. */
  merge?: {
    label: ReactNode;
    target?: string | undefined;
    disabled?: boolean | undefined;
    disabledReason?: string | undefined;
    onSelect: () => void;
  } | undefined;
}

/** Keep a destination's type word regular, with an unnamed-target fallback. */
export function MergeDestinationLabel({ name, kind }: { name: string; kind: 'channel' | 'thread' }): React.JSX.Element {
  const noun = kind === 'thread' ? 'Thread' : 'Channel';
  const title = name.trim();
  if (!title) return <>Merge to {noun.toLowerCase()}</>;
  const hasNoun = title === noun || title.endsWith(` ${noun}`);
  const destination = hasNoun ? title.slice(0, -noun.length).trimEnd() : title;
  return <>Merge to {destination && <strong>{destination}</strong>}{(hasNoun || kind === 'thread') && <>{destination ? ' ' : ''}{noun}</>}</>;
}

/** The menu row that opens the composer's merge mode; the breakout mark rotated 180°. */
function MergeRow({ actions }: { actions?: ConversationRowActions | undefined }): React.JSX.Element | null {
  if (!actions?.merge) return null;
  // Drawn as the rows under it are, so it reads as one of the menu's rows:
  // the target where they show their count, and no chevron, since it acts.
  return <MenuActionItem className="menu-item title-menu-level-row title-menu-merge-row" disabled={actions.merge.disabled} disabledReason={actions.merge.disabledReason} onSelect={actions.merge.onSelect}>
    <IconCornerUpLeft aria-hidden="true" size={17} stroke={1.7} />
    <span className="title-menu-item-copy">{actions.merge.label}</span>
    {actions.merge.target && <span className="title-menu-level-meta">{actions.merge.target}</span>}
  </MenuActionItem>;
}

/** Resolution is independent of publishing a result or archiving the conversation. */
function ResolveRow({ actions, target, noun }: {
  actions?: ConversationRowActions | undefined; target: ConversationRowTarget; noun: 'Thread' | 'Breakout';
}): React.JSX.Element | null {
  if (!actions?.onResolve) return null;
  return <MenuActionItem className="menu-item title-menu-level-row" disabled={actions.resolveDisabled} disabledReason={actions.resolveDisabledReason} onSelect={() => actions.onResolve?.(target)}>
    <IconCheck aria-hidden="true" size={17} stroke={1.7} />
    <span className="title-menu-item-copy">Resolve {noun}</span>
  </MenuActionItem>;
}

/** How many Breakouts the Breakouts view lists before "Show N more". */
const BREAKOUT_PREVIEW_ROWS = 6;

/** Product policy: show five suggestions, ordered by interaction priority. */
const PEOPLE_SUGGESTIONS = 5;

const PEOPLE_VIEW: TitleMenuView = { key: 'people', label: 'People' };
const ARTIFACTS_VIEW: TitleMenuView = { key: 'artifacts', label: 'Artifacts' };
const SIDEKICKS_VIEW: TitleMenuView = { key: 'sidekicks', label: 'Sidekicks' };
const BREAKOUTS_VIEW: TitleMenuView = { key: 'breakouts', label: 'Breakouts' };
const MEMORY_VIEW: TitleMenuView = { key: 'memory', label: 'Memory' };
const MORE_VIEW: TitleMenuView = { key: 'more', label: 'More' };

/**
 * Adding people from inside the menu: everyone the reader could add, and the
 * add itself. Absent where the host cannot add people, which leaves the People
 * view as a list.
 */
export interface TitleMenuPeople {
  candidates: readonly WorkspaceMember[];
  ranking?: PeopleRanking | undefined;
  /** Warm optional ordering when the containing title menu opens. */
  onOpen?: (() => void) | undefined;
  /**
   * Addresses invited to the Organization that have not joined, lower case.
   * Listed after the members; adding one invites the address here through
   * `invites`, so they are in the room when they arrive.
   */
  invitees?: readonly string[] | undefined;
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
  /** People who asked to join this conversation, answered in place; absent or empty shows nothing. */
  requests?: TitleMenuAccessRequests | undefined;
}

/**
 * Requests to join, listed to the person they wait on: the conversation's
 * creator (`docs/channel-access-requests.md`).
 */
export interface TitleMenuAccessRequests {
  items: readonly { id: string; userId: string; name: string }[];
  onDecide: (requestId: string, decision: 'approve' | 'decline') => void;
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

/**
 * What Rally remembers about this conversation, for its Memory level: the
 * facts whose subject is this Thread, Breakout or Channel. The host reads them
 * and removes one; absent where the host has no reader for them.
 */
export interface TitleMenuMemory extends MemoryFactsState {
  /** The Memory level opened: the host reads the facts then, not on every open of the conversation. */
  onOpen?: (() => void) | undefined;
  /** Opens the conversation a fact was learned in; the menu closes as it does. */
  onOpenSource?: ((source: MemoryReviewSource) => void) | undefined;
}

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

/**
 * Who is in the conversation and who could be: a search that also takes email
 * addresses, the participants, invitations still waiting, and suggestions to
 * add. Enter adds what was typed and keeps the menu open for the next one.
 */
function PeopleView({ members, noun, people, presentUserIds }: {
  members: readonly WorkspaceMember[];
  noun: 'thread' | 'channel' | 'breakout';
  people?: TitleMenuPeople | undefined;
  presentUserIds: readonly string[];
}): React.JSX.Element {
  const [query, setQuery] = useState('');
  const [entryError, setEntryError] = useState<{ message: string } | null>(null);
  // A late refresh must never move an Add button under the reader's pointer.
  const [ranking] = useState(people?.ranking);
  // One submission at a time: adds run in order, so a later roster never lands before an earlier one.
  const submitting = useRef(false);
  const invites = people?.invites;
  const onLoad = useRef(invites?.onLoad);
  useEffect(() => { onLoad.current?.(); }, []);
  const needle = query.trim().toLocaleLowerCase();
  const present = new Set(presentUserIds);
  const inRoom = new Set(members.map((member) => member.id));
  const requests = people?.requests?.items ?? [];
  // Someone who asked is answered under Asked to join, not offered again below it.
  const asked = new Set(requests.map((request) => request.userId));
  const addable = (people?.candidates ?? []).filter((member) => !inRoom.has(member.id) && !asked.has(member.id)
    && (member.status ?? 'active') === 'active'
    && (!needle || member.name.toLocaleLowerCase().includes(needle) || (member.email ?? '').toLocaleLowerCase().includes(needle)));
  // Already invited here is already in the room's list, as Invited.
  const invitedHere = new Set(invites?.pending ?? []);
  const inviteeSuggestions = invites ? (people?.invitees ?? []).filter((email) => !invitedHere.has(email)
    && (!needle || email.includes(needle))) : [];
  const remaining = new Map(addable.map((member) => [member.id, member]));
  const ranked = (ids: readonly string[]): WorkspaceMember[] => {
    const selected: WorkspaceMember[] = [];
    for (const id of ids) {
      const member = remaining.get(id);
      if (!member) continue;
      selected.push(member);
      remaining.delete(id);
      if (selected.length === PEOPLE_SUGGESTIONS) break;
    }
    return selected;
  };
  const channelPeople = ranked(ranking?.channel ?? []);
  const organizationPeople = ranked(ranking?.organization ?? []);
  const alphabetical = [...remaining.values()].sort(compareAlphabeticalName);
  const orderedSuggestions: Array<WorkspaceMember | string> = [
    ...channelPeople,
    ...organizationPeople,
    ...alphabetical.filter((member) => member.accessClass !== 'guest'),
    ...inviteeSuggestions,
    ...alphabetical.filter((member) => member.accessClass === 'guest'),
  ];
  // Search exposes all matches; only the idle Suggested list is capped.
  const visibleSuggestions = needle ? orderedSuggestions : orderedSuggestions.slice(0, PEOPLE_SUGGESTIONS);
  const tokens = typedTokens(query);
  const typedEmails = areAddresses(tokens);
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
      // One row across both lists, or Enter would pick between rows the reader can see.
      const single = addable.length + inviteeSuggestions.length === 1;
      const only = single ? addable[0] : undefined;
      const onlyInvitee = single ? inviteeSuggestions[0] : undefined;
      if (only) void run(query, [only], []);
      else if (onlyInvitee) void run(query, [], [onlyInvitee]);
      else setEntryError({ message: ADDRESS_FORMAT_MESSAGE });
      return;
    }
    // Who is already invited decides who is invited again, so it has to be known first.
    if (invites && invites.pending === undefined) {
      setEntryError({ message: invites.loadFailed ? 'Invitations couldn’t be loaded. Try again.' : 'Invitations are still loading. Try again in a moment.' });
      return;
    }
    const here = new Set([...members.flatMap((member) => member.email ? [member.email.toLocaleLowerCase()] : []), ...invites?.pending ?? []]);
    const { adds, inactive, strangers } = resolveTypedAddresses(tokens, people.candidates, here);
    if (inactive.length > 0) {
      setEntryError({ message: inactiveAccountsMessage(inactive) });
      return;
    }
    if (strangers.length > 0 && !invites) {
      setEntryError({ message: MEMBERS_ONLY_MESSAGE });
      return;
    }
    void run(query, adds, strangers);
  };
  const error = entryError?.message ?? people?.error;
  return <>
    {people && <TitleMenuSearch className="title-menu-people-search" label="Add someone by name or email" onChange={change} onEnter={submit} value={query} />}
    {error && <ErrorNotice occurrence={entryError ?? undefined}>{error}</ErrorNotice>}
    {invites?.loadFailed && <>
      <ErrorNotice automatic={false} detailsLabel="Invitation details">Invitations waiting to sign in couldn’t be loaded.</ErrorNotice>
      {invites.onRetryLoad && <button className="title-menu-add" onClick={invites.onRetryLoad} type="button">Try again</button>}
    </>}
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
    {!needle && invites?.pending?.map((email) => <div className="title-menu-person is-invited" key={email}>
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
    {!needle && people?.requests && requests.length > 0 && <>
      <div className="title-menu-section-heading">Asked to join</div>
      {requests.map((request) => {
        const member: WorkspaceMember = people.candidates.find((candidate) => candidate.id === request.userId)
          ?? { id: request.userId, name: request.name, email: '', timezone: 'UTC' };
        return <div className="title-menu-person" key={request.id}>
          <Avatar member={member} size="medium" />
          <span className="title-menu-person-copy">
            <span className="title-menu-person-name">{request.name}</span>
            {member.email && <span className="title-menu-person-detail">{member.email}</span>}
          </span>
          <Tip describesTrigger={false} label="Approve" side="top">
            <button
              aria-label={`Approve ${request.name}`}
              className="decision-button is-approve"
              onClick={() => people.requests?.onDecide(request.id, 'approve')}
              type="button"
            ><IconCheck aria-hidden="true" size={16} stroke={2} /></button>
          </Tip>
          <Tip describesTrigger={false} label="Decline" side="top">
            <button
              aria-label={`Decline ${request.name}`}
              className="decision-button is-decline"
              onClick={() => people.requests?.onDecide(request.id, 'decline')}
              type="button"
            ><IconCancel aria-hidden="true" size={16} stroke={2} /></button>
          </Tip>
        </div>;
      })}
    </>}
    {people && visibleSuggestions.length > 0 && <>
      <div className="title-menu-section-heading">{needle ? 'Add to this ' + noun : 'Suggested'}</div>
      {visibleSuggestions.map((suggestion) => {
        if (typeof suggestion === 'string') return <div className="title-menu-person is-invited" key={`invitee:${suggestion}`}>
          <Avatar member={{ id: suggestion, name: suggestion, email: suggestion, timezone: 'UTC' }} size="medium" />
          <span className="title-menu-person-copy">
            <span className="title-menu-person-name">{suggestion}</span>
            <span className="title-menu-person-detail">Invited</span>
          </span>
          <button
            aria-label={`Add ${suggestion}`}
            className="title-menu-add"
            disabled={people.adding}
            onClick={() => { if (!submitting.current) void run(query, [], [suggestion]); }}
            type="button"
          >Add</button>
        </div>;
        const member = suggestion;
        return <div className="title-menu-person" key={member.id}>
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
        </div>;
      })}
    </>}
    {people && needle && addable.length === 0 && inviteeSuggestions.length === 0 && <p className="title-menu-empty">{typedEmails && invites
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

/** The Memory level: this conversation's own facts, newest first, each removable where the server allows. */
function MemoryView({ memory, noun }: {
  memory: TitleMenuMemory;
  noun: 'thread' | 'channel' | 'breakout';
}): React.JSX.Element {
  const onOpen = useRef(memory.onOpen);
  useEffect(() => { onOpen.current?.(); }, []);
  const { facts, failure, onOpenSource } = memory;
  return <div className="title-menu-memory">
    {facts === undefined
      ? failure
        ? <ErrorNotice automatic={false} detailsLabel="Memory details">{failure}</ErrorNotice>
        : <p className="title-menu-empty">Loading what Rally remembers…</p>
      : facts.length === 0
        ? <p className="title-menu-empty">Rally has not remembered anything about this {noun} yet.</p>
        : <MemoryFactRows
          facts={facts}
          onRemove={memory.onRemove}
          removals={memory.removals}
          renderSource={(source, title) => onOpenSource
            ? <DropdownMenu.Item asChild onSelect={() => onOpenSource(source)}>
              <button className="memory-review-source" type="button">{title}</button>
            </DropdownMenu.Item>
            : title}
        />}
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

/** A level row's count, including zero; nothing while the list is unknown. */
function countMeta(items: readonly unknown[] | undefined): string | undefined {
  if (items === undefined) return undefined;
  return `${items.length}`;
}

function MemoryLevelRow({ memory }: { memory: TitleMenuMemory | undefined }): React.JSX.Element | null {
  if (!memory) return null;
  return <LevelRow icon={<IconBrain aria-hidden="true" size={17} stroke={1.7} />} label="Memory" meta={countMeta(memory.facts)} view={MEMORY_VIEW} />;
}

function peopleMeta(count: number, scope: 'personal' | 'workspace' | undefined, pending: boolean): string | undefined {
  if (pending) return undefined;
  return scope ? `${count} · ${scope === 'workspace' ? 'Public' : 'Private'}` : `${count}`;
}

/**
 * The Channel's title-pill menu. Its root is the things most often done to
 * it as tiles, and one row each for its people,
 * Artifacts, Sidekicks, Breakouts and Memory; each row and **More** opens a level in place,
 * which the pill names as a breadcrumb. It replaces the Channel sidebar, so
 * between its levels it carries all of that sidebar's sections.
 */
export function ChannelMenu({
  actions,
  addSidekick,
  appearance,
  breakouts,
  extraActions,
  memory,
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
  resourcesPending = false,
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
  memory?: TitleMenuMemory | undefined;
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
  /** Resources are not known until a conversation snapshot or rail answers. */
  resourcesPending?: boolean;
  sidekickFailure?: SidekickSectionFailure | undefined;
  sidekicks?: SidekickRow[] | undefined;
  workstream: SidebarPresentation;
}): React.JSX.Element {
  const nav = useTitleMenuNav();
  const target = { substreamId: '0', title: workstream.title };
  const artifacts = workstream.resources.filter((resource) => resource.direction === 'artifact');
  const otherResources = workstream.resources.filter((resource) => resource.direction !== 'artifact');
  if (nav.view?.key === 'people') {
    return <PeopleView members={workstream.participants} noun="thread" people={people} presentUserIds={presentUserIds} />;
  }
  if (nav.view?.key === 'artifacts') {
    if (resourcesPending) return <p className="title-menu-empty">Loading artifacts…</p>;
    return artifacts.length > 0
      ? <ResourceList onOpen={onOpenArtifact} resources={artifacts} />
      : <p className="title-menu-empty">No artifacts yet.</p>;
  }
  if (nav.view?.key === 'sidekicks') {
    return <SidekicksView addSidekick={addSidekick} failure={sidekickFailure} items={sidekicks} onMenuOpen={onSidekickMenuOpen} onOpen={onOpenSidekick} onRefresh={onRefreshSidekicks} />;
  }
  if (nav.view?.key === 'breakouts') {
    return <BreakoutsView breakouts={breakouts} onOpenBreakout={onOpenBreakout} openSubstreamId={openSubstreamId} renderAge={renderAge} />;
  }
  if (nav.view?.key === 'memory' && memory) return <MemoryView memory={memory} noun="thread" />;
  if (nav.view?.key === 'more') {
    return <>
      {appearance}
      {pinned && <SwitchRow checked={pinned.on} icon={<IconPin aria-hidden="true" size={16} stroke={1.8} />} label="Pinned in my sidebar" onChange={pinned.onChange} />}
      <PublicSwitch actions={actions} />
      {onImportUpdates && <TitleMenuItem icon={<IconCloudDownload aria-hidden="true" size={16} stroke={1.8} />} onSelect={onImportUpdates}>Import updates</TitleMenuItem>}
      {extraActions}
      {onOpenResource && <ResourceList label="Resources" onOpen={onOpenResource} resources={otherResources} />}
      {actions?.onArchive && <>
        <TitleMenuSeparator />
        <TitleMenuItem danger icon={<IconArchive aria-hidden="true" size={16} stroke={1.8} />} onSelect={() => actions.onArchive?.(target)}>Archive thread</TitleMenuItem>
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
    <MergeRow actions={actions} />
    <ResolveRow actions={actions} noun="Thread" target={target} />
    <LevelRow icon={<IconUsers aria-hidden="true" size={17} stroke={1.7} />} label="People" meta={peopleMeta(workstream.participants.length, workstream.scope, participantsPending)} view={PEOPLE_VIEW} />
    <LevelRow icon={<IconFiles aria-hidden="true" size={17} stroke={1.7} />} label="Artifacts" meta={resourcesPending ? undefined : artifacts.length} view={ARTIFACTS_VIEW} />
    <LevelRow icon={<IconHexagons aria-hidden="true" size={17} stroke={1.7} />} label="Sidekicks" meta={countMeta(sidekicks)} view={SIDEKICKS_VIEW} />
    <LevelRow icon={<IconCornerDownRight aria-hidden="true" size={17} stroke={1.7} />} label="Breakouts" meta={breakouts?.length} view={BREAKOUTS_VIEW} />
    <MemoryLevelRow memory={memory} />
  </>;
}

/**
 * A Channel's title-pill menu, for the Channel screen: a Channel holds threads
 * rather than a conversation, so its menu is its people, its Sidekicks and what
 * Rally remembers about it, with
 * the settings a Channel has (private or Organization-wide, pinned) and its
 * archive behind **More**, the same place a thread keeps them.
 *
 * The Sidekicks level lists the Sidekicks the Channel recommends to every
 * thread started in it (the stored Space's Sidekick defaults), which is where
 * the product owner put the Sidekick list
 * (`docs/PRDs/2026-10-10_channels-threads-navigation/prd.md`).
 */
export function ChannelContainerMenu({
  addSidekick,
  appearance,
  channel,
  members,
  memory,
  onArchive,
  onCopyLink,
  onOpenSidekick,
  onRename,
  people,
  pinned,
  publicToOrganization,
  sidekickFailure,
  sidekicks,
}: {
  addSidekick?: ReactNode;
  /** The Channel's icon-and-colour choice, as a submenu, when the viewer may change it. */
  appearance?: ReactNode;
  channel: { name: string; scope: 'personal' | 'workspace' };
  members: readonly WorkspaceMember[];
  memory?: TitleMenuMemory | undefined;
  /** Asks to archive the Channel; absent where the viewer may not (General, a guest). */
  onArchive?: (() => void) | undefined;
  onCopyLink?: (() => void) | undefined;
  onOpenSidekick?: (id: string) => void;
  onRename?: (() => void) | undefined;
  people?: TitleMenuPeople | undefined;
  pinned?: { on: boolean; onChange: (next: boolean) => void } | undefined;
  /** Open to the whole Organization, and the switch; absent where the viewer may not change it. */
  publicToOrganization?: { on: boolean; onChange: (next: boolean) => void; disabled?: boolean } | undefined;
  sidekickFailure?: SidekickSectionFailure | undefined;
  sidekicks?: SidekickRow[] | undefined;
}): React.JSX.Element {
  const nav = useTitleMenuNav();
  if (nav.view?.key === 'people') {
    return <PeopleView members={members} noun="channel" people={people} presentUserIds={[]} />;
  }
  if (nav.view?.key === 'sidekicks') {
    return <SidekicksView addSidekick={addSidekick} failure={sidekickFailure} items={sidekicks} onOpen={onOpenSidekick} />;
  }
  if (nav.view?.key === 'memory' && memory) return <MemoryView memory={memory} noun="channel" />;
  if (nav.view?.key === 'more') {
    return <>
      {appearance}
      {pinned && <SwitchRow checked={pinned.on} icon={<IconPin aria-hidden="true" size={16} stroke={1.8} />} label="Pinned in my sidebar" onChange={pinned.onChange} />}
      {publicToOrganization && <SwitchRow checked={publicToOrganization.on} disabled={publicToOrganization.disabled} icon={<IconWorld aria-hidden="true" size={16} stroke={1.8} />} label="Public to organization" onChange={publicToOrganization.onChange} />}
      {onArchive && <>
        {(appearance || publicToOrganization || pinned) && <TitleMenuSeparator />}
        <TitleMenuItem danger icon={<IconArchive aria-hidden="true" size={16} stroke={1.8} />} onSelect={onArchive}>Archive channel</TitleMenuItem>
      </>}
    </>;
  }
  return <>
    <ActionTiles>
      <ActionTile disabled={!people} icon={<IconUserPlus aria-hidden="true" size={20} stroke={1.6} />} label="Add people" onSelect={openLevel(nav, PEOPLE_VIEW)} />
      {onRename && <ActionTile icon={<IconPencil aria-hidden="true" size={20} stroke={1.6} />} label="Rename" onSelect={onRename} />}
      {onCopyLink && <ActionTile icon={<IconLink aria-hidden="true" size={20} stroke={1.6} />} label="Copy link" onSelect={onCopyLink} />}
      {(appearance || publicToOrganization || pinned || onArchive) && <ActionTile icon={<IconDots aria-hidden="true" size={20} stroke={1.6} />} label="More" onSelect={openLevel(nav, MORE_VIEW)} />}
    </ActionTiles>
    <LevelRow icon={<IconUsers aria-hidden="true" size={17} stroke={1.7} />} label="People" meta={peopleMeta(members.length, channel.scope, false)} view={PEOPLE_VIEW} />
    <LevelRow icon={<IconHexagons aria-hidden="true" size={17} stroke={1.7} />} label="Sidekicks" meta={countMeta(sidekicks)} view={SIDEKICKS_VIEW} />
    <MemoryLevelRow memory={memory} />
  </>;
}

/**
 * The Breakout's title-pill menu: which Channel it belongs to and the message
 * it started from, its most used actions as tiles, and rows for its people,
 * Sidekicks and Memory, each opening a level in place.
 */
export function BreakoutMenu({
  actions,
  addSidekick,
  appearance,
  breakout,
  channel,
  memory,
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
  memory?: TitleMenuMemory | undefined;
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
  if (nav.view?.key === 'memory' && memory) return <MemoryView memory={memory} noun="breakout" />;
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
      action={onShowInChannel && <TitleMenuButton onSelect={onShowInChannel}>Show in thread</TitleMenuButton>}
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
    <MergeRow actions={actions} />
    <ResolveRow actions={actions} noun="Breakout" target={breakout} />
    <LevelRow icon={<IconUsers aria-hidden="true" size={17} stroke={1.7} />} label="People" meta={peopleMeta(participants.length, scope, participantsPending)} view={PEOPLE_VIEW} />
    <LevelRow icon={<IconHexagons aria-hidden="true" size={17} stroke={1.7} />} label="Sidekicks" meta={countMeta(sidekicks)} view={SIDEKICKS_VIEW} />
    <MemoryLevelRow memory={memory} />
  </>;
}

/** A conversation's resource rows, optionally headed; nothing when there are none. */
function ResourceList({ label, onOpen, resources }: {
  label?: string;
  onOpen: ((id: string, returnFocus: HTMLElement) => void) | undefined;
  resources: SidebarPresentation['resources'];
}): React.JSX.Element | null {
  if (resources.length === 0) return null;
  return <>
    {label && <div className="title-menu-section-heading">{label}</div>}
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
