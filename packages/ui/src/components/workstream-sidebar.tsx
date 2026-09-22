import * as ContextMenu from '@radix-ui/react-context-menu';
import { SidekickSection, type SidekickRow, type SidekickSectionFailure } from './sidekick-section';
import { Archive, Copy, GitBranch, Globe2, Pencil, UserPlus } from 'lucide-react';
import { IconCornerDownRight, IconShare2 } from '@tabler/icons-react';
import { useLayoutEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import type { SidebarPresentation } from '../lib/types';
import { COLLAPSED_SIDEBAR_WIDTH, DEFAULT_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH, MIN_SIDEBAR_WIDTH, SIDEBAR_COLLAPSE_DRAG_THRESHOLD, SIDEBAR_CONTENT_MIN_WIDTH, SIDEBAR_EXPAND_DRAG_THRESHOLD } from '../lib/sidebar-geometry';
import { AvatarStack, Tip, TitleSkeleton } from './primitives';
import {
  ResizableSidebar,
  SidebarCollapseFooter,
  SidebarHorizontalLine,
  SidebarList,
  SidebarRow,
  SidebarScroll,
  SidebarTitleHeader,
} from './resizable-sidebar';
export const PENDING_SUBSTREAM_DRAFT_ID = 'new';
import { ResourceIcon } from './resource-icon';
import { WorkstreamMark } from './workstream-glyph';
import { SidebarNavigationRowContent } from './navigation';
import { compareAlphabeticalTitle } from '../lib/alphabetical';
import { ConversationIdentityTip } from './conversation-identity-tip';

const COLLAPSED_KEY = 'rally.workstream-sidebar-collapsed';
const WIDTH_KEY = 'rally.workstream-sidebar-width';
const clampWidth = (width: number): number => Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, width));

/**
 * The persisted and pane-constrained geometry shared by every Channel sidebar
 * state, including the opening skeleton shown before Channel data arrives.
 */
export function useWorkstreamSidebarGeometry(): {
  compact: boolean;
  constrained: boolean;
  onResize: (requested: number) => void;
  onToggle: () => void;
  sidebarRef: React.RefObject<HTMLElement | null>;
  width: number;
} {
  const sidebarRef = useRef<HTMLElement>(null);
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem(COLLAPSED_KEY) === 'true'; } catch { return false; }
  });
  const [storedWidth, setStoredWidth] = useState(() => {
    try {
      const stored = Number.parseFloat(localStorage.getItem(WIDTH_KEY) ?? '');
      return Number.isFinite(stored) ? clampWidth(stored) : DEFAULT_SIDEBAR_WIDTH;
    } catch { return DEFAULT_SIDEBAR_WIDTH; }
  });
  const [paneWidth, setPaneWidth] = useState(Number.POSITIVE_INFINITY);
  // Observe the available pane, never this sidebar or the transcript. Its
  // width does not change when this rail collapses, avoiding resize feedback.
  useLayoutEffect(() => {
    const pane = sidebarRef.current?.parentElement;
    if (!pane) return;
    const update = (): void => setPaneWidth(pane.clientWidth);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(pane);
    return () => observer.disconnect();
  }, []);
  const constrained = paneWidth < storedWidth + SIDEBAR_CONTENT_MIN_WIDTH;
  const compact = collapsed || constrained;
  const width = compact ? COLLAPSED_SIDEBAR_WIDTH : storedWidth;
  useLayoutEffect(() => {
    const shell = sidebarRef.current?.closest<HTMLElement>('.workspace-shell');
    shell?.style.setProperty('--workstream-sidebar-width', `${width}px`);
    return () => { shell?.style.removeProperty('--workstream-sidebar-width'); };
  }, [width]);
  const saveCollapsed = (next: boolean): void => {
    setCollapsed(next);
    try { localStorage.setItem(COLLAPSED_KEY, String(next)); } catch { /* Best-effort device preference. */ }
  };
  const onResize = (requested: number): void => {
    const available = paneWidth - SIDEBAR_CONTENT_MIN_WIDTH;
    if (compact && (requested < SIDEBAR_EXPAND_DRAG_THRESHOLD || available < MIN_SIDEBAR_WIDTH)) return;
    if (!compact && requested < SIDEBAR_COLLAPSE_DRAG_THRESHOLD) {
      saveCollapsed(true);
      return;
    }
    if (available < MIN_SIDEBAR_WIDTH) return;
    const next = clampWidth(Math.min(requested, available));
    setStoredWidth(next);
    saveCollapsed(false);
    try { localStorage.setItem(WIDTH_KEY, String(next)); } catch { /* Best-effort device preference. */ }
  };
  return {
    compact,
    constrained,
    onResize,
    onToggle: () => saveCollapsed(!collapsed),
    sidebarRef,
    width,
  };
}

