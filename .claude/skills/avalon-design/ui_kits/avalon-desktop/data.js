window.AvalonData = {
  workspace: { name: 'Juno AI Labs', region: 'European Union', member: 'Adam Jarvis', email: 'adam@juno-labs.com' },
  workstreams: [
    { id: 'launch', title: 'Plan the August launch', hint: 'Needs input · 4m', status: 'needs_input', scope: 'Marketing', unread: false, origin: 'Ad hoc' },
    { id: 'onboarding', title: 'Research onboarding gaps', hint: 'Avalon is working · 12m', status: 'running', unread: true, origin: 'Ad hoc' },
    { id: 'pricing', title: 'Update pricing narrative', hint: 'Draft ready · 18m', status: 'completed', unread: false, origin: 'Ad hoc' },
    { id: 'partner', title: 'Partner follow-up', hint: 'Waiting on Maya · 1h', status: 'idle', unread: false, origin: 'Email' }
  ],
  automations: [
    { id: 'pulse', title: 'Weekly customer pulse', hint: 'Friday · 09:00', scope: 'Workspace', state: 'active' },
    { id: 'feedback', title: 'Watch launch feedback', hint: 'Connected activity', scope: 'You', state: 'active' },
    { id: 'changelog', title: 'Weekly changelog', hint: 'Draft', scope: 'You', state: 'draft' }
  ],
  people: [
    { id: 'adam', name: 'Adam Jarvis', role: 'Created this work stream' },
    { id: 'maya', name: 'Maya Lin', role: 'Reviewing the result' }
  ],
  resources: [
    { id: 'r1', title: 'Customer interviews', meta: 'Google Drive · 12 files', icon: 'folder', watched: true },
    { id: 'r2', title: 'Launch narrative.md', meta: 'Google Docs · edited 4m ago', icon: 'file-text', watched: false },
    { id: 'r3', title: 'JUN-412 Launch page', meta: 'Linear · In progress', icon: 'square-check', watched: false }
  ],
  tasks: [
    { id: 't1', title: 'Compare launch narratives', meta: 'Avalon · Working', state: 'running' },
    { id: 't2', title: 'Summarize customer interviews', meta: 'Avalon · Completed · 2m 14s', state: 'completed' },
    { id: 't3', title: 'Collect linked resources', meta: 'Automation · Completed', state: 'completed' }
  ]
};
