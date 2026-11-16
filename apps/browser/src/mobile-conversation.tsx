import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { ArrowUpRight, Sparkles } from 'lucide-react';
import { asWorkstreamId } from '@rally/contracts';
import { mobileTurnTarget } from './mobile-session';
import { postMobileEvent } from './mobile-bridge';
import { useMobileCanvasDetail } from './mobile-canvas-detail';
import type { Descriptor } from './mobile';
import { useAppSession } from '../../desktop/src/renderer/lib/app-session';
import { useWorkspaceMembers } from '../../desktop/src/renderer/lib/workspace-members';
import { ConversationSurface } from '../../desktop/src/renderer/screens/conversation-surface';
import { WorkstreamComposer } from '../../desktop/src/renderer/components/workstream-composer';
import { useFileAttachments } from '../../desktop/src/renderer/lib/use-file-attachments';
import { AttachmentLightbox } from '../../desktop/src/renderer/components/attachment-lightbox';
import type { AttachmentPreview } from '../../desktop/src/renderer/components/attachments';
import { uuidV7 } from '../../desktop/src/renderer/lib/telemetry';
import { ConversationVisibilityContext } from '../../desktop/src/renderer/lib/conversation-visibility';
import { CanvasTemplateCard } from '../../desktop/src/renderer/components/canvas-template-picker';
import { CANVAS_TEMPLATE_CATEGORIES } from '../../desktop/src/renderer/lib/canvas-template-categories';
import { CANVAS_TEMPLATES } from '../../desktop/src/renderer/lib/canvas-templates';
import { ErrorNotice } from '@rally/ui/components/error-notice';

/** The mentions a composer hands its send. */
type MentionDrafts = Parameters<React.ComponentProps<typeof WorkstreamComposer>['onSend']>[1];

/** The shared "Ask Rally or the people here…" overflows a 375pt phone's composer at 17pt. */
const MOBILE_COMPOSER_PLACEHOLDER = 'Ask Rally or the team…';

export function MobileConversation({ id, active, describe }: { id: string; active: boolean; describe: (id: string, descriptor: Descriptor) => void }) {
  const detail = useMobileCanvasDetail(id, active);
  const location = useLocation();
  const scrollToTurn = useMemo(() => mobileTurnTarget(location.search), [location.search]);
  const resource = detail.data?.artifacts[0];
  useEffect(() => {
    if (active && detail.data) describe(id, { title: detail.data.title, view: 'conversation', artifactId: resource?.resourceId ?? null, artifactPicker: false });
  }, [active, describe, id, detail.data, resource]);
  return <ConversationVisibilityContext value={active}><div className="mobile-conversation-stack">{resource && <button className="mobile-view-canvas" onClick={() => postMobileEvent({ type: 'open-canvas', id })}>View canvas <ArrowUpRight size={15} aria-hidden="true" /></button>}<ConversationSurface parentKind="canvas" parentId={id} substreamId="0" embedded composerPlaceholder={MOBILE_COMPOSER_PLACEHOLDER} scrollToTurn={active ? scrollToTurn : null} /></div></ConversationVisibilityContext>;
}

/**
 * The create flow: a prompt form, or, opened from the dashboard's Marketplace,
 * the template catalog. A template's prompt is sent as the Canvas's first
 * message exactly as typed text is, through the same reservation and receipts.
 */
