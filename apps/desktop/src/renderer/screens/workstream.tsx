import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { IconAugmentedReality } from '@tabler/icons-react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useVirtualizer } from '@tanstack/react-virtual';
import clsx from 'clsx';
import {
  Activity,
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Bot,
  CalendarClock,
  Copy,
  Ellipsis,
  FileText,
  FileUp,
  Info,
  LoaderCircle,
  Mail,
  Menu,
  PanelRight,
  Plus,
  Radio,
  RefreshCcw,
  Search,
  UserPlus,
  Zap,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { DesktopSession } from '../../common/desktop';
import { useAppSession } from '../lib/app-session';
import { backgroundTasksFromMessages, messagesWithTransientBlocks, type MentionIdentity } from '../lib/api';
import { answerElicitationOptimistically } from '../lib/elicitation';
import { formatDateTime } from '../lib/format';
import { desktopBridge } from '../lib/platform';
import { createTextMessage } from '../lib/transcript';
import { useFileAttachments } from '../lib/use-file-attachments';
import { useFileDrop } from '../lib/use-file-drop';
import { useUiStore } from '../lib/ui-store';
import { insertMessage, mergeCanonicalTranscript, nextTranscriptSequence, useWorkstreamSocket } from '../lib/use-workstream-socket';
import type { BackgroundTask, ElicitationData, HarnessRunMetadata, HarnessStatus, HyperSight, HyperSightPreference, Message, WorkspaceMember, WorkstreamConnection, WorkstreamDetail, WorkstreamResource, WorkstreamSummary } from '../lib/types';
import { AgentWorkTiming, type AgentWorkTimingProps } from '../components/agent-work-timing';
import { InspectorRail } from '../components/inspector-rail';
import { type AttachmentPreview, AttachmentLightbox } from '../components/attachments';
import { Avatar, AvatarStack, Badge, Button, EmptyState, IconButton, InlineError, LoadingState, Modal, OpeningState, SocketStatusIndicator, StatusDot } from '../components/primitives';
import { MessageBlock } from '../components/workstream-blocks';
import { WorkstreamComposer } from '../components/workstream-composer';
import { HyperSightPanel, HyperSightResizeHandle } from '../components/hypersight-panel';

export function workspaceMemberFromSession(session: DesktopSession | null): WorkspaceMember | undefined {
  if (!session?.workspace) return undefined;
  return {
    id: session.user.id,
    name: session.user.name,
    email: session.user.email,
    timezone: session.user.timezone ?? 'America/Los_Angeles',
    ...(session.user.avatarUrl ? { avatarUrl: session.user.avatarUrl } : {}),
    role: session.workspace.role,
  };
}

export function mergeBackgroundTasks(persisted: BackgroundTask[], live: BackgroundTask[]): BackgroundTask[] {
  return [...new Map([...persisted, ...live].map((task) => [task.id, task])).values()]
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt));
}

export function workstreamRunTiming(
  status: HarnessStatus,
  run: HarnessRunMetadata | undefined,
  now = Date.now(),
): AgentWorkTimingProps | null {
  if (!run || status === 'scheduled' || status === 'needs_input') return null;
  const startedAt = Date.parse(run.startedAt ?? run.createdAt);
  if (!Number.isFinite(startedAt)) return null;
  if (status === 'running') return { active: true, durationMs: 0, startedAt };
  const canonicalCompletedAt = run.completedAt ? Date.parse(run.completedAt) : Number.NaN;
  const completedAt = Number.isFinite(canonicalCompletedAt) ? canonicalCompletedAt : now;
  return { active: false, durationMs: Math.max(0, completedAt - startedAt) };
}

export function manualElicitationResponse(
  elicitation: ElicitationData,
  text: string,
): { answer: string | string[]; customResponse?: string } {
  const customResponse = text.trim();
  if (elicitation.responseType === 'text') return { answer: customResponse };
  if (elicitation.responseType === 'multi_select') return { answer: [customResponse], customResponse };
  return { answer: customResponse, customResponse };
}

function AddParticipantDialog({
  current,
  members,
  open,
  pending,
  onAdd,
  onOpenChange,
}: {
  current: WorkspaceMember[];
  members: WorkspaceMember[];
  open: boolean;
  pending: boolean;
  onAdd: (member: WorkspaceMember) => void;
  onOpenChange: (open: boolean) => void;
}): React.JSX.Element {
  const currentIds = new Set(current.map((member) => member.id));
  const available = members.filter((member) => !currentIds.has(member.id));
  return (
    <Modal
      description="Opening or viewing never adds someone as a participant. Add them explicitly here."
      onOpenChange={onOpenChange}
      open={open}
      title="Add a participant"
    >
      {available.length === 0 ? (
        <EmptyState title="Everyone is already here" description="There are no other workspace members to add." />
      ) : (
        <div className="member-action-list">
          {available.map((member) => (
            <button disabled={pending} key={member.id} onClick={() => onAdd(member)} type="button">
              <Avatar member={member} size="medium" />
              <span><strong>{member.name}</strong><small>{member.email}</small></span>
              {pending ? <LoaderCircle className="spin" size={15} /> : <Plus size={15} />}
            </button>
          ))}
        </div>
      )}
    </Modal>
  );
}

function readableResourceKind(value: string): string {
  return value.replace(/[_-]+/gu, ' ').replace(/\b\w/gu, (letter) => letter.toLocaleUpperCase());
}

