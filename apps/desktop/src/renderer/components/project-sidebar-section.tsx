import * as Tooltip from '@radix-ui/react-tooltip';
import { IconLock, IconPlus, IconTriangle } from '@tabler/icons-react';
import clsx from 'clsx';
import {
  Briefcase,
  Building2,
  Calculator,
  CalendarDays,
  ChartNoAxesCombined,
  ClipboardList,
  Coins,
  FileText,
  Flag,
  Folder,
  Globe2,
  Handshake,
  Heart,
  Image as ImageIcon,
  Lightbulb,
  ListChecks,
  Megaphone,
  Package,
  Palette,
  PenTool,
  Rocket,
  Star,
  Target,
  UserSearch,
  Users,
  type LucideIcon,
} from 'lucide-react';
import { useRef, useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import {
  PROJECT_COLOR_KEYS,
  PROJECT_ICON_KEYS,
  type CreateProjectRequest,
  type ProjectColorKey,
  type ProjectIconKey,
  type ProjectSummary,
} from '@rally/contracts';

import { Button, IconButton, InlineError, Modal } from './primitives';

const PROJECT_ICONS: Record<ProjectIconKey, LucideIcon> = {
  briefcase: Briefcase,
  target: Target,
  'calendar-days': CalendarDays,
  'list-checks': ListChecks,
  'clipboard-list': ClipboardList,
  'file-text': FileText,
  folder: Folder,
  lightbulb: Lightbulb,
  star: Star,
  flag: Flag,
  rocket: Rocket,
  'chart-no-axes-combined': ChartNoAxesCombined,
  calculator: Calculator,
  coins: Coins,
  users: Users,
  'user-search': UserSearch,
  handshake: Handshake,
  megaphone: Megaphone,
  palette: Palette,
  image: ImageIcon,
  'pen-tool': PenTool,
  package: Package,
  'building-2': Building2,
  'globe-2': Globe2,
  heart: Heart,
};

function label(value: string): string {
  return value.split('-').map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`).join(' ');
}

export function ProjectIcon({ project, size = 15 }: { project: ProjectSummary; size?: number }): React.JSX.Element {
  const Icon = PROJECT_ICONS[project.iconKey];
  return (
    <Icon
      aria-hidden="true"
      fill={`var(--av-sys-color-project-${project.colorKey})`}
      size={size}
      stroke={`var(--av-sys-color-project-${project.colorKey})`}
      strokeWidth={1.8}
    />
  );
}

interface ProjectSidebarSectionProps {
  projects: ProjectSummary[];
  loading: boolean;
  onCreate: (input: CreateProjectRequest) => Promise<void>;
  onReorder: (projectIds: string[]) => Promise<void>;
}

export function ProjectSidebarSection({
  projects,
  loading,
  onCreate,
  onReorder,
}: ProjectSidebarSectionProps): React.JSX.Element {
  const navigate = useNavigate();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState('');
  const [iconKey, setIconKey] = useState<ProjectIconKey>('briefcase');
  const [colorKey, setColorKey] = useState<ProjectColorKey>('blue');
  const [scope, setScope] = useState<'personal' | 'workspace'>('personal');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
    setColorKey('blue');
    setScope('personal');
    setError(null);
  };

  const submit = async (): Promise<void> => {
    if (!name.trim() || saving) return;
    setSaving(true);
    setError(null);
    try {
      await onCreate({ name: name.trim(), iconKey, colorKey, scope });
      setSaving(false);
      closeCreate();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The project could not be created.');
      setSaving(false);
    }
  };

  const move = (ids: string[], id: string, position: number): string[] => {
    const rest = ids.filter((candidate) => candidate !== id);
    return [...rest.slice(0, position), id, ...rest.slice(position)];
  };

  const commit = async (ids: string[]): Promise<void> => {
    setDragOrder(ids);
    try {
      await onReorder(ids);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Projects could not be reordered.');
    } finally {
      setDragOrder(null);
    }
  };

  return (
    <>
      <section aria-labelledby="projects-heading" className="sidebar-section projects-section">
        <div className="sidebar-section-heading">
          <h2 id="projects-heading">Projects</h2>
          <IconButton label="New project" onClick={() => setCreateOpen(true)}>
            <IconPlus size={15} stroke={1.8} />
          </IconButton>
        </div>
        {loading && projects.length === 0 ? (
          <p className="sidebar-empty">Loading projects…</p>
        ) : projects.length === 0 ? (
          <p className="sidebar-empty">No projects yet</p>
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
                  onDragStart={(event) => {
                    dragging.current = project.id;
                    setDragOrder(projects.map((item) => item.id));
                    event.dataTransfer.effectAllowed = 'move';
                  }}
                >
                  <div className="project-sidebar-row">
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
                    <span className="project-row-icon"><ProjectIcon project={project} /></span>
                    <NavLink
                      className={({ isActive }) => clsx('project-row-link', isActive && 'is-active')}
                      onKeyDown={(event) => {
                        if (!event.altKey || !['ArrowUp', 'ArrowDown'].includes(event.key)) return;
                        event.preventDefault();
                        const destination = event.key === 'ArrowUp' ? index - 1 : index + 1;
                        if (destination < 0 || destination >= projects.length) return;
                        void commit(move(projects.map((item) => item.id), project.id, destination));
                      }}
                      to={`/projects/${project.id}`}
                    >
                      <span>{project.name}</span>
                      {project.scope === 'personal' && <IconLock aria-label="Private project" size={12} stroke={1.8} />}
                    </NavLink>
                    <span />
                    <IconButton
                      label={`New work stream in ${project.name}`}
                      onClick={() => void navigate(`/projects/${project.id}/workstreams/new`)}
                    >
                      <IconPlus size={14} stroke={1.8} />
                    </IconButton>
                  </div>
                  {isExpanded && <p className="project-sidebar-empty">No work streams</p>}
                </div>
              );
            })}
          </div>
        )}
      </section>
      <Modal
        footer={<><Button disabled={saving} onClick={closeCreate}>Cancel</Button><Button className="button-primary" disabled={saving || !name.trim()} onClick={() => void submit()}>Create project</Button></>}
        onOpenChange={(open) => open ? setCreateOpen(true) : closeCreate()}
        open={createOpen}
        title="New project"
      >
        <form className="project-create-form" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
          <label className="form-field">
            <span>Name</span>
            <input autoFocus onChange={(event) => setName(event.target.value)} value={name} />
          </label>
          <fieldset>
            <legend>Icon</legend>
            <div className="project-icon-grid">
              {PROJECT_ICON_KEYS.map((key) => {
                const Icon = PROJECT_ICONS[key];
                return <button aria-label={label(key)} aria-pressed={iconKey === key} className={clsx(iconKey === key && 'is-selected')} key={key} onClick={() => setIconKey(key)} type="button"><Icon aria-hidden="true" size={17} /></button>;
              })}
            </div>
          </fieldset>
          <fieldset>
            <legend>Color</legend>
            <div className="project-color-grid">
              {PROJECT_COLOR_KEYS.map((key) => (
                <Tooltip.Root delayDuration={250} key={key}>
                  <Tooltip.Trigger asChild>
                    <button aria-label={label(key)} aria-pressed={colorKey === key} className={clsx(colorKey === key && 'is-selected')} onClick={() => setColorKey(key)} type="button"><span style={{ background: `var(--av-sys-color-project-${key})` }} /></button>
                  </Tooltip.Trigger>
                  <Tooltip.Portal><Tooltip.Content className="tooltip-content" sideOffset={5}>{label(key)}<Tooltip.Arrow className="tooltip-arrow" /></Tooltip.Content></Tooltip.Portal>
                </Tooltip.Root>
              ))}
            </div>
          </fieldset>
          <label className="form-field">
            <span>Who can see this project?</span>
            <select onChange={(event) => setScope(event.target.value as 'personal' | 'workspace')} value={scope}>
              <option value="personal">Project participants</option>
              <option value="workspace">Everyone in the workspace</option>
            </select>
          </label>
          {error && <InlineError>{error}</InlineError>}
        </form>
      </Modal>
    </>
  );
}
