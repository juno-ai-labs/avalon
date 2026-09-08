import { PROJECT_ICONS } from './project-icons';
import { compareWorkstreamRecency } from '../lib/format';
import * as Tooltip from '@radix-ui/react-tooltip';
import { IconLock, IconPlus, IconTriangle } from '@tabler/icons-react';
import clsx from 'clsx';

import { Fragment, useRef, useState, type ReactNode } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import {
  PROJECT_COLOR_KEYS,
  PROJECT_ICON_KEYS,
  type CreateProjectRequest,
  type ProjectColorKey,
  type ProjectIconKey,
  type ProjectSummary,
} from '@rally/contracts';

import { Button, DropdownSelect, IconButton, InlineError, Modal } from './primitives';
import { SidebarSkeletonRows } from './sidebar-skeleton';
import type { WorkstreamSummary } from '../lib/types';



function label(value: string): string {
  if (value === 'orange') return 'Neon yellow';
  return value.split('-').map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`).join(' ');
}

export function ProjectIcon({ project, size = 15 }: { project: ProjectSummary; size?: number }): React.JSX.Element {
  const Icon = PROJECT_ICONS[project.iconKey];
  return (
    <Icon
      aria-hidden="true"
      size={size}
      stroke={`var(--av-sys-color-project-${project.colorKey})`}
      strokeWidth={1.8}
    />
  );
}

export function ProjectAppearancePicker({
  colorKey,
  iconKey,
  onColorChange,
  onIconChange,
}: {
  colorKey: ProjectColorKey;
  iconKey: ProjectIconKey;
  onColorChange: (colorKey: ProjectColorKey) => void;
  onIconChange: (iconKey: ProjectIconKey) => void;
}): React.JSX.Element {
  return (
    <div className="project-appearance-picker">
      <fieldset>
        <legend>Icon</legend>
        <div className="project-icon-grid">
          {PROJECT_ICON_KEYS.map((key) => {
            const Icon = PROJECT_ICONS[key];
            return <button aria-label={label(key)} aria-pressed={iconKey === key} className={clsx(iconKey === key && 'is-selected')} key={key} onClick={() => onIconChange(key)} type="button"><Icon aria-hidden="true" size={17} stroke={`var(--av-sys-color-project-${colorKey})`} /></button>;
          })}
        </div>
      </fieldset>
      <fieldset>
        <legend>Color</legend>
        <div className="project-color-grid">
          {PROJECT_COLOR_KEYS.map((key) => (
            <Tooltip.Root delayDuration={250} key={key}>
              <Tooltip.Trigger asChild>
                <button aria-label={label(key)} aria-pressed={colorKey === key} className={clsx(colorKey === key && 'is-selected')} onClick={() => onColorChange(key)} type="button"><span style={{ background: `var(--av-sys-color-project-${key})` }} /></button>
              </Tooltip.Trigger>
              <Tooltip.Portal><Tooltip.Content className="tooltip" sideOffset={5}>{label(key)}<Tooltip.Arrow className="tooltip-arrow" /></Tooltip.Content></Tooltip.Portal>
            </Tooltip.Root>
          ))}
        </div>
      </fieldset>
    </div>
  );
}

export function ProjectIconPile({ projects }: { projects: ProjectSummary[] }): React.JSX.Element | null {
  if (projects.length === 0) return null;
  const description = `Projects: ${projects.map((project) => project.name).join(', ')}`;
  return (
    <span aria-label={description} className="project-icon-pile" role="img" title={description}>
      {projects.map((project) => <span className="project-icon-pile-item" key={project.id}><ProjectIcon project={project} size={14} /></span>)}
    </span>
  );
}

interface ProjectSidebarSectionProps {
  projects: ProjectSummary[];
  inactiveProjects: ProjectSummary[];
  workstreams: WorkstreamSummary[];
  loading: boolean;
  onCreate: (input: CreateProjectRequest) => Promise<ProjectSummary>;
  onAddWorkstream: (projectId: string, workstreamId: string) => Promise<void>;
  onReorder: (projectIds: string[]) => Promise<void>;
  onRestore: (projectId: string) => Promise<void>;
  /** Nested members use the same row the rest of the sidebar does. */
  renderWorkstream: (workstream: WorkstreamSummary) => ReactNode;
}

export function ProjectSidebarSection({
  projects,
  inactiveProjects,
  workstreams,
  loading,
  onCreate,
  onAddWorkstream,
  onReorder,
  onRestore,
  renderWorkstream,
}: ProjectSidebarSectionProps): React.JSX.Element {
  const location = useLocation();
  const navigate = useNavigate();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [createOpen, setCreateOpen] = useState(false);
  const [recoveryOpen, setRecoveryOpen] = useState(false);
  const [name, setName] = useState('');
  const [iconKey, setIconKey] = useState<ProjectIconKey>('briefcase');
  const [colorKey, setColorKey] = useState<ProjectColorKey>('gray');
  const [scope, setScope] = useState<'personal' | 'workspace'>('personal');
  const [saving, setSaving] = useState(false);
  const [modalError, setModalError] = useState<string | null>(null);
  const [sectionError, setSectionError] = useState<string | null>(null);
  const [dragOrder, setDragOrder] = useState<string[] | null>(null);
  const dragging = useRef<string | null>(null);
  const ordered = dragOrder
    ? dragOrder.flatMap((id) => projects.find((project) => project.id === id) ?? [])
    : projects;

  const closeCreate = (): void => {
    if (saving) return;
    setCreateOpen(false);
    setName('');
    setIconKey('briefcase');
    setColorKey('gray');
    setScope('personal');
    setModalError(null);
  };

  const submit = async (): Promise<void> => {
    if (!name.trim() || saving) return;
    setSaving(true);
    setModalError(null);
    try {
      const created = await onCreate({ name: name.trim(), iconKey, colorKey, scope });
      setExpanded((current) => new Set(current).add(created.id));
      setSaving(false);
      closeCreate();
      void navigate(`/projects/${created.id}`);
    } catch (cause) {
      setModalError(cause instanceof Error ? cause.message : 'The project could not be created.');
      setSaving(false);
    }
  };

  const move = (ids: string[], id: string, position: number): string[] => {
    const rest = ids.filter((candidate) => candidate !== id);
    return [...rest.slice(0, position), id, ...rest.slice(position)];
  };

  const commit = async (ids: string[]): Promise<void> => {
    setDragOrder(ids);
    setSectionError(null);
    try {
      await onReorder(ids);
    } catch (cause) {
      setSectionError(cause instanceof Error ? cause.message : 'Projects could not be reordered.');
    } finally {
      setDragOrder(null);
    }
  };

  return (
    <>
      <section aria-labelledby="projects-heading" className="sidebar-section projects-section">
        <div className="sidebar-section-heading">
          <h2 id="projects-heading">Projects</h2>
          <IconButton className="project-sidebar-action" label="New project" onClick={() => { setModalError(null); setCreateOpen(true); }}>
            <IconPlus size={15} stroke={1.8} />
          </IconButton>
        </div>
        {loading && projects.length === 0 ? (
          // The same placeholder rows the lists below use. Projects arrive on
          // the same answer they do, so a line of prose here read as a third
          // kind of wait next to two sections already showing their shape.
          <SidebarSkeletonRows count={3} />
        ) : projects.length === 0 ? (
          <p className="sidebar-empty">{inactiveProjects.length > 0 ? 'No active projects' : 'No projects yet'}</p>
        ) : (
          <div aria-describedby="projects-reorder-help" className="sidebar-list">
            <p className="sr-only" id="projects-reorder-help">Hold Alt and press the up or down arrow to reorder projects.</p>
            {ordered.map((project, index) => {
              const isExpanded = expanded.has(project.id);
              return (
                <div
                  className="project-sidebar-item"
                  draggable
                  key={project.id}
                  onDragEnd={() => {
                    const ids = dragOrder ?? projects.map((item) => item.id);
                    dragging.current = null;
                    if (ids.join() !== projects.map((item) => item.id).join()) void commit(ids);
                    else setDragOrder(null);
                  }}
                  onDragEnter={(event) => {
                    event.preventDefault();
                    const active = dragging.current;
                    if (!active || active === project.id) return;
                    setDragOrder((current) => move(current ?? projects.map((item) => item.id), active, index));
                  }}
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={(event) => {
                    const workstreamId = event.dataTransfer.getData('application/x-rally-workstream-id');
                    if (!workstreamId) return;
                    event.preventDefault();
                    event.stopPropagation();
                    dragging.current = null;
                    void onAddWorkstream(project.id, workstreamId).catch((cause: unknown) => {
                      setSectionError(cause instanceof Error ? cause.message : 'The work stream could not be added.');
                    });
                  }}
                  onDragStart={(event) => {
                    dragging.current = project.id;
                    setDragOrder(projects.map((item) => item.id));
                    event.dataTransfer.effectAllowed = 'move';
                    event.dataTransfer.setData('application/x-rally-project-id', project.id);
                  }}
                >
                  <div
                    className={clsx(
                      'sidebar-row project-sidebar-row',
                      (location.pathname === `/projects/${project.id}`
                        || location.pathname.startsWith(`/projects/${project.id}/`))
                        && 'is-active',
                    )}
                  >
                    <button
                      aria-expanded={isExpanded}
                      aria-label={`${isExpanded ? 'Collapse' : 'Expand'} ${project.name}`}
                      className="project-accordion-control"
                      onClick={() => setExpanded((current) => {
                        const next = new Set(current);
                        if (next.has(project.id)) next.delete(project.id);
                        else next.add(project.id);
                        return next;
                      })}
                      type="button"
                    >
                      <IconTriangle className={clsx(isExpanded && 'is-expanded')} size={10} stroke={1.8} />
                    </button>
                    <NavLink
                      className={({ isActive }) => clsx('project-row-link', isActive && 'is-active')}
                      onClick={() => setExpanded((current) => {
                        const next = new Set(current);
                        if (location.pathname === `/projects/${project.id}` && next.has(project.id)) {
                          next.delete(project.id);
                        } else {
                          next.add(project.id);
                        }
                        return next;
                      })}
                      onKeyDown={(event) => {
                        if (!event.altKey || !['ArrowUp', 'ArrowDown'].includes(event.key)) return;
                        event.preventDefault();
                        const destination = event.key === 'ArrowUp' ? index - 1 : index + 1;
                        if (destination < 0 || destination >= projects.length) return;
                        void commit(move(projects.map((item) => item.id), project.id, destination));
                      }}
                      to={`/projects/${project.id}`}
                    >
                      <span className="project-row-icon"><ProjectIcon project={project} /></span>
                      <span>{project.name}</span>
                      {project.scope === 'personal' && <IconLock aria-label="Private project" size={12} stroke={1.8} />}
                      <span />
                    </NavLink>
                    <IconButton
                      className="project-sidebar-action project-sidebar-row-action"
                      label={`New work stream in ${project.name}`}
                      onClick={() => void navigate(`/projects/${project.id}/workstreams/new`)}
                    >
                      <IconPlus size={14} stroke={1.8} />
                    </IconButton>
                  </div>
                  {isExpanded && (() => {
                    const members = workstreams
                      .filter((workstream) => project.workstreamIds.includes(workstream.id))
                      .sort(compareWorkstreamRecency);
                    const missing = project.workstreamIds.length - members.length;
                    return project.workstreamIds.length === 0
                      ? <p className="project-sidebar-empty">No work streams</p>
                      : <div className="project-sidebar-workstreams">{members.map((workstream) => (
                        <Fragment key={workstream.id}>{renderWorkstream(workstream)}</Fragment>
                      ))}{missing > 0 && <p className="project-sidebar-empty">{project.workstreamIds.length} work streams; load more to see all</p>}</div>;
                  })()}
                </div>
              );
            })}
          </div>
        )}
        {sectionError && <InlineError>{sectionError}</InlineError>}
      </section>
      <Modal
        footer={<>
          {inactiveProjects.length > 0 && <Button disabled={saving} onClick={() => { closeCreate(); setRecoveryOpen(true); }}>Restore archived project</Button>}
          <Button disabled={saving} onClick={closeCreate}>Cancel</Button>
          <Button className="button-primary" disabled={saving || !name.trim()} onClick={() => void submit()}>Create project</Button>
        </>}
        onOpenChange={(open) => open ? setCreateOpen(true) : closeCreate()}
        open={createOpen}
        title="New project"
      >
        <form className="project-create-form" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
          <label className="form-field">
            <span>Name</span>
            <input autoFocus onChange={(event) => setName(event.target.value)} value={name} />
          </label>
          <ProjectAppearancePicker colorKey={colorKey} iconKey={iconKey} onColorChange={setColorKey} onIconChange={setIconKey} />
          <div className="form-field">
            <span>Who can see this project?</span>
            <DropdownSelect
              ariaLabel="Project scope"
              onValueChange={(value) => setScope(value as 'personal' | 'workspace')}
              options={[
                { label: 'Project participants', value: 'personal' },
                { label: 'Everyone in the workspace', value: 'workspace' },
              ]}
              value={scope}
            />
          </div>
          {modalError && <InlineError>{modalError}</InlineError>}
        </form>
      </Modal>
      <Modal
        footer={<Button onClick={() => { setModalError(null); setRecoveryOpen(false); }}>Cancel</Button>}
        onOpenChange={(open) => { if (!open) setModalError(null); setRecoveryOpen(open); }}
        open={recoveryOpen}
        title="Restore archived project"
      >
        <div className="project-recovery-list">{inactiveProjects.map((project) => (
          <Button key={project.id} onClick={() => {
            setModalError(null);
            void onRestore(project.id)
              .then(() => { setRecoveryOpen(false); void navigate(`/projects/${project.id}`); })
              .catch((cause: unknown) => setModalError(cause instanceof Error ? cause.message : 'The project could not be restored.'));
          }}><ProjectIcon project={project} /> {project.name}</Button>
        ))}</div>
        {modalError && <InlineError>{modalError}</InlineError>}
      </Modal>
    </>
  );
}