export function AddResourceDialog({
  current,
  resources,
  open,
  pending,
  loading,
  fetching,
  error,
  search,
  hasMore,
  onAttach,
  onLoadMore,
  onOpenChange,
  onSearchChange,
  onUpload,
}: {
  current: WorkstreamResource[];
  resources: WorkstreamResource[];
  open: boolean;
  pending: boolean;
  loading: boolean;
  fetching: boolean;
  error?: string | undefined;
  search: string;
  hasMore: boolean;
  onAttach: (resource: WorkstreamResource) => void;
  onLoadMore: () => void;
  onOpenChange: (open: boolean) => void;
  onSearchChange: (value: string) => void;
  onUpload: () => void;
}): React.JSX.Element {
  const currentIds = new Set(current.map((resource) => resource.id));
  const available = resources.filter((resource) => !currentIds.has(resource.id));
  return (
    <Modal
      description="Attach a resource discovered through a connector, or upload a file from this Mac."
      footer={(
        <>
          <Button className="resource-upload-button" disabled={pending} onClick={onUpload}>
            <FileUp aria-hidden="true" size={14} /> Upload file
          </Button>
          {hasMore && (
            <Button disabled={fetching || pending} onClick={onLoadMore}>
              {fetching ? <LoaderCircle aria-hidden="true" className="spin" size={14} /> : null}
              Load more
            </Button>
          )}
        </>
      )}
      onOpenChange={onOpenChange}
      open={open}
      title="Add a resource"
    >
      <div className="resource-picker">
        <label className="resource-search">
          <Search aria-hidden="true" size={14} />
          <input
            aria-label="Search resources"
            autoFocus
            onChange={(event) => onSearchChange(event.currentTarget.value)}
            placeholder="Search repositories, files, issues, and pull requests"
            type="search"
            value={search}
          />
        </label>
        {error ? <InlineError>{error}</InlineError> : null}
        {loading ? (
          <LoadingState label="Finding resources…" />
        ) : available.length === 0 ? (
          <EmptyState
            title={search ? 'No matching resources' : 'No connector resources yet'}
            description={search ? 'Try a different search, or upload a file.' : 'Resources discovered by connected services will appear here.'}
          />
        ) : (
          <div className="resource-picker-list">
            {available.map((resource) => (
              <button
                disabled={pending}
                key={resource.id}
                onClick={() => onAttach(resource)}
                type="button"
              >
                <span aria-hidden="true" className="resource-picker-icon"><FileText size={15} /></span>
                <span className="resource-picker-copy">
                  <strong>{resource.title}</strong>
                  <small>{readableResourceKind(resource.provider ?? 'Avalon')} · {readableResourceKind(resource.resourceType)}</small>
                </span>
                {pending ? <LoaderCircle aria-hidden="true" className="spin" size={15} /> : <Plus aria-hidden="true" size={15} />}
              </button>
            ))}
          </div>
        )}
      </div>
    </Modal>
  );
}

function WorkstreamHeader({
  workstream,
  socketState,
  hypersightOpen,
  hypersightPreferencePending,
  onAddParticipant,
  onToggleHyperSight,
}: {
  workstream: WorkstreamDetail;
  socketState: ReturnType<typeof useWorkstreamSocket>;
  hypersightOpen: boolean;
  hypersightPreferencePending: boolean;
  onAddParticipant: () => void;
  onToggleHyperSight: () => void;
}): React.JSX.Element {
  const openRail = useUiStore((state) => state.openRail);
  const setSidebarOpen = useUiStore((state) => state.setSidebarOpen);
  const copyLink = (): void => {
    void desktopBridge().copyText(`avalon://workstreams/${workstream.id}`);
  };
  const copyEmailAddress = (): void => {
    if (workstream.emailAddress) void desktopBridge().copyText(workstream.emailAddress);
  };
  const runningTasks = workstream.backgroundTasks.filter((task) => task.status === 'running').length;

  return (
    <header className="workstream-header window-drag">
      <div className="workstream-header-left window-no-drag">
        <IconButton className="header-menu-button" label="Open navigation" onClick={() => setSidebarOpen(true)}><Menu size={16} /></IconButton>
        <span className="header-origin-icon" aria-hidden="true">{workstream.origin === 'automation' ? <Zap size={14} /> : <Bot size={14} />}</span>
        <div className="workstream-title-block">
          <div className="workstream-title-line">
            <h1>{workstream.title}</h1>
            {workstream.origin === 'automation' && <Badge>{workstream.automationName ?? 'Automation'}</Badge>}
          </div>
          <div className="workstream-subtitle">
            <StatusDot status={workstream.harnessStatus} />
            {workstream.plannedFor && <span><CalendarClock size={11} /> {formatDateTime(workstream.plannedFor)}</span>}
          </div>
        </div>
      </div>
      <div className="workstream-header-actions window-no-drag">
        <SocketStatusIndicator state={socketState} />
        <IconButton
          className={clsx('hypersight-toggle', hypersightOpen && 'is-active')}
          aria-pressed={hypersightOpen}
          disabled={hypersightPreferencePending}
          label={hypersightOpen ? 'Hide HyperSight' : 'Show HyperSight'}
          onClick={onToggleHyperSight}
        >
          <IconAugmentedReality size={16} stroke={1.7} />
        </IconButton>
        <button className="participant-header-button" onClick={onAddParticipant} type="button">
          <AvatarStack members={workstream.participants} />
          <UserPlus aria-hidden="true" size={13} />
          <span className="sr-only">Add participant</span>
        </button>
        <IconButton className="header-background-tasks" label="Background tasks" onClick={() => openRail('background')}>
          <Activity size={15} />
          {runningTasks > 0 && <span className="icon-count">{runningTasks}</span>}
        </IconButton>
        {workstream.origin === 'automation' && (
          <IconButton label="Automation runs" onClick={() => openRail('runs')}><Radio size={15} /></IconButton>
        )}
        <IconButton label="Work-stream context" onClick={() => openRail('context')}><PanelRight size={15} /></IconButton>
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild><IconButton label="More work-stream actions"><Ellipsis size={16} /></IconButton></DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content align="end" className="menu-content" sideOffset={8}>
              <DropdownMenu.Item className="menu-item" onSelect={copyLink}><Copy size={14} /> Copy work-stream link</DropdownMenu.Item>
              {workstream.emailAddress && (
                <DropdownMenu.Item className="menu-item" onSelect={copyEmailAddress}><Mail size={14} /> Copy work-stream email address</DropdownMenu.Item>
              )}
              <DropdownMenu.Item className="menu-item" onSelect={() => void desktopBridge().copyText(workstream.id)}><Info size={14} /> Copy work-stream ID</DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </div>
    </header>
  );
}

export function JumpToLatestButton({ onJump }: { onJump: () => void }): React.JSX.Element {
  return (
    <IconButton className="jump-bottom" label="Jump to latest" onClick={onJump} tooltipSide="top">
      <ArrowDown aria-hidden="true" size={15} />
    </IconButton>
  );
}

