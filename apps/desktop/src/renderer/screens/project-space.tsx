import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, FolderPlus, RotateCcw, Settings, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { NavLink, useNavigate, useParams } from 'react-router-dom';
import {
  PROJECT_COLOR_KEYS,
  PROJECT_ICON_KEYS,
  type ProjectColorKey,
  type ProjectDirectory,
  type ProjectIconKey,
} from '@rally/contracts';

import { ProjectIcon } from '../components/project-sidebar-section';
import { Button, EmptyState, InlineError, LoadingState, Modal, StatusDot } from '../components/primitives';
import { useAppSession } from '../lib/app-session';
import { formatRelative, workstreamMarkerStatus } from '../lib/format';
import { useWorkstreamsQuery } from '../lib/use-workstreams-query';

export function ProjectSpaceScreen(): React.JSX.Element {
  const { api } = useAppSession();
  const navigate = useNavigate();
  const { projectId } = useParams<{ projectId: string }>();
  const queryClient = useQueryClient();
  const workstreams = useWorkstreamsQuery();
  const [resourceId, setResourceId] = useState('');
  const [savingResource, setSavingResource] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [archiveConfirmOpen, setArchiveConfirmOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [editName, setEditName] = useState('');
  const [editScope, setEditScope] = useState<'personal' | 'workspace'>('personal');
  const [editIconKey, setEditIconKey] = useState<ProjectIconKey>('briefcase');
  const [editColorKey, setEditColorKey] = useState<ProjectColorKey>('blue');
  const [editParticipants, setEditParticipants] = useState<Set<string>>(new Set());
  const projects = useQuery({
    queryKey: ['projects'],
    queryFn: ({ signal }) => api!.getProjects(signal),
    enabled: Boolean(api),
  });
  const resources = useQuery({
    queryKey: ['project-resource-picker'],
    queryFn: ({ signal }) => api!.listResources({ limit: 100, signal }),
    enabled: Boolean(api),
  });
  const inactiveProjects = useQuery({
    queryKey: ['projects-inactive'],
    queryFn: ({ signal }) => api!.getInactiveProjects(signal),
    enabled: Boolean(api),
  });
  const workspaceMembers = useQuery({
    queryKey: ['workspace-members'],
    queryFn: ({ signal }) => api!.getWorkspaceMembers(signal),
    enabled: Boolean(api),
  });
  if (projects.isLoading || inactiveProjects.isLoading) return <LoadingState label="Opening project…" />;
  const project = projects.data?.items.find((item) => item.id === projectId)
    ?? inactiveProjects.data?.items.find((item) => item.id === projectId);
  if (!project) return <EmptyState title="Project not found" description="It may have been archived or you may no longer have access." />;
  const members = (workstreams.data ?? [])
    .filter((workstream) => project.workstreamIds.includes(workstream.id))
    .sort((left, right) => (
      new Date(right.lastActivityAt).getTime() - new Date(left.lastActivityAt).getTime()
      || left.id.localeCompare(right.id)
    ));
  const resourcesById = new Map((resources.data?.items ?? []).map((resource) => [resource.id, resource]));
  const updateProject = (updated: typeof project): void => {
    queryClient.setQueryData<ProjectDirectory>(['projects'], (current) => current ? {
      ...current,
      items: current.items.map((item) => item.id === updated.id ? updated : item),
    } : current);
  };
  const addResource = async (): Promise<void> => {
    if (!api || !resourceId || savingResource) return;
    setSavingResource(true);
    setError(null);
    try {
      updateProject(await api.addProjectDefaultResource(project.id, resourceId));
      setResourceId('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The resource could not be added.');
    } finally {
      setSavingResource(false);
    }
  };
  return (
    <div className="project-space-screen">
      <div className="screen-drag-strip window-drag" />
      <header className="project-space-header window-drag">
        <span className="project-space-icon"><ProjectIcon project={project} size={24} /></span>
        <div><h1>{project.name}</h1><p>{project.scope === 'personal' ? 'Project participants' : 'Everyone in the workspace'} · {project.participants.length} participant{project.participants.length === 1 ? '' : 's'}</p></div>
        <div className="project-space-header-actions window-no-drag">
        {project.status === 'active' && <Button onClick={() => {
          setEditName(project.name);
          setEditScope(project.scope);
          setEditIconKey(project.iconKey);
          setEditColorKey(project.colorKey);
          setEditParticipants(new Set(project.participants.filter((participant) => participant.state === 'active').map((participant) => participant.userId)));
          setSettingsOpen(true);
        }}><Settings aria-hidden="true" size={15} /> Settings</Button>}
        <Button onClick={() => {
          if (!api) return;
          if (project.status === 'active') {
            setArchiveConfirmOpen(true);
            return;
          }
          setError(null);
          void api.restoreProject(project.id).then(async () => {
            await Promise.all([
              queryClient.invalidateQueries({ queryKey: ['projects'] }),
              queryClient.invalidateQueries({ queryKey: ['projects-inactive'] }),
            ]);
          }).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'The project could not be updated.'));
        }}>{project.status === 'active' ? <><Archive aria-hidden="true" size={15} /> Archive project</> : <><RotateCcw aria-hidden="true" size={15} /> Restore project</>}</Button>
        </div>
      </header>
      <section className="project-space-section" aria-labelledby="project-workstreams-heading">
        <div className="project-space-section-heading"><h2 id="project-workstreams-heading">Work streams</h2></div>
        {members.length === 0
          ? <EmptyState title="No work streams yet" description="Start one with the plus button beside this project in the sidebar." />
          : <div className="waiting-workstream-list project-workstream-table">{members.map((workstream) => (
            <div className="project-workstream-table-row" key={workstream.id}>
            <NavLink className="waiting-workstream-row" to={`/workstreams/${workstream.id}`}>
              <StatusDot status={workstreamMarkerStatus(workstream)} />
              <span className="waiting-workstream-copy"><strong>{workstream.title}</strong>{workstream.preview && <span>{workstream.preview}</span>}</span>
              <time dateTime={workstream.lastActivityAt}>{formatRelative(workstream.lastActivityAt)}</time>
            </NavLink>
            <Button onClick={() => {
              if (!api) return;
              setError(null);
              void api.removeWorkstreamFromProject(project.id, workstream.id)
                .then(updateProject)
                .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'The work stream could not be removed.'));
            }}>Remove</Button>
            </div>
          ))}</div>}
      </section>
      <section className="project-space-section" aria-labelledby="project-resources-heading">
        <div className="project-space-section-heading"><h2 id="project-resources-heading">Default resources</h2></div>
        <p className="project-space-muted">Resources added here are attached to every work stream in this project.</p>
        <div className="project-resource-picker">
          <label className="form-field"><span>Resource</span><select onChange={(event) => setResourceId(event.target.value)} value={resourceId}>
            <option value="">Choose a resource…</option>
            {(resources.data?.items ?? []).filter((resource) => !project.defaultResourceIds.includes(resource.id)).map((resource) => (
              <option key={resource.id} value={resource.id}>{resource.title}</option>
            ))}
          </select></label>
          <Button disabled={project.status !== 'active' || !resourceId || savingResource} onClick={() => void addResource()}><FolderPlus aria-hidden="true" size={15} /> Add resource</Button>
        </div>
        {project.defaultResourceIds.length === 0 ? <p className="project-space-muted">No default resources</p> : (
          <ul className="project-default-resource-list">{project.defaultResourceIds.map((id) => (
            <li key={id}><span>{resourcesById.get(id)?.title ?? 'Resource'}</span><Button disabled={project.status !== 'active' || savingResource} onClick={() => {
              if (!api) return;
              setSavingResource(true);
              setError(null);
              void api.removeProjectDefaultResource(project.id, id)
                .then(updateProject)
                .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'The resource could not be removed.'))
                .finally(() => setSavingResource(false));
            }}><Trash2 aria-hidden="true" size={14} /> Remove</Button></li>
          ))}</ul>
        )}
        {error && <InlineError>{error}</InlineError>}
      </section>
      <Modal
        footer={<><Button onClick={() => setArchiveConfirmOpen(false)}>Cancel</Button><Button className="button-danger" onClick={() => {
          if (!api) return;
          setError(null);
          void api.archiveProject(project.id).then(async () => {
            setArchiveConfirmOpen(false);
            await Promise.all([
              queryClient.invalidateQueries({ queryKey: ['projects'] }),
              queryClient.invalidateQueries({ queryKey: ['projects-inactive'] }),
            ]);
            void navigate('/workstreams/new');
          }).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'The project could not be archived.'));
        }}>Archive project</Button></>}
        onOpenChange={setArchiveConfirmOpen}
        open={archiveConfirmOpen}
        title="Archive project?"
      >
        <p>Its work streams and resources stay where they are. The project can be restored later.</p>
      </Modal>
      <Modal
        footer={<><Button onClick={() => setSettingsOpen(false)}>Cancel</Button><Button className="button-primary" disabled={!editName.trim() || editParticipants.size === 0} onClick={() => {
          if (!api) return;
          setError(null);
          void api.updateProject(project.id, { name: editName.trim(), iconKey: editIconKey, colorKey: editColorKey })
            .then(() => api.updateProjectAudience(project.id, { scope: editScope, participantUserIds: [...editParticipants] }))
            .then((updated) => { updateProject(updated); setSettingsOpen(false); })
            .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'Project settings could not be saved.'));
        }}>Save changes</Button></>}
        onOpenChange={setSettingsOpen}
        open={settingsOpen}
        title="Project settings"
      >
        <label className="form-field"><span>Name</span><input onChange={(event) => setEditName(event.target.value)} value={editName} /></label>
        <label className="form-field"><span>Icon</span><select onChange={(event) => setEditIconKey(event.target.value as ProjectIconKey)} value={editIconKey}>{PROJECT_ICON_KEYS.map((key) => <option key={key} value={key}>{key}</option>)}</select></label>
        <label className="form-field"><span>Color</span><select onChange={(event) => setEditColorKey(event.target.value as ProjectColorKey)} value={editColorKey}>{PROJECT_COLOR_KEYS.map((key) => <option key={key} value={key}>{key}</option>)}</select></label>
        <label className="form-field"><span>Scope</span><select onChange={(event) => setEditScope(event.target.value as 'personal' | 'workspace')} value={editScope}><option value="personal">Personal</option><option value="workspace">Workspace</option></select></label>
        <fieldset><legend>Participants</legend><div className="project-participant-list">{(workspaceMembers.data ?? []).map((member) => (
          <label key={member.id}><input checked={editParticipants.has(member.id)} onChange={() => setEditParticipants((current) => {
            const next = new Set(current);
            if (next.has(member.id)) next.delete(member.id); else next.add(member.id);
            return next;
          })} type="checkbox" /> {member.name}</label>
        ))}</div></fieldset>
        {error && <InlineError>{error}</InlineError>}
      </Modal>
    </div>
  );
}
