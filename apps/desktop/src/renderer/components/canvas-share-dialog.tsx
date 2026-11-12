import { asUserId, type CanvasDetail } from '@rally/contracts';
import { CreateScopeInvitationsSchema } from '@rally/contracts/scope-grants';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { IconChevronRight } from '@tabler/icons-react';
import { useEffect, useRef, useState } from 'react';

import { desktopBridge } from '../lib/platform';
import { ApiError } from '../lib/api';
import { canvasDetailQueryKey, useCanvasNameSources } from '../lib/canvases';
import { CANVAS_VISIBILITY_OPTIONS } from '../lib/canvas-sharing';
import { useCollaborationSession } from '../lib/collaboration-session';
import { AccessDecisionActions } from './canvas-access-request';
import { CanvasSharingDialog, type CanvasSharingSelection } from './canvas-sharing-dialog';
import { Avatar, Badge, Modal } from './primitives';
import { RelativeTime } from './relative-time';
import { useScopeInvitations } from './scope-sharing-panel';

export function CanvasShareDialog({ canvas, onOpenChange, open }: {
  canvas: CanvasDetail; onOpenChange: (open: boolean) => void; open: boolean;
}): React.JSX.Element | null {
  return open ? <ConnectedCanvasSharingDialog canvas={canvas} onOpenChange={onOpenChange} /> : null;
}

function ConnectedCanvasSharingDialog({canvas,onOpenChange}:{canvas:CanvasDetail;onOpenChange:(open:boolean)=>void}):React.JSX.Element {
  const {api,session}=useCollaborationSession();
  const {members,membersById}=useCanvasNameSources(api);
  const queryClient=useQueryClient();
  const revision=useRef(canvas.sharingRevision);
  useEffect(()=>{revision.current=canvas.sharingRevision;},[canvas.sharingRevision]);
  const [guestOpen,setGuestOpen]=useState(false);
  const [emails,setEmails]=useState('');
  const [failure,setFailure]=useState<'save'|'changed'|'invitations'|'emails'>('save');
  const owner=membersById.get(canvas.createdByUserId)??{id:canvas.createdByUserId,name:'Creator',email:'',timezone:'UTC'};
  const firstArtifact=canvas.artifacts[0];
  const link=useQuery({queryKey:['artifact-link',firstArtifact?.resourceId],queryFn:()=>api!.artifactLink(firstArtifact!.resourceId),
    enabled:Boolean(api && firstArtifact),retry:false});
  const {invite}=useScopeInvitations({api:api!,workspaceId:session?.workspace?.id??'',parentId:canvas.id,substreamId:'0',target:'workstream',listsPending:false,enabled:false});
  if(!canvas.canManage) {
    const audience=CANVAS_VISIBILITY_OPTIONS[canvas.visibility].label;
    const artifacts={editors:'Editors only',participants:'Specific people',workspace:'Everyone in the Organization',public:'Anyone with the link'}[canvas.artifactVisibility??'editors'];
    return <Modal open onOpenChange={onOpenChange} title="Share Canvas" description={canvas.title}>
      <div className="canvas-share"><p className="canvas-share-visibility"><strong>Who can edit</strong>{audience}</p>
        <div className="member-action-list">{[canvas.createdByUserId,...canvas.participantUserIds].map(id=>{
          const person=membersById.get(id); return <div className="member-action-row" key={id}>{person && <Avatar member={person}/>}<span>{person?.name??'Someone'}</span>{id===canvas.createdByUserId && <Badge>Creator</Badge>}</div>;
        })}</div>
        <p className="canvas-share-visibility"><strong>Who can interact with artifacts</strong>{artifacts}</p>
        <p className="canvas-share-note">Only {owner.name} and the Organization’s administrators can change sharing.</p>
      </div>
    </Modal>;
  }
  const save=async(selection:CanvasSharingSelection):Promise<void>=>{
    if(!api) throw new Error('sharing_api_unavailable');
    const typed=guestOpen?emails.split(/[\s,;]+/u).filter(Boolean):[];
    const parsed=typed.length ? CreateScopeInvitationsSchema.shape.emails.safeParse(typed) : {success:true as const,data:[] as string[]};
    if(!parsed.success){setFailure('emails');throw new Error('sharing_emails_invalid');}
    try {
      const updated=await api.setCanvasAudience(canvas.id,{
        visibility:selection.editors,
        userIds:selection.editors==='creator'?[]:selection.editorIds.filter(id=>selection.editors!=='workspace'||membersById.get(id)?.accessClass==='guest').map(asUserId),
        artifactVisibility:selection.artifacts,
        artifactUserIds:selection.artifacts==='participants'||selection.artifacts==='workspace'?selection.artifactUserIds.map(asUserId):[],
        ...(revision.current!==undefined?{expectedRevision:revision.current}:{}),
      });
      revision.current=updated.sharingRevision;
      queryClient.setQueryData(canvasDetailQueryKey(canvas.id),updated);
    }catch(error){setFailure(error instanceof ApiError && error.code==='canvas_sharing_changed'?'changed':'save');throw error;}
    if(parsed.data.length)try{await invite.mutateAsync([...new Set(parsed.data)].sort());}
    catch(error){setFailure('invitations');throw error;}
    onOpenChange(false);
  };
  const requests=canvas.pendingAccessRequests??[];
  return <CanvasSharingDialog open title={canvas.title} owner={owner} members={members??[]} currentUserId={session?.user.id}
    initialSelection={{editors:canvas.visibility,editorIds:canvas.participantUserIds,artifacts:canvas.artifactVisibility??'editors',artifactUserIds:canvas.artifactUserIds??[]}}
    artifactLink={link.data?.canonicalUrl} onOpenChange={onOpenChange} onSave={save} saveFailure={failure} editorNote={canvas.writerSidekickId ? 'Editors include everyone the Sidekick that writes this Canvas is shared with.' : undefined}
    onCopyLink={async()=>{if(link.data)await desktopBridge().copyText(link.data.canonicalUrl);}}
    beforeEditors={requests.length>0 && <section aria-label="Requests" className="canvas-share-requests"><h3 className="canvas-share-heading">Requests</h3><div className="member-action-list" role="list">{requests.map(request=><div role="listitem" className="member-action-row canvas-share-request" key={request.userId}>
      {membersById.get(request.userId) && <Avatar member={membersById.get(request.userId)!}/>}<span><strong>{request.name}</strong><small>{request.message}<span className="canvas-share-request-time">{request.message?' · ':null}<RelativeTime value={request.requestedAt}/></span></small></span>
      <AccessDecisionActions canvasId={canvas.id} label={request.name} userId={request.userId}/></div>)}</div></section>}
    editorExtras={api && session?.workspace && <details className="canvas-share-guests" onToggle={event=>setGuestOpen(event.currentTarget.open)}>
      <summary><IconChevronRight aria-hidden="true" className="canvas-share-guests-chevron" size={14} stroke={2}/>Invite a guest by email</summary>
      <label className="form-field">Email addresses<textarea aria-label="Email addresses" value={emails} onChange={event=>setEmails(event.target.value)} placeholder="person@example.com" rows={2}/></label>
      <p className="canvas-share-note">Guests invited here can read and converse in the Canvas. They are invited when you save.</p>
    </details>}
  />;
}