export function initialTranscriptAnchorIndex(
  transcript: Message[],
  firstUnreadSequenceNumber: number | null,
): number | null {
  if (firstUnreadSequenceNumber === null) return null;
  const firstUnreadIndex = transcript.findIndex((message) =>
    message.realtimeOrder === undefined && message.sequenceNumber >= firstUnreadSequenceNumber);
  return firstUnreadIndex < 0 ? null : Math.max(0, firstUnreadIndex - 1);
}

export function highestVisibleAttentionSequence(
  transcript: Message[],
  visibleIndexes: number[],
  latestAttentionSequenceNumber: number,
): number {
  return visibleIndexes.reduce((highest, index) => {
    const message = transcript[index];
    if (
      !message
      || message.realtimeOrder !== undefined
      || message.messageType === 'tool_event'
      || message.sequenceNumber > latestAttentionSequenceNumber
    ) return highest;
    return Math.max(highest, message.sequenceNumber);
  }, 0);
}

export function RunFailureNotice({
  code,
  message,
  requestId,
  retrying,
  onCopyRequestId,
  onRetry,
}: {
  code: string;
  message: string;
  requestId?: string;
  retrying: boolean;
  onCopyRequestId: () => void;
  onRetry: () => void;
}): React.JSX.Element {
  return (
    <section aria-label="Run failed" className="run-failure-notice" role="alert">
      <span aria-hidden="true" className="run-failure-icon"><AlertTriangle size={16} /></span>
      <div className="run-failure-copy">
        <strong>Run failed</strong>
        <p>{message}</p>
        <code>{code}</code>
      </div>
      <div className="run-failure-actions">
        {requestId ? (
          <Button onClick={onCopyRequestId}><Copy aria-hidden="true" size={13} /> Copy request ID</Button>
        ) : null}
        <Button className="button-primary" disabled={retrying} onClick={onRetry}>
          {retrying ? <LoaderCircle aria-hidden="true" className="spin" size={13} /> : <RefreshCcw aria-hidden="true" size={13} />}
          Retry
        </Button>
      </div>
    </section>
  );
}