export interface ConversationRowTarget { substreamId: string; title: string }

export interface ConversationRowActions {
  onMakePublic?: (() => void) | undefined;
  publicDisabled?: boolean | undefined;
  onCopyLink?: ((target: ConversationRowTarget) => void) | undefined;
  onRename?: (target: ConversationRowTarget) => void;
  onShare?: (target: ConversationRowTarget) => void;
  onArchive?: (target: ConversationRowTarget) => void;
}

function ConversationRowMenu({ actions, children, icon, target }: {
  actions: ConversationRowActions | undefined;
  children: React.ReactNode;
  icon: React.ReactNode;
  target: ConversationRowTarget;
}): React.JSX.Element {
  const main = target.substreamId === '0';
  const preview = (trigger: React.ReactNode): React.JSX.Element => <ConversationIdentityTip
    icon={icon}
    name={target.title}
    side="right"
  >
    {trigger}
  </ConversationIdentityTip>;
  if (!actions) return preview(children);
  return <ContextMenu.Root>
    {preview(<ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>)}
    <ContextMenu.Portal>
      <ContextMenu.Content className="menu-content sidebar-context-menu" collisionPadding={8}>
        {actions.onMakePublic && <ContextMenu.Item className="menu-item" disabled={actions.publicDisabled} onSelect={actions.onMakePublic}>
          <Globe2 aria-hidden="true" size={16} /> Make public to organization
        </ContextMenu.Item>}
        {actions.onRename && <ContextMenu.Item className="menu-item" onSelect={() => actions.onRename?.(target)}>
          <Pencil aria-hidden="true" size={16} /> Rename
        </ContextMenu.Item>}
        {actions.onShare && <ContextMenu.Item className="menu-item" onSelect={() => actions.onShare?.(target)}>
          <IconShare2 aria-hidden="true" size={16} stroke={1.8} /> Share
        </ContextMenu.Item>}
        {actions.onCopyLink && <ContextMenu.Item className="menu-item" onSelect={() => actions.onCopyLink?.(target)}>
          <Copy aria-hidden="true" size={16} /> {main ? 'Copy channel link' : 'Copy breakout link'}
        </ContextMenu.Item>}
        {actions.onArchive && <><ContextMenu.Separator className="menu-separator" />
        <ContextMenu.Item className="menu-item menu-item-danger" onSelect={() => actions.onArchive?.(target)}>
          <Archive aria-hidden="true" size={16} /> {main ? 'Archive channel' : 'Archive breakout'}
        </ContextMenu.Item></>}
      </ContextMenu.Content>
    </ContextMenu.Portal>
  </ContextMenu.Root>;
}

