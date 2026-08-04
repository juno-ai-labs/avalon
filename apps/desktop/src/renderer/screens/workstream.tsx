import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Activity,
  AlertTriangle,
  ArrowDown,
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
import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { DesktopSession } from '../../common/desktop';
import { useAppSession } from '../lib/app-session';
import { backgroundTasksFromMessages, type MentionIdentity } from '../lib/api';
import { formatDateTime } from '../lib/format';
import { desktopBridge } from '../lib/platform';
import { useUiStore } from '../lib/ui-store';
import { insertMessage, mergeCanonicalTranscript, nextTranscriptSequence, orderTranscript, useWorkstreamSocket } from '../lib/use-workstream-socket';
import type { BackgroundTask, Message, WorkspaceMember, WorkstreamConnection, WorkstreamDetail, WorkstreamResource } from '../lib/types';
import { InspectorRail } from '../components/inspector-rail';
import { Avatar, AvatarStack, Badge, Button, EmptyState, IconButton, InlineError, LoadingState, Modal, StatusDot } from '../components/primitives';
import { MessageBlock } from '../components/workstream-blocks';
import { WorkstreamComposer } from '../components/workstream-composer';

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
  onAddParticipant,
}: {
  workstream: WorkstreamDetail;
  onAddParticipant: () => void;
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
        <button className="participant-header-button" onClick={onAddParticipant} type="button">
          <AvatarStack members={workstream.participants} />
          <UserPlus aria-hidden="true" size={13} />
          <span className="sr-only">Add participant</span>
        </button>
        <IconButton label="Background tasks" onClick={() => openRail('background')}>
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
  const [resourceDialogOpen, setResourceDialogOpen] = useState(false);
  const [resourceSearch, setResourceSearch] = useState('');
  const [debouncedResourceSearch, setDebouncedResourceSearch] = useState('');
  const [sendError, setSendError] = useState<string | undefined>();
  const [sending, setSending] = useState(false);
  const [atBottom, setAtBottom] = useState(true);
  const pendingSendCount = useRef(0);

  useEffect(() => () => closeRail(), [closeRail, id]);

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
  const messages = useQuery({
    queryKey: ['messages', id],
    queryFn: async ({ signal }) => mergeCanonicalTranscript(
      queryClient.getQueryData<Message[]>(['messages', id]),
      await api!.getMessages(id, signal),
    ),
    enabled: Boolean(api && id),
    staleTime: 2_000,
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
  const socketState = useWorkstreamSocket(api, id, workstream.isSuccess && messages.isSuccess);

  const addParticipant = useMutation({
    mutationFn: (member: WorkspaceMember) => api!.addParticipant(id, member.id),
    onSuccess: (updated) => {
      queryClient.setQueryData(['workstream', id], updated);
      setParticipantDialogOpen(false);
    },
  });

  const upload = useMutation({
    mutationFn: async (file: File) => {
      if (file.size > 25_000_000) throw new Error('Files must be 25 MB or smaller.');
      const resource = await api!.uploadResource(file);
      return api!.attachResource(id, resource.id);
    },
    onSuccess: (updated) => {
      queryClient.setQueryData(['workstream', id], updated);
      setResourceDialogOpen(false);
      setResourceSearch('');
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

  const stop = useMutation({
    mutationFn: () => api!.stopHarness(id),
    onSuccess: () => void workstream.refetch(),
  });

  const retry = useMutation({
    mutationFn: () => api!.retryHarness(id),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['workstream', id], exact: true }),
        queryClient.invalidateQueries({ queryKey: ['messages', id], exact: true }),
        queryClient.invalidateQueries({ queryKey: ['workstreams'] }),
      ]);
    },
  });

  const reconnect = useMutation({
    mutationFn: async (connection: WorkstreamConnection) => {
      const url = await api!.reconnectConnection(connection.id);
      await desktopBridge().openExternal(url);
    },
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

  const sendMessage = async (
    text: string,
    mentions: MentionIdentity[],
    confirmedParticipantUserIds: string[] = [],
  ): Promise<void> => {
    if (!api || !workstream.data) throw new Error('This work stream is not ready to receive messages.');
    pendingSendCount.current += 1;
    setSending(true);
    setSendError(undefined);
    const clientId = crypto.randomUUID();
    queryClient.setQueryData<Message[]>(['messages', id], (current) => {
      const anchorSequenceNumber = nextTranscriptSequence(current);
      const optimistic: Message = {
        id: clientId,
        clientMessageId: clientId,
        workstreamId: id,
        sequenceNumber: anchorSequenceNumber,
        authorType: 'human',
        author: workspaceMemberFromSession(session),
        messageType: 'text',
        text,
        createdAt: new Date().toISOString(),
        deliveryState: 'sending',
        realtimeOrder: {
          anchorSequenceNumber,
          eventSequence: Number.MAX_SAFE_INTEGER,
          placement: 'at_anchor',
        },
      };
      return orderTranscript([...(current ?? []), optimistic]);
    });
    try {
      const created = await api.createMessage(id, { text, clientId, mentions, confirmedParticipantUserIds });
      queryClient.setQueryData<Message[]>(['messages', id], (current) => insertMessage(current, created));
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['workstream', id], exact: true }),
        queryClient.invalidateQueries({ queryKey: ['messages', id], exact: true }),
        queryClient.invalidateQueries({ queryKey: ['workstreams'] }),
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

  const answerElicitation = async (elicitationId: string, answer: unknown): Promise<void> => {
    await api!.answerElicitation(id, elicitationId, answer);
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['messages', id], exact: true }),
      queryClient.invalidateQueries({ queryKey: ['workstream', id], exact: true }),
      queryClient.invalidateQueries({ queryKey: ['workstreams'] }),
    ]);
  };

  const resolveSuggestion = async (suggestionId: string, action: 'accept' | 'dismiss'): Promise<void> => {
    await api!.resolveActivitySuggestion(id, suggestionId, action);
    await Promise.all([messages.refetch(), workstream.refetch()]);
  };

  useEffect(() => {
    if (!atBottom) return;
    const element = transcriptRef.current;
    if (element) requestAnimationFrame(() => element.scrollTo({ top: element.scrollHeight }));
  }, [atBottom, messages.data]);

  if (workstream.isLoading || messages.isLoading) return <LoadingState label="Opening work stream…" />;
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
  const transcript = messages.data ?? [];
  const liveBackgroundTasks = backgroundTasksFromMessages(transcript);
  const backgroundTasks = mergeBackgroundTasks(detail.backgroundTasks, liveBackgroundTasks);
  const displayedDetail: WorkstreamDetail = {
    ...detail,
    backgroundTasks,
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
    <div className="workstream-screen">
      <WorkstreamHeader onAddParticipant={() => setParticipantDialogOpen(true)} workstream={displayedDetail} />
      <div
        className="transcript-scroll"
        onScroll={(event) => {
          const element = event.currentTarget;
          setAtBottom(element.scrollHeight - element.scrollTop - element.clientHeight < 80);
        }}
        ref={transcriptRef}
      >
        <div className="transcript-column">
          {transcript.length === 0 ? (
            <EmptyState title="Ready to begin" description="Send a message to start work in this stream." />
          ) : (
            transcript.map((message) => (
              <MessageBlock
                currentUserId={session?.user.id}
                key={message.id}
                message={message}
                onAnswerElicitation={answerElicitation}
                onResolveSuggestion={resolveSuggestion}
              />
            ))
          )}
          {detail.harnessStatus === 'running' && !transcript.some((message) => message.streaming) && (
            <div aria-live="polite" className="agent-thinking" role="status"><span className="thinking-mark" /><span>Avalon is working</span><span className="thinking-dots">…</span></div>
          )}
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
          <JumpToLatestButton onJump={() => transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight, behavior: 'smooth' })} />
        )}
        <WorkstreamComposer
          error={sendError ?? upload.error?.message ?? attachResource.error?.message ?? stop.error?.message ?? retry.error?.message ?? reconnect.error?.message}
          fileInputRef={fileInputRef}
          members={members.data ?? []}
          onAttach={async (file) => {
            await upload.mutateAsync(file);
          }}
          onSend={sendMessage}
          onStop={async () => {
            await stop.mutateAsync();
          }}
          sending={sending}
          socketState={socketState}
          uploading={upload.isPending}
          workstream={displayedDetail}
        />
      </div>

      <InspectorRail
        error={watchResource.error?.message ?? detachResource.error?.message ?? attachResource.error?.message ?? reconnect.error?.message}
        messages={transcript}
        onAddParticipant={() => setParticipantDialogOpen(true)}
        onAddResource={() => setResourceDialogOpen(true)}
        onDetachResource={(resource) => detachResource.mutate(resource)}
        onDownloadArtifact={(artifact) => void downloadArtifact(artifact.id)}
        onJumpToMessage={(messageId) => document.getElementById(`message-${messageId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })}
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
        error={availableResources.error?.message ?? attachResource.error?.message ?? upload.error?.message}
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
        onUpload={() => fileInputRef.current?.click()}
        open={resourceDialogOpen}
        pending={attachResource.isPending || upload.isPending}
        resources={discoveredResources}
        search={resourceSearch}
      />
    </div>
  );
}