export function WorkstreamScreen(): React.JSX.Element {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const { api, session } = useAppSession();
  const queryClient = useQueryClient();
  const closeRail = useUiStore((state) => state.closeRail);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const [participantDialogOpen, setParticipantDialogOpen] = useState(false);
  const [hypersightHeight, setHyperSightHeight] = useState(280);
  const [resourceDialogOpen, setResourceDialogOpen] = useState(false);
  const [resourceSearch, setResourceSearch] = useState('');
  const [debouncedResourceSearch, setDebouncedResourceSearch] = useState('');
  const [sendError, setSendError] = useState<string | undefined>();
  const [sending, setSending] = useState(false);
  const [atBottom, setAtBottom] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [olderMessagesError, setOlderMessagesError] = useState<string | undefined>();
  const loadingOlderRef = useRef(false);
  const loadingNewerRef = useRef(false);
  const initialPositionedWorkstreamRef = useRef<string | null>(null);
  const readAckTimerRef = useRef<number | null>(null);
  const readAckInFlightRef = useRef<string | null>(null);
  const activeWorkstreamIdRef = useRef(id);
  const reconnectAbortControllerRef = useRef<AbortController | null>(null);
  const pendingSendCount = useRef(0);
  const [attachmentPreview, setAttachmentPreview] = useState<AttachmentPreview | null>(null);
  const attachmentDraft = useFileAttachments(api);
  const transcriptDrop = useFileDrop(attachmentDraft.addFiles);
  const railDrop = useFileDrop(attachmentDraft.addFiles);
  const loadAttachmentContent = useCallback(
    (resourceId: string, signal?: AbortSignal) => api!.getResourceContent(resourceId, signal),
    [api],
  );

  useEffect(() => () => closeRail(), [closeRail, id]);

  useEffect(() => () => {
    reconnectAbortControllerRef.current?.abort();
    reconnectAbortControllerRef.current = null;
  }, [id]);

  useEffect(() => {
    activeWorkstreamIdRef.current = id;
    loadingOlderRef.current = false;
    loadingNewerRef.current = false;
    initialPositionedWorkstreamRef.current = null;
    readAckInFlightRef.current = null;
    if (readAckTimerRef.current !== null) window.clearTimeout(readAckTimerRef.current);
    readAckTimerRef.current = null;
    setLoadingOlder(false);
    setOlderMessagesError(undefined);
  }, [id]);

  useEffect(() => {
    if (!resourceDialogOpen) {
      setDebouncedResourceSearch('');
      return;
    }
    const timeout = window.setTimeout(() => setDebouncedResourceSearch(resourceSearch.trim()), 250);
    return () => window.clearTimeout(timeout);
  }, [resourceDialogOpen, resourceSearch]);

  const workstream = useQuery({
    queryKey: ['workstream', id],
    queryFn: ({ signal }) => api!.getWorkstream(id, signal),
    enabled: Boolean(api && id),
    staleTime: 5_000,
  });
  const messageCursor = useQuery<string | null>({
    queryKey: ['messages-cursor', id],
    queryFn: async () => null,
    enabled: false,
    initialData: null,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const newerMessageCursor = useQuery<string | null>({
    queryKey: ['messages-newer-cursor', id],
    queryFn: async () => null,
    enabled: false,
    initialData: null,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const messages = useQuery({
    queryKey: ['messages', id],
    queryFn: async ({ signal }) => {
      const detail = await queryClient.fetchQuery({
        queryKey: ['workstream', id],
        queryFn: ({ signal: detailSignal }) => api!.getWorkstream(id, detailSignal),
        staleTime: 5_000,
      });
      const page = await api!.getMessagePage(id, {
        ...(detail.firstUnreadSequenceNumber !== null
          ? { around: detail.firstUnreadSequenceNumber }
          : {}),
        signal,
      });
      const previous = queryClient.getQueryData<Message[]>(['messages', id]);
      const pageOldestSequence = page.items.reduce(
        (oldest, message) => Math.min(oldest, message.sequenceNumber),
        Number.POSITIVE_INFINITY,
      );
      const alreadyHasOlderMessages = (previous ?? []).some((message) =>
        message.realtimeOrder === undefined && message.sequenceNumber < pageOldestSequence);
      if (!alreadyHasOlderMessages) {
        queryClient.setQueryData(['messages-cursor', id], page.nextCursor);
      }
      queryClient.setQueryData(['messages-newer-cursor', id], page.newerCursor);
      return mergeCanonicalTranscript(previous, messagesWithTransientBlocks(page.items, detail));
    },
    enabled: Boolean(api && id),
    staleTime: 2_000,
  });
  const deferredContext = useQuery({
    queryKey: ['workstream-context', id, workstream.data?.automationSubscriptionId ?? null],
    queryFn: ({ signal }) => api!.getWorkstreamContext(id, workstream.data?.automationSubscriptionId, signal),
    enabled: Boolean(api && id && workstream.isSuccess && messages.isSuccess),
    staleTime: 5_000,
  });
  const hypersightPreference = useQuery({
    queryKey: ['hypersight-preference', id],
    queryFn: ({ signal }) => api!.getHyperSightPreference(id, signal),
    enabled: Boolean(api && id),
    staleTime: 5_000,
  });
  const hypersightOpen = hypersightPreference.data?.visible ?? false;
  const hypersight = useQuery({
    queryKey: ['hypersight', id],
    queryFn: ({ signal }) => api!.getHyperSight(id, signal),
    enabled: Boolean(api && id && hypersightOpen),
    staleTime: 5_000,
  });
  const members = useQuery({
    queryKey: ['workspace-members'],
    queryFn: ({ signal }) => api!.getWorkspaceMembers(signal),
    enabled: Boolean(api),
    staleTime: 60_000,
  });
  const availableResources = useInfiniteQuery({
    queryKey: ['resources', debouncedResourceSearch],
    queryFn: ({ pageParam, signal }) => api!.listResources({
      ...(debouncedResourceSearch ? { query: debouncedResourceSearch } : {}),
      ...(pageParam ? { cursor: pageParam } : {}),
      limit: 50,
      signal,
    }),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: Boolean(api && resourceDialogOpen),
    staleTime: 15_000,
  });
  const socketState = useWorkstreamSocket(
    api,
    id,
    workstream.isSuccess && messages.isSuccess,
    session?.user.id,
  );
  const transcript = messages.data ?? [];
  const transcriptVirtualizer = useVirtualizer({
    count: transcript.length,
    estimateSize: () => 140,
    getItemKey: (index) => transcript[index]?.id ?? index,
    getScrollElement: () => transcriptRef.current,
    overscan: 8,
  });

  const loadOlderMessages = useCallback(async (): Promise<void> => {
    const before = queryClient.getQueryData<string | null>(['messages-cursor', id]);
    if (!api || !before || loadingOlderRef.current) return;
    loadingOlderRef.current = true;
    setLoadingOlder(true);
    setOlderMessagesError(undefined);
    const scrollElement = transcriptRef.current;
    const previousScrollHeight = scrollElement?.scrollHeight ?? 0;
    const previousScrollTop = scrollElement?.scrollTop ?? 0;
    try {
      const page = await api.getMessagePage(id, { before });
      if (activeWorkstreamIdRef.current !== id) return;
      if (page.nextCursor === before) throw new Error('Avalon received a repeated transcript cursor.');
      queryClient.setQueryData<Message[]>(['messages', id], (current) =>
        page.items.reduce((merged, message) => insertMessage(merged, message), current ?? []));
      queryClient.setQueryData(['messages-cursor', id], page.nextCursor);
      window.requestAnimationFrame(() => {
        const element = transcriptRef.current;
        if (!element) return;
        element.scrollTop = previousScrollTop + Math.max(0, element.scrollHeight - previousScrollHeight);
      });
    } catch (error) {
      setOlderMessagesError(error instanceof Error ? error.message : 'Earlier messages could not be loaded.');
    } finally {
      loadingOlderRef.current = false;
      setLoadingOlder(false);
    }
  }, [api, id, queryClient]);

  const loadNewerMessages = useCallback(async (): Promise<void> => {
    const after = queryClient.getQueryData<string | null>(['messages-newer-cursor', id]);
    if (!api || !after || loadingNewerRef.current) return;
    loadingNewerRef.current = true;
    setOlderMessagesError(undefined);
    try {
      const page = await api.getMessagePage(id, { after });
      if (activeWorkstreamIdRef.current !== id) return;
      if (page.newerCursor === after) throw new Error('Avalon received a repeated transcript cursor.');
      queryClient.setQueryData<Message[]>(['messages', id], (current) =>
        page.items.reduce((merged, message) => insertMessage(merged, message), current ?? []));
      queryClient.setQueryData(['messages-newer-cursor', id], page.newerCursor);
    } catch (error) {
      setOlderMessagesError(error instanceof Error ? error.message : 'Newer messages could not be loaded.');
    } finally {
      loadingNewerRef.current = false;
    }
  }, [api, id, queryClient]);

  const jumpToLatest = useCallback(async (): Promise<void> => {
    if (!api || loadingNewerRef.current) return;
    loadingNewerRef.current = true;
    setOlderMessagesError(undefined);
    try {
      let after = queryClient.getQueryData<string | null>(['messages-newer-cursor', id]);
      while (after) {
        const page = await api.getMessagePage(id, { after });
        if (activeWorkstreamIdRef.current !== id) return;
        if (page.newerCursor === after) throw new Error('Avalon received a repeated transcript cursor.');
        queryClient.setQueryData<Message[]>(['messages', id], (current) =>
          page.items.reduce((merged, message) => insertMessage(merged, message), current ?? []));
        after = page.newerCursor;
        queryClient.setQueryData(['messages-newer-cursor', id], after);
      }
      setAtBottom(true);
      window.requestAnimationFrame(() => {
        const current = queryClient.getQueryData<Message[]>(['messages', id]) ?? [];
        transcriptVirtualizer.scrollToIndex(Math.max(0, current.length - 1), { align: 'end', behavior: 'smooth' });
      });
    } catch (error) {
      setOlderMessagesError(error instanceof Error ? error.message : 'The latest messages could not be loaded.');
    } finally {
      loadingNewerRef.current = false;
    }
  }, [api, id, queryClient, transcriptVirtualizer]);

  const addParticipant = useMutation({
    mutationFn: (member: WorkspaceMember) => api!.addParticipant(id, member.id),
    onSuccess: (updated) => {
      queryClient.setQueryData(['workstream', id], updated);
      setParticipantDialogOpen(false);
    },
  });

  const attachResource = useMutation({
    mutationFn: (resource: WorkstreamResource) => api!.attachResource(id, resource.id),
    onSuccess: (updated) => {
      queryClient.setQueryData(['workstream', id], updated);
      setResourceDialogOpen(false);
      setResourceSearch('');
    },
  });

  const updateHyperSight = useMutation({
    mutationFn: (blocks: Array<{ id: string; prompt: string }>) => {
      const current = queryClient.getQueryData<HyperSight>(['hypersight', id]) ?? hypersight.data;
      if (!current) throw new Error('HyperSight is not ready yet.');
      return api!.updateHyperSight(id, {
        expectedVersionNumber: current.versionNumber,
        blocks,
      });
    },
    onSuccess: (updated) => {
      queryClient.setQueryData(['hypersight', id], updated);
    },
    onError: () => {
      void queryClient.invalidateQueries({ queryKey: ['hypersight', id], exact: true });
    },
  });

  const updateHyperSightPreference = useMutation({
    mutationFn: (visible: boolean) => api!.updateHyperSightPreference(id, visible),
    onMutate: async (visible) => {
      await queryClient.cancelQueries({ queryKey: ['hypersight-preference', id], exact: true });
      const previous = queryClient.getQueryData<HyperSightPreference>(['hypersight-preference', id]);
      queryClient.setQueryData<HyperSightPreference>(['hypersight-preference', id], {
        visible,
        updatedAt: previous?.updatedAt ?? null,
      });
      return { previous };
    },
    onError: (_error, _visible, context) => {
      queryClient.setQueryData(['hypersight-preference', id], context?.previous);
    },
    onSuccess: (preference) => {
      queryClient.setQueryData(['hypersight-preference', id], preference);
    },
  });

  const stop = useMutation({
    mutationFn: () => api!.stopHarness(id),
    onSuccess: () => void Promise.all([
      workstream.refetch(),
      queryClient.invalidateQueries({ queryKey: ['workstream-context', id] }),
    ]),
  });

  const retry = useMutation({
    mutationFn: () => api!.retryHarness(id),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['workstream', id], exact: true }),
        queryClient.invalidateQueries({ queryKey: ['messages', id], exact: true }),
        queryClient.invalidateQueries({ queryKey: ['workstreams'] }),
        queryClient.invalidateQueries({ queryKey: ['workstream-context', id] }),
      ]);
    },
  });

  const reconnect = useMutation({
    mutationFn: async (connection: WorkstreamConnection) => {
      reconnectAbortControllerRef.current?.abort();
      const controller = new AbortController();
      reconnectAbortControllerRef.current = controller;
      try {
        const authorization = await api!.reconnectConnection(connection.id);
        await desktopBridge().openExternal(authorization.url);
        const attempt = await api!.waitForConnectorOAuthAttempt(authorization.attemptId, controller.signal);
        if (attempt.status !== 'succeeded') {
          throw new Error(
            attempt.status === 'denied'
              ? 'Connector authorization was cancelled.'
              : 'The connector could not be reconnected. Try again.',
          );
        }
      } finally {
        if (reconnectAbortControllerRef.current === controller) reconnectAbortControllerRef.current = null;
      }
    },
    onSuccess: () => void Promise.all([
      queryClient.invalidateQueries({ queryKey: ['workstream', id], exact: true }),
      queryClient.invalidateQueries({ queryKey: ['workstream-context', id] }),
      queryClient.invalidateQueries({ queryKey: ['automation'] }),
    ]),
  });

  const watchResource = useMutation({
    mutationFn: ({ resource, enabled }: { resource: WorkstreamResource; enabled: boolean }) =>
      api!.setResourceWatch(id, resource.id, enabled),
    onMutate: async ({ resource, enabled }) => {
      await queryClient.cancelQueries({ queryKey: ['workstream', id], exact: true });
      const previous = queryClient.getQueryData<WorkstreamDetail>(['workstream', id]);
      queryClient.setQueryData<WorkstreamDetail>(['workstream', id], (current) => current ? {
        ...current,
        resources: current.resources.map((item) => item.id === resource.id ? {
          ...item,
          watchEnabled: enabled,
          watchStatus: enabled ? 'watching' : 'paused',
        } : item),
      } : current);
      return { previous };
    },
    onError: (_error, _variables, context) => {
      if (context?.previous) queryClient.setQueryData(['workstream', id], context.previous);
    },
    onSuccess: (result, { resource, enabled }) => {
      queryClient.setQueryData<WorkstreamDetail>(['workstream', id], (current) => current ? {
        ...current,
        resources: current.resources.map((item) => item.id === resource.id ? {
          ...item,
          watchEnabled: result.enabled,
          watchStatus: result.enabled ? 'watching' : enabled ? 'error' : 'paused',
        } : item),
      } : current);
    },
  });

  const detachResource = useMutation({
    mutationFn: (resource: WorkstreamResource) => api!.detachResource(id, resource.id),
    onSuccess: (_result, resource) => {
      queryClient.setQueryData<WorkstreamDetail>(['workstream', id], (current) => current ? {
        ...current,
        resources: current.resources.filter((item) => item.id !== resource.id),
      } : current);
    },
  });

  const activeElicitation = (messages.data ?? []).find((message) =>
    message.messageType === 'elicitation' && message.elicitation?.status === 'open')?.elicitation;

  const answerElicitation = async (
    elicitationId: string,
    answer: string | string[] | null,
    customResponse?: string,
  ): Promise<void> => {
    const previousMessage = queryClient.getQueryData<Message[]>(['messages', id])?.find((message) =>
      message.messageType === 'elicitation' && message.elicitation?.id === elicitationId);
    await answerElicitationOptimistically({
      answer,
      elicitationId,
      previousMessage,
      submit: async () => {
        await api!.answerElicitation(id, elicitationId, answer, customResponse);
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ['messages', id], exact: true }),
          queryClient.invalidateQueries({ queryKey: ['workstream', id], exact: true }),
          queryClient.invalidateQueries({ queryKey: ['workstreams'] }),
          queryClient.invalidateQueries({ queryKey: ['workstream-context', id] }),
        ]);
      },
      updateMessages: (update) => queryClient.setQueryData<Message[]>(['messages', id], (current) =>
        current ? update(current) : current),
    });
  };

  const sendMessage = async (
    text: string,
    mentions: MentionIdentity[],
    confirmedParticipantUserIds: string[] = [],
  ): Promise<void> => {
    if (!api || !workstream.data) throw new Error('This work stream is not ready to receive messages.');
    const readyAttachments = attachmentDraft.ready;
    pendingSendCount.current += 1;
    setSending(true);
    setSendError(undefined);
    if (activeElicitation) {
      const response = manualElicitationResponse(activeElicitation, text);
      try {
        await answerElicitation(activeElicitation.id, response.answer, response.customResponse);
      } catch (error) {
        setSendError(error instanceof Error ? error.message : 'The response could not be sent.');
        throw error;
      } finally {
        pendingSendCount.current = Math.max(0, pendingSendCount.current - 1);
        if (pendingSendCount.current === 0) setSending(false);
      }
      return;
    }
    const clientId = crypto.randomUUID();
    queryClient.setQueryData<Message[]>(['messages', id], (current) => {
      const anchorSequenceNumber = nextTranscriptSequence(current);
      const createdAt = new Date().toISOString();
      const optimistic = createTextMessage({
        id: clientId,
        clientMessageId: clientId,
        workstreamId: id,
        sequenceNumber: anchorSequenceNumber,
        authorType: 'human',
        author: workspaceMemberFromSession(session),
        text,
        attachments: readyAttachments.flatMap((attachment) => attachment.resource ? [{
          id: attachment.resource.id,
          fileName: attachment.file.name,
          mimeType: attachment.file.type || 'application/octet-stream',
          sizeBytes: attachment.file.size,
          contentAvailable: true,
          createdAt,
        }] : []),
        createdAt,
        deliveryState: 'sending',
        realtimeOrder: {
          anchorSequenceNumber,
          eventSequence: Number.MAX_SAFE_INTEGER,
          placement: 'at_anchor',
        },
      });
      return insertMessage(current, optimistic);
    });
    try {
      const created = await api.createMessage(id, {
        text,
        clientId,
        mentions,
        confirmedParticipantUserIds,
        attachmentIds: readyAttachments.flatMap((attachment) => attachment.resource ? [attachment.resource.id] : []),
      });
      queryClient.setQueryData<Message[]>(['messages', id], (current) => insertMessage(current, created));
      attachmentDraft.consume();
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['workstream', id], exact: true }),
        queryClient.invalidateQueries({ queryKey: ['messages', id], exact: true }),
        queryClient.invalidateQueries({ queryKey: ['workstreams'] }),
        queryClient.invalidateQueries({ queryKey: ['workstream-context', id] }),
      ]);
    } catch (error) {
      queryClient.setQueryData<Message[]>(['messages', id], (current) => (current ?? []).filter((message) => message.id !== clientId));
      setSendError(error instanceof Error ? error.message : 'The message could not be sent.');
      throw error;
    } finally {
      pendingSendCount.current = Math.max(0, pendingSendCount.current - 1);
      if (pendingSendCount.current === 0) setSending(false);
    }
  };

  const resolveSuggestion = async (suggestionId: string, action: 'accept' | 'dismiss'): Promise<void> => {
    await api!.resolveActivitySuggestion(id, suggestionId, action);
    await Promise.all([messages.refetch(), workstream.refetch()]);
  };

  useEffect(() => {
    if (!workstream.data || messages.isLoading || initialPositionedWorkstreamRef.current === id) return;
    initialPositionedWorkstreamRef.current = id;
    const anchorSequence = workstream.data.firstUnreadSequenceNumber;
    window.requestAnimationFrame(() => {
      if (activeWorkstreamIdRef.current !== id || transcript.length === 0) return;
      const anchorIndex = initialTranscriptAnchorIndex(transcript, anchorSequence);
      if (anchorIndex !== null) {
        setAtBottom(false);
        transcriptVirtualizer.scrollToIndex(anchorIndex, { align: 'start' });
        return;
      }
      setAtBottom(true);
      transcriptVirtualizer.scrollToIndex(transcript.length - 1, { align: 'end' });
    });
  }, [id, messages.isLoading, transcript, transcriptVirtualizer, workstream.data]);

  const acknowledgeVisibleMessages = useCallback((): void => {
    const detail = queryClient.getQueryData<WorkstreamDetail>(['workstream', id]);
    const element = transcriptRef.current;
    if (!api || !detail || !element || document.visibilityState !== 'visible' || !document.hasFocus()) return;
    if (initialPositionedWorkstreamRef.current !== id) return;
    const viewportTop = element.scrollTop;
    const viewportBottom = viewportTop + element.clientHeight;
    const visibleIndexes = transcriptVirtualizer.getVirtualItems()
      .filter((item) => item.start < viewportBottom && item.end > viewportTop)
      .map((item) => item.index);
    const highestVisibleSequence = highestVisibleAttentionSequence(
      transcript,
      visibleIndexes,
      detail.latestAttentionSequenceNumber,
    );
    if (highestVisibleSequence === 0) return;
    if (
      highestVisibleSequence <= detail.readThroughSequenceNumber
      && detail.manualUnreadFromSequenceNumber === null
    ) return;
    const ackKey = `${id}:${highestVisibleSequence}:${detail.manualUnreadGeneration}`;
    if (readAckInFlightRef.current === ackKey) return;
    readAckInFlightRef.current = ackKey;
    void api.acknowledgeWorkstreamRead(
      id,
      highestVisibleSequence,
      detail.manualUnreadGeneration,
    ).then((updated) => {
      if (activeWorkstreamIdRef.current !== id) return;
      queryClient.setQueryData<WorkstreamDetail>(['workstream', id], (current) =>
        current ? { ...current, ...updated } : current);
      queryClient.setQueryData<WorkstreamSummary[]>(['workstreams'], (current) =>
        current?.map((item) => item.id === id ? { ...item, ...updated } : item));
    }).catch(() => {
      void queryClient.invalidateQueries({ queryKey: ['workstream', id], exact: true });
    }).finally(() => {
      if (readAckInFlightRef.current === ackKey) readAckInFlightRef.current = null;
    });
  }, [api, id, queryClient, transcript, transcriptVirtualizer]);

  const scheduleReadAcknowledgement = useCallback((): void => {
    if (readAckTimerRef.current !== null) window.clearTimeout(readAckTimerRef.current);
    readAckTimerRef.current = window.setTimeout(() => {
      readAckTimerRef.current = null;
      acknowledgeVisibleMessages();
    }, 250);
  }, [acknowledgeVisibleMessages]);

  useEffect(() => {
    scheduleReadAcknowledgement();
  }, [scheduleReadAcknowledgement, transcript.length]);

  useEffect(() => {
    const acknowledgeOnFocus = (): void => scheduleReadAcknowledgement();
    window.addEventListener('focus', acknowledgeOnFocus);
    document.addEventListener('visibilitychange', acknowledgeOnFocus);
    return () => {
      window.removeEventListener('focus', acknowledgeOnFocus);
      document.removeEventListener('visibilitychange', acknowledgeOnFocus);
      if (readAckTimerRef.current !== null) window.clearTimeout(readAckTimerRef.current);
    };
  }, [scheduleReadAcknowledgement]);

  useEffect(() => {
    if (initialPositionedWorkstreamRef.current !== id || !atBottom || newerMessageCursor.data) return;
    if (transcript.length === 0) return;
    requestAnimationFrame(() => transcriptVirtualizer.scrollToIndex(transcript.length - 1, { align: 'end' }));
  }, [atBottom, id, newerMessageCursor.data, transcript, transcriptVirtualizer]);

  if (workstream.isLoading || messages.isLoading) {
    return <OpeningState label="Opening work stream…" />;
  }
  if (workstream.error || messages.error || !workstream.data) {
    return (
      <div className="screen-error-state screen-with-titlebar">
        <div className="screen-drag-strip window-drag" />
        <EmptyState
          action={<Button onClick={() => void Promise.all([workstream.refetch(), messages.refetch()])}><RefreshCcw size={14} /> Try again</Button>}
          description={workstream.error?.message ?? messages.error?.message ?? 'This work stream is unavailable.'}
          title="Work stream could not be opened"
        />
      </div>
    );
  }

  const detail = workstream.data;
  const runTiming = workstreamRunTiming(detail.harnessStatus, detail.latestHarnessRun);
  const visibleTranscript = transcript;
  const firstUnreadSequenceNumber = detail.firstUnreadSequenceNumber;
  const firstUnreadIndex = firstUnreadSequenceNumber === null
    ? -1
    : visibleTranscript.findIndex((message) =>
      message.realtimeOrder === undefined && message.sequenceNumber >= firstUnreadSequenceNumber);
  const liveBackgroundTasks = backgroundTasksFromMessages(transcript);
  const backgroundTasks = mergeBackgroundTasks(
    deferredContext.data?.backgroundTasks ?? detail.backgroundTasks,
    liveBackgroundTasks,
  );
  const displayedDetail: WorkstreamDetail = {
    ...detail,
    artifacts: deferredContext.data?.artifacts ?? detail.artifacts,
    backgroundTasks,
    automationRuns: deferredContext.data?.automationRuns ?? detail.automationRuns,
    ...(deferredContext.data?.automationSubscription
      ? { automationSubscription: deferredContext.data.automationSubscription }
      : {}),
  };
  const discoveredResources = [...new Map(
    (availableResources.data?.pages.flatMap((page) => page.items) ?? []).map((resource) => [resource.id, resource]),
  ).values()];

  const downloadArtifact = async (artifactId: string): Promise<void> => {
    try {
      const { blob, fileName } = await api!.downloadArtifact(id, artifactId);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = fileName;
      anchor.style.display = 'none';
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (error) {
      setSendError(error instanceof Error ? error.message : 'The output could not be downloaded.');
    }
  };

  return (
    <div className={clsx('workstream-screen', hypersightOpen && 'has-hypersight')}>
      <WorkstreamHeader
        hypersightOpen={hypersightOpen}
        hypersightPreferencePending={hypersightPreference.isPending || updateHyperSightPreference.isPending}
        onAddParticipant={() => setParticipantDialogOpen(true)}
        onToggleHyperSight={() => updateHyperSightPreference.mutate(!hypersightOpen)}
        socketState={socketState}
        workstream={displayedDetail}
      />
      {hypersightOpen ? (
        <div className="hypersight-shell" style={{ height: `${hypersightHeight}px` }}>
          {hypersight.data ? (
            <HyperSightPanel
              error={updateHyperSight.error?.message ?? hypersight.error?.message}
              hypersight={hypersight.data}
              onChange={(blocks) => updateHyperSight.mutateAsync(blocks).then(() => undefined)}
              pending={updateHyperSight.isPending}
            />
          ) : hypersight.error ? (
            <div className="hypersight-load-state">
              <InlineError>{hypersight.error.message}</InlineError>
              <Button onClick={() => void hypersight.refetch()}><RefreshCcw size={14} /> Try again</Button>
            </div>
          ) : (
            <div className="hypersight-load-state">
              <LoadingState label="Opening HyperSight…" />
            </div>
          )}
          <HyperSightResizeHandle onResize={setHyperSightHeight} />
        </div>
      ) : null}
      <div
        className={clsx('transcript-scroll', transcriptDrop.dragging && 'is-file-dragging')}
        onDragEnter={transcriptDrop.onDragEnter}
        onDragLeave={transcriptDrop.onDragLeave}
        onDragOver={transcriptDrop.onDragOver}
        onDrop={transcriptDrop.onDrop}
        onScroll={(event) => {
          const element = event.currentTarget;
          const nearBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
          setAtBottom(nearBottom && newerMessageCursor.data === null);
          if (element.scrollTop < 160 && messageCursor.data && !loadingOlderRef.current) {
            void loadOlderMessages();
          }
          if (nearBottom && newerMessageCursor.data && !loadingNewerRef.current) {
            void loadNewerMessages();
          }
          scheduleReadAcknowledgement();
        }}
        ref={transcriptRef}
      >
        <div className="transcript-column">
          {messageCursor.data && (
            <div className="transcript-history-control">
              <Button disabled={loadingOlder} onClick={() => void loadOlderMessages()}>
                {loadingOlder ? <LoaderCircle aria-hidden="true" className="spin" size={14} /> : <ArrowUp aria-hidden="true" size={14} />}
                {loadingOlder ? 'Loading earlier messages…' : 'Load earlier messages'}
              </Button>
            </div>
          )}
          {olderMessagesError && <InlineError>{olderMessagesError}</InlineError>}
          {visibleTranscript.length === 0 && !activeElicitation ? (
            <EmptyState title="Ready to begin" description="Send a message to start work in this stream." />
          ) : (
            <div
              className="virtual-transcript"
              style={{ height: `${transcriptVirtualizer.getTotalSize()}px`, position: 'relative' }}
            >
              {transcriptVirtualizer.getVirtualItems().map((virtualRow) => {
                const message = visibleTranscript[virtualRow.index];
                if (!message) return null;
                return (
                  <div
                    className="virtual-message-row"
                    data-index={virtualRow.index}
                    key={message.id}
                    ref={transcriptVirtualizer.measureElement}
                    style={{
                      left: 0,
                      position: 'absolute',
                      top: 0,
                      transform: `translateY(${virtualRow.start}px)`,
                      width: '100%',
                    }}
                  >
                    {virtualRow.index === firstUnreadIndex && (
                      <div className="unread-divider" role="separator"><span>Unread messages</span></div>
                    )}
                    <MessageBlock
                      currentUserId={session?.user.id}
                      loadAttachmentContent={loadAttachmentContent}
                      message={message}
                      onAnswerElicitation={answerElicitation}
                      onOpenAttachment={setAttachmentPreview}
                      onResolveSuggestion={resolveSuggestion}
                    />
                  </div>
                );
              })}
            </div>
          )}
          {runTiming && <AgentWorkTiming key={detail.latestHarnessRunId ?? detail.latestHarnessRun?.id} {...runTiming} />}
          {detail.harnessStatus === 'failed' && detail.latestHarnessRun?.status === 'failed' && (
            <RunFailureNotice
              code={detail.latestHarnessRun.error?.code ?? 'harness_execution_failed'}
              message={detail.latestHarnessRun.error?.message ?? 'Avalon could not complete this run. Retry it, or copy the request ID for support.'}
              onCopyRequestId={() => void desktopBridge().copyText(detail.latestHarnessRun?.requestId ?? detail.latestHarnessRun!.id)}
              onRetry={() => retry.mutate()}
              requestId={detail.latestHarnessRun.requestId ?? detail.latestHarnessRun.id}
              retrying={retry.isPending}
            />
          )}
        </div>
      </div>

      <div className="composer-dock">
        {!atBottom && (
          <JumpToLatestButton onJump={() => void jumpToLatest()} />
        )}
        <div className="composer-stack">
          <WorkstreamComposer
            api={api ?? undefined}
            attachments={attachmentDraft.attachments}
            error={sendError ?? attachmentDraft.error ?? attachResource.error?.message ?? stop.error?.message ?? retry.error?.message ?? reconnect.error?.message}
            fileInputRef={fileInputRef}
            members={members.data ?? []}
            onAttach={attachmentDraft.addFiles}
            onOpenAttachment={setAttachmentPreview}
            onRemoveAttachment={attachmentDraft.removeAttachment}
            onRetryAttachment={attachmentDraft.retryAttachment}
            onSend={sendMessage}
            onStop={async () => {
              await stop.mutateAsync();
            }}
            sending={sending}
            uploading={attachmentDraft.uploading}
            key={displayedDetail.id}
            workstream={displayedDetail}
          />
        </div>
      </div>

      <InspectorRail
        dropTarget={railDrop}
        error={deferredContext.error?.message ?? watchResource.error?.message ?? detachResource.error?.message ?? attachResource.error?.message ?? reconnect.error?.message}
        messages={transcript}
        onAddParticipant={() => setParticipantDialogOpen(true)}
        onAddResource={() => setResourceDialogOpen(true)}
        onDetachResource={(resource) => detachResource.mutate(resource)}
        onDownloadArtifact={(artifact) => void downloadArtifact(artifact.id)}
        onJumpToMessage={(messageId) => {
          const index = transcript.findIndex((message) => message.id === messageId);
          if (index >= 0) transcriptVirtualizer.scrollToIndex(index, { align: 'center', behavior: 'smooth' });
        }}
        onOpenRun={(run) => void navigate(`/workstreams/${run.workstreamId}`)}
        onReconnectConnection={(connection) => reconnect.mutate(connection)}
        onToggleWatch={(resource, enabled) => watchResource.mutate({ resource, enabled })}
        tasks={displayedDetail.backgroundTasks}
        workstream={displayedDetail}
      />

      <AddParticipantDialog
        current={displayedDetail.participants}
        members={members.data ?? []}
        onAdd={(member) => addParticipant.mutate(member)}
        onOpenChange={setParticipantDialogOpen}
        open={participantDialogOpen}
        pending={addParticipant.isPending}
      />
      <AddResourceDialog
        current={displayedDetail.resources}
        error={availableResources.error?.message ?? attachResource.error?.message}
        fetching={availableResources.isFetchingNextPage}
        hasMore={Boolean(availableResources.hasNextPage)}
        loading={availableResources.isLoading}
        onAttach={(resource) => attachResource.mutate(resource)}
        onLoadMore={() => void availableResources.fetchNextPage()}
        onOpenChange={(open) => {
          setResourceDialogOpen(open);
          if (!open) setResourceSearch('');
        }}
        onSearchChange={setResourceSearch}
        onUpload={() => {
          setResourceDialogOpen(false);
          fileInputRef.current?.click();
        }}
        open={resourceDialogOpen}
        pending={attachResource.isPending}
        resources={discoveredResources}
        search={resourceSearch}
      />
      <AttachmentLightbox onClose={() => setAttachmentPreview(null)} preview={attachmentPreview} />
    </div>
  );
}