export function CreateCanvas({ created, marketplace = false }: { created: (id: string) => void; marketplace?: boolean }) {
  const { api, session } = useAppSession();
  const [sending, setSending] = useState(false);
  const guest = session?.workspace?.accessClass === 'guest';
  const roster = useWorkspaceMembers(api, { enabled: !guest });
  const members = roster.data ?? [];
  const participants = members.filter((member) => member.id === session?.user.id);
  const [failed, setFailed] = useState(false);
  const [preview, setPreview] = useState<AttachmentPreview | null>(null);
  const draftKey = `mobile-canvas:${session?.workspace?.id}:${session?.user.id}:new`;
  const attachments = useFileAttachments(api, draftKey);
  const fileInput = useRef<HTMLInputElement>(null);
  const attempt = useRef<{ signature: string; operationId: string; workstreamId: string; clientMessageId: string } | null>(null);
  const blocked = sending || (!guest && !roster.data);
  // An unchanged retry replays its receipts; a changed one keeps the reserved Canvas.
  const begin = async (text: string, mentions: MentionDrafts, participantIds: string[], attachmentIds: string[]): Promise<void> => {
    if (!api) return;
    const request = { openingMessage: text, mentions, participantIds, attachmentIds };
    const signature = JSON.stringify(request);
    if (attempt.current?.signature !== signature) attempt.current = { signature, operationId: uuidV7(), workstreamId: attempt.current?.workstreamId ?? uuidV7(), clientMessageId: uuidV7() };
    const result = await api.createCanvas({ canvasId: asWorkstreamId(attempt.current.workstreamId) });
    await api.sendConversationMessage(result.canvasId, {
      text, clientMessageId: attempt.current.clientMessageId, attachmentIds, confirmedParticipantUserIds: participantIds,
      mentions: await api.messageMentionPayload(text, mentions, members),
    }, attempt.current.operationId);
    created(result.canvasId);
  };
  if (marketplace) {
    return <MobileMarketplace disabled={blocked} failed={failed} onStart={async (prompt) => {
      if (blocked) return;
      setSending(true); setFailed(false);
      try { await begin(prompt, [], [], []); } catch { setFailed(true); } finally { setSending(false); }
    }} />;
  }
  return <div className="mobile-create"><Sparkles size={36} strokeWidth={1.2} /><h1>What would you<br />like to make?</h1><p>A plan, a tiny tool, a space for something you love. Start with an idea.</p>
    <div className="mobile-create-composer"><WorkstreamComposer
      placeholder="Describe what you’d like…" ariaLabel="Describe your canvas" submitLabel="Create canvas" draftKey={draftKey}
      workstream={{ participants, scope: 'personal', harnessStatus: 'completed' }} members={members}
      fileInputRef={fileInput} sending={sending} sendBlocked={blocked} uploading={attachments.uploading} attachments={attachments.attachments}
      onAttach={attachments.addFiles} onOpenAttachment={setPreview} onRemoveAttachment={attachments.removeAttachment} onRetryAttachment={attachments.retryAttachment}
      error={failed ? 'Your canvas couldn’t be created. Your draft is safe; try again.' : attachments.error}
      onStop={async () => undefined}
      onSend={async (text, mentions, participantIds = []) => {
        if (!api || sending) return;
        setSending(true); setFailed(false);
        let lease: Awaited<ReturnType<typeof attachments.leaseReady>> | undefined;
        try {
          lease = await attachments.leaseReady();
          await begin(text, mentions, participantIds, lease.attachments.flatMap((item) => item.resource ? [item.resource.id] : []));
          attachments.commitLease(lease.leaseId);
        } catch (error) { if (lease) await attachments.restoreLease(lease.leaseId); setFailed(true); throw error; }
        finally { setSending(false); }
      }} />
    </div><AttachmentLightbox preview={preview} onClose={() => setPreview(null)} />
  </div>;
}

/** The Marketplace on a phone: desktop's categories and template cards, one category at a time. */
function MobileMarketplace({ disabled, failed, onStart }: { disabled: boolean; failed: boolean; onStart: (prompt: string) => void }) {
  const [category, setCategory] = useState<(typeof CANVAS_TEMPLATE_CATEGORIES)[number]['tag']>(CANVAS_TEMPLATE_CATEGORIES[0].tag);
  const templates = CANVAS_TEMPLATES.filter((template) => template.tags.includes(category));
  return <section aria-label="Canvas templates" className="mobile-marketplace">
    <h1>Marketplace</h1><p>Templates to start a Canvas from. Pick one and Rally builds it with you.</p>
    <div aria-label="Template category" className="mobile-filters" role="group">
      {CANVAS_TEMPLATE_CATEGORIES.map(({ tag, label }) => <button aria-pressed={category === tag} key={tag} onClick={() => setCategory(tag)} type="button">{label}</button>)}
    </div>
    {failed && <ErrorNotice title="Your canvas couldn’t be created">Check your connection and pick the template again.</ErrorNotice>}
    <ul>{templates.map((template) => <li key={template.name}><CanvasTemplateCard disabled={disabled} onStart={onStart} template={template} /></li>)}</ul>
  </section>;
}
