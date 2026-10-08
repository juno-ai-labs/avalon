import clsx from 'clsx';
import { ChevronDown, Plus, Search, X } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { mentionOptionId, useMentionNavigation } from '../lib/use-mention-navigation';
import type { WorkspaceMember } from '../lib/types';
import { isInvitee } from '../lib/workspace-invitees';
import { Avatar, AvatarStack } from './primitives';

/** A list's ceiling, and the gap kept between it and the top of the screen. */
const POPOVER_MAX_HEIGHT = 280;
const POPOVER_TOP_GAP = 16;

/**
 * Caps an upward list at the room above its anchor. Measured rather than
 * written in CSS: the setup is centred with the composer, whose height is the
 * draft's, so how much room there is depends on what has been typed.
 */
function fitAbove(element: HTMLElement | null): void {
  const anchor = element?.parentElement;
  const screen = element?.closest('.workstream-launch-screen');
  if (!element || !anchor || !screen) return;
  const room = anchor.getBoundingClientRect().top - screen.getBoundingClientRect().top - POPOVER_TOP_GAP;
  element.style.maxHeight = `${Math.max(0, Math.min(POPOVER_MAX_HEIGHT, room))}px`;
}

/**
 * The Participants row above the new-Channel composer.
 *
 * At rest it is a dashed **+** and one pill summing up who is in the Channel.
 * The **+** widens into a search field in place, with its results opening
 * upward, because the row sits directly above the composer. The pill opens the
 * full list, which is where a person is taken back out. The creator is always
 * in the Channel and has no remove control.
 */
