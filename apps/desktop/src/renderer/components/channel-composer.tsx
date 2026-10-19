import { loadAnnotationPreview } from '../lib/annotation-preview';
import { useAnnotationDraft } from './artifact-annotations';
import type { Annotation } from '@rally/contracts';
import { asSubstreamId, asWorkspaceId, asWorkstreamId, MESSAGE_MAX_CHARACTERS, MESSAGE_TOO_LONG_MESSAGE, type SpaceColorKey } from '@rally/contracts';
import { IconCloudDownload } from '@tabler/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { ConversationVisibilityContext } from '../lib/conversation-visibility';
import { useNavigate } from 'react-router-dom';

import { logError } from '../../common/logger';
import type { MentionIdentity } from '../lib/api';
import { useAppSession } from '../lib/app-session';
import { newWorkstreamDraftKey } from '../lib/draft-keys';
import { optimisticOpeningTranscript } from '../lib/launched-conversation';
import { optimisticMentionRendering } from '../lib/transcript';
import { OPEN_EXPANDED, threadRoute } from '../lib/navigation-routes';
import { holdCreationTraceUntilSendReady, startPerfTrace, type PerfTrace } from '../lib/perf-trace';
import { uuidV7 } from '../lib/telemetry';
import type { AgentModelOverride, CreatedWorkstream, MessageAttachment, Workspace, WorkspaceMember, WorkstreamDetail } from '../lib/types';
import { useFileAttachments } from '../lib/use-file-attachments';
import { useWindowFilePaste } from '../lib/use-file-paste';
import { EmailMentionContext, emailMentionDirectory, NO_INVITEES, useWorkspaceInvitees } from '../lib/workspace-invitees';
import { addPendingWorkstream, confirmPendingWorkstream, discardPendingWorkstream } from '../lib/workstreams-cache';
import { AttachmentLightbox } from './attachment-lightbox';
import type { AttachmentPreview } from './attachments';
import type { ComposerMenuAction } from './composer-input';
import { type ComposerConversation, WorkstreamComposer } from './workstream-composer';

interface CreateThreadInput {
  annotations: Annotation[];
  pinIds: string[];
  attachmentIds: string[];
  attachmentLocalIds: string[];
  attachments: MessageAttachment[];
  modelOverride: AgentModelOverride | null;
  openingMessage: string;
  mentions: MentionIdentity[];
  participantIds: string[];
  /** Invitees mentioned, shared the thread by address once it exists. */
  invitedEmails: string[];
  /** The submit instant, seeded onto the created run so its timer does not jump. */
  startedAt: string;
  /** The id this thread is listed and created under, from the keystroke. */
  threadId: string;
}

/**
 * The detail a just-created thread is put into the cache under, so its pane
 * paints instead of loading.
 */
function launchedThreadDetail(
  created: CreatedWorkstream,
  context: {
    creator: WorkspaceMember;
    model?: AgentModelOverride | null;
    participants?: WorkspaceMember[];
    startedAt: string;
  },
): WorkstreamDetail {
  return {
    ...created.workstream,
    createdAt: created.createdAt,
    modelOverride: context.model ?? null,
    createdBy: { ...context.creator, role: 'creator' },
    participants: [{ ...context.creator, role: 'creator' }, ...context.participants ?? []],
    viewers: [],
    resources: [],
    connections: [],
    backgroundTasks: [],
    openElicitations: [],
    ...(created.harnessRunId
      ? {
        latestHarnessRunId: created.harnessRunId,
        latestHarnessRun: {
          id: created.harnessRunId,
          origin: 'opening_message',
          status: 'running' as const,
          ...(context.model ? { model: context.model } : {}),
          startedAt: context.startedAt,
          createdAt: context.startedAt,
        },
      }
      : {}),
  };
}

