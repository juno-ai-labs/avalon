import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, FileText, FolderPlus, RotateCcw, Trash2, UserPlus } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { NavLink, useNavigate, useParams } from 'react-router-dom';
import {
  type ProjectColorKey,
  type ProjectDirectory,
  type ProjectIconKey,
} from '@rally/contracts';

import { ProjectAppearancePicker, ProjectIcon } from '../components/project-sidebar-section';
import {
  Avatar,
  AvatarStack,
  Button,
  DropdownSelect,
  EmptyState,
  InlineError,
  LoadingState,
  Modal,
  StatusDot,
} from '../components/primitives';
import { useAppSession } from '../lib/app-session';
import { formatRelative, workstreamMarkerStatus } from '../lib/format';
import { isComposingKeyEvent } from '../lib/ime';
import { useProjectDirectories } from '../lib/use-project-directories';
import { useWorkstreamsQuery } from '../lib/use-workstreams-query';

export function ProjectSpaceScreen(): React.JSX.Element {
  const { api } = useAppSession();
  const navigate = useNavigate();
  const { projectId } = useParams<{ projectId: string }>();
  const queryClient = useQueryClient();
  const workstreams = useWorkstreamsQuery();
  const [resourcePickerOpen, setResourcePickerOpen] = useState(false);
  const [selectedResourceIds, setSelectedResourceIds] = useState<Set<string>>(new Set());
  const [savingResource, setSavingResource] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [archiveConfirmOpen, setArchiveConfirmOpen] = useState(false);
  const [appearanceOpen, setAppearanceOpen] = useState(false);
  const [savingAppearance, setSavingAppearance] = useState(false);
  const [appearanceError, setAppearanceError] = useState<string | null>(null);
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);
  const [savingName, setSavingName] = useState(false);
  const nameSaveInFlight = useRef(false);
  const [participantsOpen, setParticipantsOpen] = useState(false);
  const [savingParticipants, setSavingParticipants] = useState(false);
  const [participantsError, setParticipantsError] = useState<string | null>(null);
  const [pendingScope, setPendingScope] = useState<'personal' | 'workspace' | null>(null);
  const [savingScope, setSavingScope] = useState(false);
  const [scopeError, setScopeError] = useState<string | null>(null);
  const [editIconKey, setEditIconKey] = useState<ProjectIconKey>('briefcase');
  const [editColorKey, setEditColorKey] = useState<ProjectColorKey>('blue');
  const [editParticipants, setEditParticipants] = useState<Set<string>>(new Set());
  const { active: projects, inactive: inactiveProjects } = useProjectDirectories();
  const resources = useQuery({
    queryKey: ['project-resource-picker'],
    queryFn: ({ signal }) => api!.listResources({ limit: 100, signal }),
    enabled: Boolean(api),
  });
  const workspaceMembers = useQuery({
    queryKey: ['workspace-members'],
    queryFn: ({ signal }) => api!.getWorkspaceMembers(signal),
    enabled: Boolean(api),
  });
  useEffect(() => {
    setNameDraft(null);
    setNameError(null);
    setSavingName(false);
    nameSaveInFlight.current = false;
  }, [projectId]);
  if (projects.data === undefined || inactiveProjects.data === undefined) {
    return <LoadingState label="Opening project…" />;
  }
  const project = projects.data?.items.find((item) => item.id === projectId)
    ?? inactiveProjects.data?.items.find((item) => item.id === projectId);
  if (!project) return <EmptyState title="Project not found" description="It may have been archived or you may no longer have access." />;
  const members = (workstreams.data ?? [])
    .filter((workstream) => project.workstreamIds.includes(workstream.id))
    .sort((left, right) => (
      new Date(right.lastActivityAt).getTime() - new Date(left.lastActivityAt).getTime()
      || left.id.localeCompare(right.id)
    ));
  const activeParticipantIds = new Set(project.participants
    .filter((participant) => participant.state === 'active')
    .map((participant) => participant.userId));
  const projectMembers = (workspaceMembers.data ?? []).filter((member) => activeParticipantIds.has(member.id));
  const resourcesById = new Map((resources.data?.items ?? []).map((resource) => [resource.id, resource]));
  const updateProject = (updated: typeof project): void => {
    for (const queryKey of [['projects'], ['projects-inactive']] as const) {
      queryClient.setQueryData<ProjectDirectory>(queryKey, (current) => current ? {
        ...current,
        items: current.items.map((item) => item.id === updated.id ? updated : item),
      } : current);
    }
  };
  const saveName = async (): Promise<void> => {
    const name = nameDraft?.trim() ?? '';
    if (!api || !name || nameSaveInFlight.current) return;
    if (name === project.name) {
      setNameDraft(null);
      return;
    }
    nameSaveInFlight.current = true;
    setSavingName(true);
    setNameError(null);
    try {
      updateProject(await api.updateProject(project.id, {
        name,
        iconKey: project.iconKey,
        colorKey: project.colorKey,
      }));
      setNameDraft(null);
    } catch (cause) {
      setNameError(cause instanceof Error ? cause.message : 'The project name could not be saved.');
    } finally {
      nameSaveInFlight.current = false;
      setSavingName(false);
    }
  };
  const addResources = async (): Promise<void> => {
    if (!api || selectedResourceIds.size === 0 || savingResource) return;
    setSavingResource(true);
    setError(null);
    try {
      for (const resourceId of selectedResourceIds) {
        updateProject(await api.addProjectDefaultResource(project.id, resourceId));
      }
      setSelectedResourceIds(new Set());
      setResourcePickerOpen(false);
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
        {project.status === 'active'
          ? <button
              aria-label={`Change icon and color for ${project.name}`}
              className="project-space-icon window-no-drag"
              onClick={() => {
                setEditIconKey(project.iconKey);
                setEditColorKey(project.colorKey);
                setAppearanceError(null);
                setAppearanceOpen(true);
              }}
              type="button"
            ><ProjectIcon project={project} size={24} /></button>
          : <span className="project-space-icon"><ProjectIcon project={project} size={24} /></span>}
        <div className="project-space-title">
          {nameDraft === null
            ? <h1><button
                aria-keyshortcuts="Enter F2"
                className="project-name-button window-no-drag"
                onClick={(event) => {
                  if (event.detail === 0 && project.status === 'active') setNameDraft(project.name);
                }}
                onDoubleClick={() => {
                  if (project.status === 'active') {
                    setNameError(null);
                    setNameDraft(project.name);
                  }
                }}
                onKeyDown={(event) => {
                  if (event.key === 'F2' && project.status === 'active') {
                    event.preventDefault();
                    setNameError(null);
                    setNameDraft(project.name);
                  }
                }}
                title={project.status === 'active' ? 'Double-click to rename' : undefined}
                type="button"
              >{project.name}</button></h1>
            : <input
                aria-label="Project name"
                autoFocus
                className="project-name-input window-no-drag"
                disabled={savingName}
                maxLength={180}
                onBlur={() => void saveName()}
                onChange={(event) => {
                  setNameDraft(event.currentTarget.value);
                  setNameError(null);
                }}
                onFocus={(event) => event.currentTarget.select()}
                onKeyDown={(event) => {
                  if (isComposingKeyEvent(event.nativeEvent)) return;
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    void saveName();
                  } else if (event.key === 'Escape') {
                    event.preventDefault();
                    setNameDraft(null);
                    setNameError(null);
                  }
                }}
                size={Math.max(6, Math.min(40, nameDraft.length + 1))}
                value={nameDraft}
              />}
          <p className="project-space-audience">
            <span className="window-no-drag">
              <DropdownSelect
                ariaLabel="Project scope"
                disabled={project.status !== 'active'}
                onValueChange={(value) => {
                  const scope = value as 'personal' | 'workspace';
                  if (scope !== project.scope) {
                    setScopeError(null);
                    setPendingScope(scope);
                  }
                }}
                options={[
                  { label: 'Project participants', value: 'personal' },
                  { label: 'Everyone in the workspace', value: 'workspace' },
                ]}
                value={project.scope}
                variant="secondary"
              />
            </span>
          </p>
          {nameError && <InlineError>{nameError}</InlineError>}
        </div>
        <div className="project-space-header-actions window-no-drag">
        {project.status === 'active' && <button
          className="participant-header-button"
          onClick={() => {
            setEditParticipants(new Set(activeParticipantIds));
            setParticipantsError(null);
            setParticipantsOpen(true);
          }}
          type="button"
        >
          <AvatarStack members={projectMembers} />
          <UserPlus aria-hidden="true" size={13} />
          <span className="sr-only">Add participant</span>
        </button>}
        <Button onClick={() => {
          if (!api) return;
          if (project.status === 'active') {
            setArchiveConfirmOpen(true);
            return;
          }
          setError(null);
          void api.restoreProject(project.id).then((restored) => {
            queryClient.setQueryData<ProjectDirectory>(['projects-inactive'], (current) => current ? {
              ...current,
              items: current.items.filter((item) => item.id !== restored.id),
            } : current);
            queryClient.setQueryData<ProjectDirectory>(['projects'], (current) => current ? {
              ...current,
              items: current.items.some((item) => item.id === restored.id)
                ? current.items.map((item) => item.id === restored.id ? restored : item)
                : [...current.items, restored],
            } : current);
          }).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'The project could not be updated.'));
        }}>{project.status === 'active' ? <><Archive aria-hidden="true" size={15} /> Archive project</> : <><RotateCcw aria-hidden="true" size={15} /> Restore project</>}</Button>
        </div>
      </header>
      <section className="project-space-section" aria-labelledby="project-workstreams-heading">
        <div className="project-space-section-heading"><h2 id="project-workstreams-heading">Work streams</h2></div>
        {members.length === 0
          ? project.workstreamIds.length === 0
            ? <EmptyState title="No work streams yet" description="Start one with the plus button beside this project in the sidebar." />
            : <EmptyState title={`${project.workstreamIds.length} work stream${project.workstreamIds.length === 1 ? '' : 's'}`} description="Load more recent work streams in the sidebar to see every project member." />
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
          ))}{members.length < project.workstreamIds.length && <p className="project-space-muted">Showing {members.length} of {project.workstreamIds.length} work streams. Load more in the sidebar to see all.</p>}</div>}
      </section>
      <section className="project-space-section" aria-labelledby="project-resources-heading">
        <div className="project-space-section-heading">
          <div className="project-space-section-copy">
            <h2 id="project-resources-heading">Default resources</h2>
            <p className="project-space-muted">Resources added here are attached to every work stream in this project.</p>
          </div>
          <Button disabled={project.status !== 'active' || savingResource} onClick={() => {
            setSelectedResourceIds(new Set());
            setError(null);
            setResourcePickerOpen(true);
          }}><FolderPlus aria-hidden="true" size={15} /> Add resource</Button>
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
          void api.archiveProject(project.id).then((archived) => {
            setArchiveConfirmOpen(false);
            queryClient.setQueryData<ProjectDirectory>(['projects'], (current) => current ? {
              ...current,
              items: current.items.filter((item) => item.id !== archived.id),
            } : current);
            queryClient.setQueryData<ProjectDirectory>(['projects-inactive'], (current) => current ? {
              ...current,
              items: current.items.some((item) => item.id === archived.id)
                ? current.items.map((item) => item.id === archived.id ? archived : item)
                : [archived, ...current.items],
            } : current);
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
        description="Choose one or more resources to attach to every work stream in this project."
        footer={<><Button disabled={savingResource} onClick={() => setResourcePickerOpen(false)}>Cancel</Button><Button className="button-primary" disabled={savingResource || selectedResourceIds.size === 0} onClick={() => void addResources()}>Add resources</Button></>}
        onOpenChange={(open) => {
          if (!savingResource) setResourcePickerOpen(open);
        }}
        open={resourcePickerOpen}
        title="Add resources"
      >
        {resources.data === undefined
          ? <LoadingState label="Loading resources…" />
          : resources.data.items.filter((resource) => !project.defaultResourceIds.includes(resource.id)).length === 0
          ? <EmptyState title="No resources to add" description="Every available resource is already a project default." />
          : <div className="member-picker-list" role="group" aria-label="Resources">
              {resources.data.items.filter((resource) => !project.defaultResourceIds.includes(resource.id)).map((resource) => (
                <label className="member-picker-row" key={resource.id}>
                  <input
                    checked={selectedResourceIds.has(resource.id)}
                    onChange={() => setSelectedResourceIds((current) => {
                      const next = new Set(current);
                      if (next.has(resource.id)) next.delete(resource.id); else next.add(resource.id);
                      return next;
                    })}
                    type="checkbox"
                  />
                  <span aria-hidden="true" className="resource-picker-icon"><FileText size={15} /></span>
                  <span><strong>{resource.title}</strong><small>{resource.provider ?? 'Rally'} · {resource.resourceType}</small></span>
                  <span aria-hidden="true" className="member-checkbox" />
                </label>
              ))}
            </div>}
        {error && <InlineError>{error}</InlineError>}
      </Modal>
      <Modal
        description="Choose the workspace members who participate in this project."
        footer={<><Button disabled={savingParticipants} onClick={() => setParticipantsOpen(false)}>Cancel</Button><Button className="button-primary" disabled={savingParticipants || editParticipants.size === 0} onClick={() => {
          if (!api) return;
          setSavingParticipants(true);
          setParticipantsError(null);
          void api.updateProjectAudience(project.id, { scope: project.scope, participantUserIds: [...editParticipants] })
            .then((updated) => {
              updateProject(updated);
              setParticipantsOpen(false);
            })
            .catch((cause: unknown) => setParticipantsError(cause instanceof Error ? cause.message : 'Project participants could not be saved.'))
            .finally(() => setSavingParticipants(false));
        }}>Save</Button></>}
        onOpenChange={(open) => {
          if (!savingParticipants) setParticipantsOpen(open);
        }}
        open={participantsOpen}
        title="Add people"
      >
        <div className="member-picker-list" role="group" aria-label="Workspace members">
          {(workspaceMembers.data ?? []).map((member) => (
            <label className="member-picker-row" key={member.id}>
              <input
                checked={editParticipants.has(member.id)}
                onChange={() => setEditParticipants((current) => {
                  const next = new Set(current);
                  if (next.has(member.id)) next.delete(member.id); else next.add(member.id);
                  return next;
                })}
                type="checkbox"
              />
              <Avatar member={member} size="medium" />
              <span><strong>{member.name}</strong><small>{member.email}</small></span>
              <span aria-hidden="true" className="member-checkbox" />
            </label>
          ))}
        </div>
        {participantsError && <InlineError>{participantsError}</InlineError>}
      </Modal>
      <Modal
        footer={<><Button disabled={savingScope} onClick={() => setPendingScope(null)}>Cancel</Button><Button className="button-primary" disabled={savingScope} onClick={() => {
          if (!api || pendingScope === null) return;
          setSavingScope(true);
          setScopeError(null);
          void api.updateProjectAudience(project.id, {
            scope: pendingScope,
            participantUserIds: [...activeParticipantIds],
          })
            .then((updated) => {
              updateProject(updated);
              setPendingScope(null);
            })
            .catch((cause: unknown) => setScopeError(cause instanceof Error ? cause.message : 'The project scope could not be changed.'))
            .finally(() => setSavingScope(false));
        }}>Continue</Button></>}
        onOpenChange={(open) => {
          if (!open && !savingScope) setPendingScope(null);
        }}
        open={pendingScope !== null}
        title="Change project access?"
      >
        <p>{pendingScope === 'workspace'
          ? 'Everyone in the workspace will be able to see this project. Current project participants will remain participants.'
          : 'Only project participants will be able to see this project.'}</p>
        {scopeError && <InlineError>{scopeError}</InlineError>}
      </Modal>
      <Modal
        footer={<><Button disabled={savingAppearance} onClick={() => setAppearanceOpen(false)}>Cancel</Button><Button className="button-primary" disabled={savingAppearance} onClick={() => {
          if (!api) return;
          setSavingAppearance(true);
          setAppearanceError(null);
          void api.updateProject(project.id, { name: project.name, iconKey: editIconKey, colorKey: editColorKey })
            .then((updated) => {
              updateProject(updated);
              setAppearanceOpen(false);
            })
            .catch((cause: unknown) => setAppearanceError(cause instanceof Error ? cause.message : 'The icon and color could not be saved.'))
            .finally(() => setSavingAppearance(false));
        }}>Save</Button></>}
        onOpenChange={(open) => {
          if (!savingAppearance) setAppearanceOpen(open);
        }}
        open={appearanceOpen}
        title="Project icon and color"
      >
        <ProjectAppearancePicker colorKey={editColorKey} iconKey={editIconKey} onColorChange={setEditColorKey} onIconChange={setEditIconKey} />
        {appearanceError && <InlineError>{appearanceError}</InlineError>}
      </Modal>
    </div>
  );
}