export function NewChannelParticipants({
  candidates,
  creator,
  loading,
  onAdd,
  onRemove,
  selected,
}: {
  /**
   * The Organization's active members, then the people invited to it who have
   * not joined (`status: 'invited'`, named by address), the creator and the
   * picked left out.
   */
  candidates: WorkspaceMember[];
  creator: WorkspaceMember;
  loading: boolean;
  onAdd: (member: WorkspaceMember) => void;
  onRemove: (memberId: string) => void;
  selected: WorkspaceMember[];
}): React.JSX.Element {
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState('');
  const [rosterOpen, setRosterOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const addRef = useRef<HTMLButtonElement>(null);
  const rosterRef = useRef<HTMLDivElement>(null);
  const rosterTriggerRef = useRef<HTMLButtonElement>(null);
  const peopleListRef = useRef<HTMLDivElement>(null);
  const rosterListRef = useRef<HTMLDivElement>(null);
  const everyone = useMemo(() => [creator, ...selected], [creator, selected]);
  const matches = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    return normalized
      ? candidates.filter((member) => `${member.name} ${member.email}`.toLocaleLowerCase().includes(normalized))
      : candidates;
  }, [candidates, query]);
  const add = useCallback((member: WorkspaceMember): void => {
    onAdd(member);
    setQuery('');
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [onAdd]);
  const navigation = useMentionNavigation(searching ? matches.map((member) => member.id) : [], (index) => {
    const member = matches[index];
    if (member) add(member);
  });
  const stopSearching = (refocus: boolean): void => {
    setSearching(false);
    setQuery('');
    if (refocus) requestAnimationFrame(() => addRef.current?.focus());
  };
  // The roster closes on any press outside it, as every popover here does.
  useEffect(() => {
    if (!rosterOpen) return;
    const close = (event: PointerEvent): void => {
      if (!rosterRef.current?.contains(event.target as Node)) setRosterOpen(false);
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [rosterOpen]);
  // A remove that empties the list leaves nothing for the roster to show, and
  // takes away the button that had focus, so focus moves to the +.
  useEffect(() => {
    if (selected.length > 0 || !rosterOpen) return;
    setRosterOpen(false);
    addRef.current?.focus();
  }, [rosterOpen, selected.length]);
  useLayoutEffect(() => {
    if (searching) fitAbove(peopleListRef.current);
  }, [searching]);
  useLayoutEffect(() => {
    if (rosterOpen) fitAbove(rosterListRef.current);
  }, [rosterOpen]);

  // Searching takes room from the pill, so past three people it shortens to a
  // count. Names are always shown whole: a name is one string, and the part
  // before a space is not necessarily what anyone is called.
  const summary = searching && everyone.length > 3
    ? `${everyone.length} people`
    : everyone.map((member) => member.name).join(', ');

  return (
    <div className="new-channel-participants">
      <span className="new-channel-participants-label" id="new-channel-participants-label">Participants</span>
      <span className={clsx('new-channel-add', searching && 'is-searching')}>
        {searching ? <>
          <Search aria-hidden="true" className="new-channel-add-icon" size={13} strokeWidth={1.8} />
          <input
            aria-activedescendant={navigation.activeOptionId}
            aria-controls="new-channel-people"
            aria-expanded
            aria-label="Search people"
            autoComplete="off"
            autoFocus
            onBlur={() => stopSearching(false)}
            onChange={(event) => setQuery(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (navigation.handleKeyDown(event)) return;
              if (event.key === 'Backspace' && query.length === 0 && selected.length > 0) {
                event.preventDefault();
                onRemove(selected[selected.length - 1]!.id);
                return;
              }
              if (event.key !== 'Escape') return;
              event.preventDefault();
              event.stopPropagation();
              stopSearching(true);
            }}
            ref={inputRef}
            role="combobox"
            type="text"
            value={query}
          />
        </> : (
          <button
            aria-label="Add participant"
            className="new-channel-add-button"
            onClick={() => {
              setRosterOpen(false);
              setSearching(true);
            }}
            ref={addRef}
            type="button"
          >
            <Plus aria-hidden="true" size={13} strokeWidth={1.8} />
          </button>
        )}
        {searching && (
          <div
            aria-label="People"
            className="new-channel-popover new-channel-people"
            id="new-channel-people"
            // Anywhere in the list, its padding and scrollbar included, keeps
            // focus in the search field, whose blur closes the list.
            onMouseDown={(event) => event.preventDefault()}
            ref={peopleListRef}
            role="listbox"
          >
            {loading ? (
              <p className="new-channel-popover-empty">Loading people…</p>
            ) : matches.length > 0 ? matches.map((member, index) => (
              <button
                aria-label={isInvitee(member) ? `${member.email} — Invited` : `${member.name} — ${member.email}`}
                aria-selected={index === navigation.activeIndex}
                className={clsx('new-channel-popover-row', index === navigation.activeIndex && 'is-selected', isInvitee(member) && 'is-invited')}
                id={mentionOptionId(member.id)}
                key={member.id}
                onClick={() => add(member)}
                onMouseMove={() => navigation.setActiveIndex(index)}
                ref={index === navigation.activeIndex ? navigation.activeOptionRef : undefined}
                role="option"
                tabIndex={-1}
                type="button"
              >
                <Avatar member={member} size="small" />
                <span className="new-channel-popover-name">{member.name}</span>
                {isInvitee(member) && <span className="new-channel-popover-kind">Invited</span>}
              </button>
            )) : (
              <p className="new-channel-popover-empty">
                {query.trim() ? 'No matching people' : 'Everyone available is selected'}
              </p>
            )}
          </div>
        )}
      </span>
      <div
        className="new-channel-roster-anchor"
        onKeyDown={(event) => {
          if (event.key !== 'Escape' || !rosterOpen) return;
          event.preventDefault();
          event.stopPropagation();
          setRosterOpen(false);
          rosterTriggerRef.current?.focus();
        }}
        ref={rosterRef}
      >
        {everyone.length === 1 ? (
          <span aria-labelledby="new-channel-participants-label" className="new-channel-roster" role="group">
            <Avatar member={creator} size="small" />
            <span className="new-channel-roster-names">{summary}</span>
          </span>
        ) : (
          <button
            aria-expanded={rosterOpen}
            aria-label={`Participants: ${everyone.map((member) => member.name).join(', ')}`}
            className="new-channel-roster"
            onClick={() => setRosterOpen((open) => !open)}
            ref={rosterTriggerRef}
            type="button"
          >
            <AvatarStack members={everyone} showTooltip={false} />
            <span className="new-channel-roster-names">{summary}</span>
            {!searching && <ChevronDown aria-hidden="true" className="new-channel-roster-chevron" size={13} strokeWidth={1.7} />}
          </button>
        )}
        {rosterOpen && (
          <div
            aria-label="Participants in this channel"
            className="new-channel-popover new-channel-roster-list"
            ref={rosterListRef}
            role="group"
          >
            {everyone.map((member) => (
              <div className={clsx('new-channel-popover-row', isInvitee(member) && 'is-invited')} key={member.id}>
                <Avatar member={member} size="small" />
                <span className="new-channel-popover-name">{member.name}</span>
                {isInvitee(member) && <span className="new-channel-popover-kind">Invited</span>}
                {member.id !== creator.id && (
                  <button
                    aria-label={`Remove ${member.name}`}
                    className="new-channel-popover-remove"
                    onClick={() => onRemove(member.id)}
                    type="button"
                  >
                    <X aria-hidden="true" size={13} strokeWidth={1.7} />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