/** Work-stream navigation only: no second resource query or substream model. */
export function WorkstreamSidebar({ mainVisible = true, onOpenSidekick, onSidekickMenuOpen, onRefreshSidekicks, onOpenResource, workstream, creatingSubstream = null, presentUserIds, selectedSubstreamId = '0', onSelectSubstream, onNewSubstream, onOpenArtifact, onParticipants, onFocusTranscript, sidekicks, sidekickFailure, addSidekick, substreamActions, mainActions }: {
  workstream: SidebarPresentation;
  onOpenResource?: (id: string, returnFocus: HTMLElement) => void;
  mainVisible?: boolean; onOpenSidekick?: (id: string) => void; onSidekickMenuOpen?: () => void;
  /**
   * A substream is being created in this work stream: the composer has been
   * submitted and creation is in flight. The rail draws the row it is about to
   * have, so the conversation on screen is one the rail shows — the same
   * promise every other conversation in it keeps.
   *
   * `reservedSubstreamId` is the child preparation reserved, once it has
   * answered with one, and it is how the placeholder gets out of the way: the
   * child is published to this rail from inside the confirmation, so the
   * directory can carry its real row while creation is still in flight, and a
   * placeholder that only watched `launching` would stand beside it. Null until
   * preparation answers, when nothing can be listed yet.
   */
  creatingSubstream?: { reservedSubstreamId: string | null } | null;
  presentUserIds: readonly string[];
  /**
   * This work stream's Sidekicks — the ones it owns and the ones its
   * conversation has loaded — or `undefined` while that answer is still on its
   * way. The section keeps its heading in both the pending and empty states;
   * only the rows wait for an authoritative answer.
   */
  sidekicks?: SidekickRow[] | undefined;
  sidekickFailure?: SidekickSectionFailure | undefined;
  onRefreshSidekicks?: (() => void) | undefined;
  addSidekick?: React.ReactNode;
  selectedSubstreamId?: string;
  onSelectSubstream?: (substreamId: string) => void;
  onNewSubstream?: () => void;
  onOpenArtifact: (id: string, returnFocus: HTMLElement) => void;
  onParticipants: () => void;
  onFocusTranscript: () => void;
  substreamActions?: ConversationRowActions | undefined;
  mainActions?: ConversationRowActions | undefined;
}): React.JSX.Element {
  const {
    compact,
    constrained,
    onResize,
    onToggle,
    sidebarRef,
    width,
  } = useWorkstreamSidebarGeometry();
  const artifacts = workstream.resources.filter((resource) => resource.direction === 'artifact');
  /**
   * The substream being created, once it has a row of its own here.
   *
   * A child is published to this rail from inside its confirmation, so the
   * directory can carry its real row while creation is still in flight — and
   * one conversation with two rows is the thing this list must never show. The
   * reserved id is what tells the two apart; without it there is nothing listed
   * to collide with.
   */
  const reserved = creatingSubstream?.reservedSubstreamId ?? null;
  const publishedReserved = reserved !== null
    && (workstream.privateChildren?.some((child) => child.substreamId === reserved) ?? false)
    ? reserved
    : null;
  /** A row is owed to a substream that has none yet. */
  const pendingSubstream = creatingSubstream !== null && publishedReserved === null;
  /**
   * The row the reader is on, which during a creation is the substream being
   * created — the launch surface is already showing that conversation's opening
   * turn, and the route follows a tick later, when the response lands.
   */
  const currentSubstreamId = publishedReserved ?? selectedSubstreamId;
  const orderedChildren = workstream.privateChildren === undefined
    ? undefined
    : [...workstream.privateChildren].sort(compareAlphabeticalTitle);
  return (
    <ResizableSidebar
      aria-label="Channel sidebar"
      className="workstream-context-sidebar"
      compact={compact}
      constrained={constrained}
      onResize={onResize}
      onToggle={onToggle}
      resizeLabel="Resize channel sidebar"
      sidebarRef={sidebarRef}
      style={{ flexBasis: width }}
      width={width}
    >
      <SidebarTitleHeader
        className="workstream-context-toolbar window-drag"
        icon={<WorkstreamMark appearance={workstream.appearance} id={workstream.id} size={20} />}
        title={workstream.title}
      />
      <SidebarScroll className="workstream-context-scroll">
        <SidebarList className="workstream-conversation-list">
        {mainVisible && <ConversationRowMenu actions={mainActions}
          icon={<WorkstreamMark appearance={workstream.appearance} id={workstream.id} size={16} />}
          target={{ substreamId: '0', title: workstream.title }}>
          <SidebarRow
            className={clsx('workstream-context-row workstream-conversation-row', currentSubstreamId === '0' && 'is-current')}
            aria-current={currentSubstreamId === '0' ? 'page' : undefined}
            aria-label={`Go to conversation: ${workstream.title}`}
            aria-description={workstream.scope === undefined ? undefined : workstream.scope === 'workspace' ? 'Public channel' : 'Private channel'}
            badge={{ count: workstream.needsAttention ? 1 : 0, label: `Main conversation needs attention in ${workstream.title}` }}
            type="button"
            onClick={() => { onSelectSubstream?.('0'); onFocusTranscript(); }}
          >
            <SidebarNavigationRowContent
              activity={workstream.scope === undefined ? undefined : workstream.scope === 'workspace' ? 'Public channel' : 'Private channel'}
              icon={<WorkstreamMark appearance={workstream.appearance} id={workstream.id} />}
              title={workstream.title}
            />
          </SidebarRow>
        </ConversationRowMenu>}
          {orderedChildren?.map((child) => {
            const row = (
              <SidebarRow
                aria-current={currentSubstreamId === child.substreamId ? 'page' : undefined}
                aria-label={`Go to breakout: ${child.title}`}
                aria-description={child.scope === undefined ? undefined : child.scope === 'workspace' ? 'Public breakout' : 'Private breakout'}
                badge={{ count: child.needsAttention ? 1 : 0, label: `Breakout ${child.title} needs attention` }}
                className={clsx(
                  'workstream-context-row workstream-conversation-row',
                  currentSubstreamId === child.substreamId && 'is-current',
                )}
                onClick={() => onSelectSubstream?.(child.substreamId)}
                type="button"
              >
                <SidebarNavigationRowContent
                  activity={child.scope === undefined ? undefined : child.scope === 'workspace' ? 'Public breakout' : 'Private breakout'}
                  icon={<WorkstreamMark appearance={child.appearance} id={child.substreamId} size={20} />}
                  title={child.title}
                />
              </SidebarRow>
            );
            return <ConversationRowMenu actions={substreamActions} icon={<WorkstreamMark appearance={child.appearance} id={child.substreamId} size={16} />} key={child.substreamId} target={{ substreamId: child.substreamId, title: child.title }}>{row}</ConversationRowMenu>;
          })}
          {pendingSubstream && (
            /* An unpublished creation has no derived title to alphabetize, so
               it deliberately follows every named Breakout and precedes New
               breakout. Once published, it joins the alphabetical rows. It is
               not a button — there is nowhere to go, the reader is already on
               the surface this row stands for — and it carries the skeleton
               rather than the first line of the message, because the title is
               the server's to derive and a second answer to what a first line
               is would disagree the moment either changed. It carries the
               same `title` its siblings do, because compact leaves nothing but
               a mark and hovering it is how a reader asks what a row is. */
            <SidebarRow
              as="div"
              aria-current={currentSubstreamId === PENDING_SUBSTREAM_DRAFT_ID ? 'page' : undefined}
              className={clsx(
                'workstream-context-row workstream-conversation-row workstream-pending-substream',
                currentSubstreamId === PENDING_SUBSTREAM_DRAFT_ID && 'is-current',
              )}
              title="Rally is creating this breakout"
            >
              <SidebarNavigationRowContent
                icon={<GitBranch className="workstream-breakout-icon" size={20} strokeWidth={1.7} />}
                title={<span aria-hidden="true"><TitleSkeleton /></span>}
              />
              {/* The row's name, and outside the copy below on purpose: compact
                  hides that element with `visibility: hidden`, which takes
                  everything inside it out of the accessibility tree as well as
                  off the screen. Every other row survives that because its name
                  is an `aria-label` on the button; this one has no button to
                  carry one, so the text sits on the row itself. */}
              <span className="sr-only">Rally is creating this breakout</span>
            </SidebarRow>
          )}
          {onNewSubstream && (
            // Current while a substream is being written, because that surface
            // is where the reader is: the row it was opened from is the one
            // thing on screen that still says so. Once it has been submitted
            // the row above says it instead — this one is back to being what
            // starts the next substream.
            <Tip describesTrigger={false} label="New breakout" side="right">
            <SidebarRow
              aria-current={currentSubstreamId === PENDING_SUBSTREAM_DRAFT_ID && !pendingSubstream ? 'page' : undefined}
              aria-label="New breakout"
              className={clsx(
                'workstream-context-row workstream-new-substream',
                currentSubstreamId === PENDING_SUBSTREAM_DRAFT_ID && !pendingSubstream && 'is-current',
              )}
              onClick={onNewSubstream}
              title="New breakout"
              type="button"
            >
              <SidebarNavigationRowContent
                icon={<IconCornerDownRight className="workstream-new-breakout-icon" size={21} stroke={1.7} />}
                title="New breakout"
              />
            </SidebarRow>
            </Tip>
          )}
        </SidebarList>
        {/* Absent rather than empty, as the Sidekick strip below is: a heading
            over a placeholder row spends the rail's height saying a work
            stream has produced nothing yet, which is the ordinary state of a
            conversation that has only just started. */}
        <ResourceSection label="Artifacts" resources={artifacts} onOpen={onOpenArtifact} />
        {onOpenResource && <ResourceSection label="Resources" resources={workstream.resources.filter((item) => item.direction !== 'artifact')} onOpen={onOpenResource} />}
        <section aria-label="Channel participants" className="workstream-context-section">
          <SidebarHorizontalLine />
          <h2>Participants</h2>
          <Tip describesTrigger={false} label="Participants" side="right">
            <SidebarRow className="workstream-context-row" aria-label="Manage channel participants" aria-description={workstream.participants.map((person) => person.name).join(', ')} type="button" onClick={onParticipants}>
              {workstream.participants.length ? <AvatarStack members={workstream.participants} limit={compact ? 2 : 4} presentUserIds={presentUserIds} showTooltip={false} /> : <UserPlus aria-hidden="true" size={18} />}
            </SidebarRow>
          </Tip>
        </section>
        {/* Below the people, because a Sidekick is the other kind of thing
            working in this room. */}
        <SidekickSection items={sidekicks} failure={sidekickFailure} onOpen={onOpenSidekick} onMenuOpen={onSidekickMenuOpen} onRefresh={onRefreshSidekicks} />
        {addSidekick}
      </SidebarScroll>
      <SidebarCollapseFooter
        collapseLabel="Collapse channel"
        compact={compact}
        constrained={constrained}
        constrainedTitle="Widen the window to expand channel"
        expandLabel="Expand channel"
        onToggle={onToggle}
      />
    </ResizableSidebar>
  );
}

function ResourceSection({ label, resources, onOpen }: { label: string; resources: SidebarPresentation['resources']; onOpen: (id: string, returnFocus: HTMLElement) => void }): React.JSX.Element | null {
  if (!resources.length) return null;
  return <section aria-label={label} className="workstream-context-section"><SidebarHorizontalLine /><h2>{label}</h2>
    {/* The rail owns its tooltip: native title uses a different delay and
        never appears for someone reaching the row with the keyboard. */}
    {resources.map((resource) => <Tip key={resource.id} label={resource.title} side="right">
      <SidebarRow className="workstream-context-row" aria-label={`Open ${resource.title}`} type="button" onClick={(event) => onOpen(resource.id, event.currentTarget)}>
        <SidebarNavigationRowContent
          activity={`${resource.resourceType.replaceAll('_', ' ')} · v${resource.currentVersion}`}
          icon={<ResourceIcon resource={resource} />}
          title={resource.title}
        />
      </SidebarRow></Tip>)}
  </section>;
}
