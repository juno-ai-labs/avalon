import { IconLayoutSidebar, IconMessage, IconShare, IconSparkles } from '@tabler/icons-react';
import { ErrorNoticeProvider } from '@rally/ui/components/error-notice';
import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';

import { CanvasSharingDialog, type CanvasSharingSelection } from '../components/canvas-sharing-dialog';
import { Avatar, Button } from '../components/primitives';
import type { WorkspaceMember } from '../lib/types';
import '../styles/app.css';
import './canvas-sharing.css';

const owner: WorkspaceMember = { id: 'preview-owner', name: 'Jamie Lee', email: 'jamie@example.com', timezone: 'America/Los_Angeles' };
const members: WorkspaceMember[] = [owner,
  { id: 'preview-alex', name: 'Alex Chen', email: 'alex@example.com', timezone: 'America/Los_Angeles' },
  { id: 'preview-sam', name: 'Sam Rivera', email: 'sam@example.com', timezone: 'America/Los_Angeles' },
  { id: 'preview-maya', name: 'Maya Patel', email: 'maya@example.com', timezone: 'America/Los_Angeles', accessClass: 'guest' },
];
const artifactLink = 'https://calm-blue-weekly-planner.rallyusercontent.com';

function CanvasSharingPreview(): React.JSX.Element {
  const [open, setOpen] = useState(true);
  const [saved, setSaved] = useState(false);
  const [selection, setSelection] = useState<CanvasSharingSelection>({ editors: 'participants', editorIds: ['preview-alex'], artifacts: 'public', artifactUserIds: [] });
  return <>
    <main className="sharing-preview-shell">
      <aside className="sharing-preview-sidebar"><strong>Rally</strong><p><IconLayoutSidebar size={17} />Canvases</p><div className="sharing-preview-active">Weekly planner</div><p><IconSparkles size={17} />Sidekicks</p><div className="sharing-preview-account"><Avatar member={owner} /><span>Jamie Lee<small>Design team</small></span></div></aside>
      <div className="sharing-preview-canvas">
        <header><h1>Weekly planner</h1><Button onClick={() => { setOpen(true); setSaved(false); }}><IconShare size={16} />Share</Button></header>
        <div className="sharing-preview-work"><section className="sharing-preview-chat"><p className="sharing-preview-message">Make a reusable weekly planner our team can use.</p><p><IconSparkles size={18} />I’ll make a weekly planner with tasks, priorities and room for notes.</p><div className="sharing-preview-composer"><IconMessage size={16} />Message Rally…</div></section><section className="sharing-preview-planner"><p>YOUR WEEK, AT A GLANCE</p><h2>A little structure.<br />A clearer week.</h2><div className="sharing-preview-days">{['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'].map((day) => <div key={day}><strong>{day}</strong><p>○ Top priority</p><p>○ Make time for…</p></div>)}</div></section></div>
        {!open && <p className="sharing-preview-result" role="status">{saved ? 'Preview selections saved locally.' : 'Preview closed.'} <Button onClick={() => setOpen(true)}>Open sharing</Button></p>}
      </div>
    </main>
    <CanvasSharingDialog open={open} title="Weekly planner" owner={owner} members={members} initialSelection={selection} artifactLink={artifactLink} onOpenChange={setOpen} onSave={(next) => { setSelection(next); setSaved(true); setOpen(false); }} onCopyLink={() => navigator.clipboard.writeText(artifactLink)} />
  </>;
}

const root = document.getElementById('root');
if (!root) throw new Error('Sharing preview root is missing');
createRoot(root).render(<StrictMode><ErrorNoticeProvider><CanvasSharingPreview /></ErrorNoticeProvider></StrictMode>);
