import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AccessView } from './private-access';
import { QueuesView } from './queues';
import { WorkspacesView, type RetiredWorkspace } from './workspaces';
import './styles.css';

const SECTIONS = [
  { key: 'access', label: 'Access', icon: '↗' },
  { key: 'queues', label: 'Queues', icon: '⇥' },
  { key: 'workspaces', label: 'Workspaces', icon: '▦' },
] as const;

export function App(): React.JSX.Element {
  const [activeSection, setActiveSection] = useState<(typeof SECTIONS)[number]['key']>('access');
  const [operatorEmail, setOperatorEmail] = useState<string | null>(null);
  const [retiredWorkspaces, setRetiredWorkspaces] = useState(new Map<string, RetiredWorkspace>());

  useEffect(() => {
    document.title = `Ace · ${SECTIONS.find((section) => section.key === activeSection)!.label}`;
  }, [activeSection]);

  useEffect(() => {
    void fetch('/api/session').then(async (response) => response.ok
      ? await response.json() as { email?: string }
      : Promise.reject(new Error('session')))
      .then((session) => setOperatorEmail(session.email ?? null))
      .catch(() => undefined);
  }, []);

  return <div className="ace-shell">
    <aside className="primary-nav">
      <div className="brand"><span>A</span><strong>Ace</strong></div>
      <nav>{SECTIONS.map((section) => <button
        aria-current={activeSection === section.key ? 'page' : undefined}
        className={activeSection === section.key ? 'active' : ''}
        key={section.key}
        onClick={() => setActiveSection(section.key)}
        type="button"
      ><i>{section.icon}</i>{section.label}</button>)}</nav>
      <footer><span className="avatar">{operatorEmail?.[0]?.toUpperCase() ?? 'A'}</span><div>
        <strong>{operatorEmail ?? 'Internal operator'}</strong><small>Cloudflare Access</small>
      </div></footer>
    </aside>
    {activeSection === 'access' ? <AccessView />
      : activeSection === 'queues' ? <QueuesView />
          : <WorkspacesView onRetired={(record) => setRetiredWorkspaces((current) => new Map(current).set(record.workspace.id, record))} retired={retiredWorkspaces} />}
  </div>;
}

const root = typeof document === 'undefined' ? null : document.getElementById('root');
if (root) createRoot(root).render(<React.StrictMode><App /></React.StrictMode>);