/**
 * A Channel's composer: what a person types here starts a thread in this
 * Channel and nothing else (`docs/PRDs/2026-10-10_channels-threads-navigation/prd.md`).
 *
 * The thread opens beside the Channel on the keystroke, as a pending row whose
 * pane shows the opening skeleton, and becomes the real thread when the create
 * answers; nothing waits on the round trip before the person sees their
 * thread. In an Organization-wide Channel the thread is Organization-wide; in
 * a private one it is visible only to the person who started it and whoever
 * they mention (`resolveSpaceWorkstreamStart` on the server decides).
 */
export function ChannelComposer({ channelColor, channelId, channelName, channelScope, threadOpen = false, workspace }: {
  /** The Channel's colour, which a thread started here is born with. */
  channelColor: SpaceColorKey;
  channelId: string;
  channelName: string;
  /** A private Channel's threads start private; an Organization-wide one's, Organization-wide. */
  channelScope: 'personal' | 'workspace';
  /**
   * A thread is open beside this Channel. That thread's composer is where the
   * person is writing, so this one neither takes focus nor claims a paste: a
   * reply typed or pasted there would otherwise start a new thread here.
   */
  threadOpen?: boolean;
  workspace: Workspace;
}): React.JSX.Element {
  const { api } = useAppSession();
  const annotationDraft = useAnnotationDraft();
  const visible = useContext(ConversationVisibilityContext);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const draftKey = `${newWorkstreamDraftKey(workspace.region, workspace.id)}:space:${channelId}`;
  const [modelOverride, setModelOverride] = useState<AgentModelOverride | null>(null);
  const [attachmentPreview, setAttachmentPreview] = useState<AttachmentPreview | null>(null);
  const setAnnotationPreviewOpener=annotationDraft?.setPreviewOpener;
  useEffect(()=>{
    if(!api)return;
    setAnnotationPreviewOpener?.((preview)=>{void loadAnnotationPreview(api,preview,()=>setAttachmentPreview(null)).then(setAttachmentPreview);});
    return()=>setAnnotationPreviewOpener?.(null);
  },[api,setAnnotationPreviewOpener]);
  const [tooLong, setTooLong] = useState(false);
  const attachmentDraft = useFileAttachments(api, draftKey);
  useWindowFilePaste(attachmentDraft.addFiles, !visible || threadOpen);
  const members = useQuery({
    queryKey: ['workspace-members'],
    queryFn: ({ signal }) => api!.getWorkspaceMembers(signal),
    enabled: Boolean(api),
    staleTime: 60_000,
  });
  const invitees = useWorkspaceInvitees(api, workspace.currentUser.accessClass !== 'guest');
  const visibleInvitees = invitees.data ?? NO_INVITEES;
  const emailMentions = useMemo(
    () => emailMentionDirectory(members.data ?? [], visibleInvitees),
    [members.data, visibleInvitees],
  );
  const createTrace = useRef<PerfTrace | null>(null);
  const createStartedAt = useRef<number | null>(null);
  const create = useMutation({
    mutationFn: (input: CreateThreadInput) => {
      createTrace.current?.end({ outcome: 'superseded' });
      const trace = startPerfTrace('workstream_create');
      createTrace.current = trace;
      createStartedAt.current = performance.now();
      trace.annotate({
        participantCount: input.participantIds.length,
        attachmentCount: input.attachmentIds.length,
        openingMessageLength: input.openingMessage.length,
      });
      return trace.step('create_request', () => api!.createWorkstream({
        workstreamId: input.threadId,
        openingMessage: input.openingMessage,
        ...(input.annotations.length ? { annotations:input.annotations } : {}),
        participantIds: input.participantIds,
        spaceIds: [channelId],
        ...(input.mentions.length > 0 ? { mentions: input.mentions } : {}),
        requestId: trace.traceId,
        operationId: trace.traceId,
        ...(input.attachmentIds.length > 0 ? { attachmentIds: input.attachmentIds } : {}),
        ...(input.modelOverride ? { modelOverride: input.modelOverride } : {}),
      }));
    },
    onError: (_error, input) => {
      discardPendingWorkstream(queryClient, input.threadId);
      createTrace.current?.end({ outcome: 'failed' });
      createTrace.current = null;
      createStartedAt.current = null;
      // The pane opened on the keystroke has nothing to show; back to the Channel,
      // where the composer has restored the draft and names the failure.
      void navigate(`/channels/${encodeURIComponent(channelId)}`, { replace: true });
    },
    onSuccess: (created, input) => {
      confirmPendingWorkstream(queryClient, input.threadId, created.workstream);
      if (input.invitedEmails.length > 0) {
        void Promise.resolve().then(() => api!.createScopeInvitations({
          operationId: uuidV7(),
          parentId: created.workstream.id,
          emails: input.invitedEmails,
          targets: [{
            kind: 'conversation',
            workspaceId: asWorkspaceId(workspace.id),
            parentId: asWorkstreamId(created.workstream.id),
            substreamId: asSubstreamId('0'),
          }],
          completeWorkstream: false,
          expiresAt: null,
        }))
          .then(() => queryClient.invalidateQueries({ queryKey: ['scope-invitations', created.workstream.id] }))
          .catch((error: unknown) => logError('rally', `could not share the new thread with ${input.invitedEmails.join(', ')}`, error));
      }
      const participants = (members.data ?? [])
        .filter((member) => input.participantIds.includes(member.id))
        .map((member) => ({ ...member, role: 'explicit' }));
      queryClient.setQueryData(['workstream', created.workstream.id], launchedThreadDetail(created, {
        creator: workspace.currentUser,
        model: input.modelOverride,
        participants,
        startedAt: input.startedAt,
      }));
      queryClient.setQueryData(
        ['ordered-transcript', created.workstream.id],
        optimisticOpeningTranscript({
          turnId: created.turnId,
          clientMessageId: created.clientMessageId,
          createdAt: created.createdAt,
          text: input.openingMessage,
          ...(input.annotations.length ? {annotationContent:{kind:'artifact_annotations',annotations:input.annotations}} : {}),
          mentions: input.mentions,
          attachments: input.attachments,
        }, workspace.currentUser, members.data ?? []),
      );
      void queryClient.invalidateQueries({ queryKey: ['workstream', created.workstream.id], exact: true });
      attachmentDraft.consume(input.attachmentLocalIds);
      annotationDraft?.clear(input.pinIds);
      if (createTrace.current) holdCreationTraceUntilSendReady(
        createTrace.current,
        created.workstream.id,
        '0',
        createStartedAt.current === null ? 0 : Math.max(0, performance.now() - createStartedAt.current),
      );
      createTrace.current?.annotate({ workstreamId: created.workstream.id, harnessRunId: created.harnessRunId });
      createTrace.current = null;
      createStartedAt.current = null;
    },
  });

  /** The composer's `onSend`; it restores the draft if this throws. */
  const submit = useCallback(async (
    openingMessage: string,
    mentions: MentionIdentity[],
    confirmedParticipantUserIds: string[] = [],
    _deliveryMode?: unknown,
    mentionedInvitees: string[] = [],
  ): Promise<void> => {
    if (create.isPending) throw new Error('A thread is already being started');
    if (openingMessage.length > MESSAGE_MAX_CHARACTERS) {
      setTooLong(true);
      throw new Error(MESSAGE_TOO_LONG_MESSAGE);
    }
    setTooLong(false);
    const readyAttachments = attachmentDraft.ready;
    const pins = annotationDraft?.pins ?? [];
    const annotations = pins.map((pin) => pin.annotation);
    const cropIds = annotations.flatMap((annotation) => annotation.content.imageAttachmentId ? [annotation.content.imageAttachmentId] : []);
    const participantIds = [...new Set([
      ...mentions.flatMap((mention) => mention.type === 'person' && mention.userId ? [mention.userId] : []),
      ...confirmedParticipantUserIds,
    ])].filter((id) => id !== workspace.currentUser.id);
    const createdAt = new Date().toISOString();
    const attachments = readyAttachments.map((attachment) => ({
      id: attachment.resource!.id,
      fileName: attachment.resource?.title ?? attachment.file.name,
      mimeType: attachment.resource?.mimeType ?? (attachment.file.type || 'application/octet-stream'),
      sizeBytes: attachment.file.size,
      contentAvailable: true,
      createdAt,
    }));
    const threadId = uuidV7();
    addPendingWorkstream(queryClient, {
      id: threadId,
      spaceIds: [channelId],
      scope: channelScope,
      harnessStatus: 'running',
      createdAt,
      createdByUserId: workspace.currentUser.id,
      objective: openingMessage,
      opening: { ...optimisticMentionRendering(openingMessage, mentions, members.data ?? []), attachments },
      color: channelColor,
    });
    void navigate(threadRoute(threadId, channelId), { state: OPEN_EXPANDED });
    await create.mutateAsync({
      annotations, pinIds:pins.map((pin) => pin.id),
      attachmentIds: [...readyAttachments.map((attachment) => attachment.resource!.id),...cropIds],
      attachmentLocalIds: readyAttachments.map((attachment) => attachment.localId),
      attachments,
      modelOverride,
      openingMessage,
      mentions,
      participantIds,
      invitedEmails: [...new Set(mentionedInvitees)].sort(),
      threadId,
      startedAt: createdAt,
    });
  }, [annotationDraft, attachmentDraft.ready, channelColor, channelId, channelScope, create, members.data, modelOverride, navigate, queryClient, workspace.currentUser.id]);

  // The same import the Channel header offers, beside the other ways to bring
  // something into a new thread. Only the Mac app has the embedded browser it
  // runs in; the browser shows it disabled, saying so.
  const openBrowserImport = typeof window === 'undefined' ? undefined : window.rally?.openBrowserImport;
  const menuActions: ComposerMenuAction[] = [{
    ...(openBrowserImport ? {} : { disabledReason: 'Importing needs the Rally Mac app' }),
    icon: <IconCloudDownload aria-hidden="true" />,
    label: 'Import from Claude or ChatGPT',
    onSelect: () => void openBrowserImport?.({ spaces: [{ id: channelId, name: channelName }], spaceLocked: true }),
  }];

  const pendingThread: ComposerConversation = {
    scope: channelScope,
    harnessStatus: 'completed',
    stopRequested: false,
    participants: [{ ...workspace.currentUser, role: 'creator' }],
  };

  return <EmailMentionContext.Provider value={emailMentions}>
    <section aria-label={`Start a thread in ${channelName}`} className="composer-dock channel-composer-dock">
      <div className="composer-stack">
        <WorkstreamComposer
          api={api ?? undefined}
          ariaLabel={`Start a thread in ${channelName}`}
          attachments={attachmentDraft.attachments}
          autoFocus={!threadOpen}
          draftKey={draftKey}
          error={(tooLong ? MESSAGE_TOO_LONG_MESSAGE : undefined) ?? create.error?.message ?? attachmentDraft.error}
          fileInputRef={fileInputRef}
          members={members.data ?? []}
          invitees={visibleInvitees}
          markNonParticipants={false}
          menuActions={menuActions}
          model={{ kind: 'choice', value: modelOverride, onChange: setModelOverride }}
          onAttach={attachmentDraft.addFiles}
          onDraftChange={() => setTooLong(false)}
          onOpenAttachment={setAttachmentPreview}
          onRemoveAttachment={attachmentDraft.removeAttachment}
          onRetryAttachment={attachmentDraft.retryAttachment}
          onSend={submit}
          onStop={async () => undefined}
          placeholder={`Start a thread in ${channelName}`}
          sending={create.isPending}
          submitLabel="Start thread"
          uploading={attachmentDraft.uploading}
          workstream={pendingThread}
        />
      </div>
    </section>
    <AttachmentLightbox preview={attachmentPreview} onClose={() => setAttachmentPreview(null)} />
  </EmailMentionContext.Provider>;
}
