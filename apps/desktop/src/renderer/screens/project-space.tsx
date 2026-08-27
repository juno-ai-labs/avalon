import { useQuery } from '@tanstack/react-query';
import { FolderPlus, Settings } from 'lucide-react';
import { useParams } from 'react-router-dom';

import { ProjectIcon } from '../components/project-sidebar-section';
import { Button, EmptyState, LoadingState } from '../components/primitives';
import { useAppSession } from '../lib/app-session';

export function ProjectSpaceScreen(): React.JSX.Element {
  const { api } = useAppSession();
  const { projectId } = useParams<{ projectId: string }>();
  const projects = useQuery({
    queryKey: ['projects'],
    queryFn: ({ signal }) => api!.getProjects(signal),
    enabled: Boolean(api),
  });
  if (projects.isLoading) return <LoadingState label="Opening project…" />;
  const project = projects.data?.items.find((item) => item.id === projectId);
  if (!project) return <EmptyState title="Project not found" description="It may have been archived or you may no longer have access." />;
  return (
    <div className="project-space-screen">
      <div className="screen-drag-strip window-drag" />
      <header className="project-space-header window-drag">
        <span className="project-space-icon"><ProjectIcon project={project} size={24} /></span>
        <div><h1>{project.name}</h1><p>{project.scope === 'personal' ? 'Project participants' : 'Everyone in the workspace'} · {project.participants.length} participant{project.participants.length === 1 ? '' : 's'}</p></div>
        <Button className="window-no-drag"><Settings aria-hidden="true" size={15} /> Settings</Button>
      </header>
      <section className="project-space-section" aria-labelledby="project-workstreams-heading">
        <div className="project-space-section-heading"><h2 id="project-workstreams-heading">Work streams</h2></div>
        <EmptyState title="No work streams yet" description="Start one with the plus button beside this project in the sidebar." />
      </section>
      <section className="project-space-section" aria-labelledby="project-resources-heading">
        <div className="project-space-section-heading"><h2 id="project-resources-heading">Default resources</h2><Button><FolderPlus aria-hidden="true" size={15} /> Add resource</Button></div>
        <p className="project-space-muted">Resources added here are attached to every work stream in this project.</p>
      </section>
    </div>
  );
}
