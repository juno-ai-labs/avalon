const { Icon, IconButton, RailCard, Avatar, StatusDot, Badge } = window.AvalonDesignSystem_5d1c5e;

function RailSection({ title, action, children }) {
  return (
    <section style={{ borderBottom: '1px solid #2f302b', padding: '13px 0 15px' }}>
      <header style={{ alignItems: 'center', display: 'flex', justifyContent: 'space-between', marginBottom: 8, minHeight: 23 }}>
        <h3 style={{ color: '#8e8d87', fontSize: 10.5, fontWeight: 560, margin: 0 }}>{title}</h3>
        {action}
      </header>
      {children}
    </section>
  );
}

function ContextRail({ data, onClose, width = 340 }) {
  const [watched, setWatched] = React.useState({ r1: true });
  return (
    <aside style={{ background: '#20211e', border: '1px solid #3a3b35', borderRadius: 10, bottom: 8, boxShadow: 'var(--shadow-rail)', display: 'grid', gridTemplateRows: '45px minmax(0,1fr)', overflow: 'hidden', position: 'absolute', right: 8, top: 8, width, zIndex: 40 }}>
      <header style={{ alignItems: 'center', borderBottom: '1px solid #30312c', display: 'flex', justifyContent: 'space-between', padding: '0 7px 0 11px' }}>
        <span style={{ alignItems: 'center', display: 'flex', gap: 6 }}>
          <Icon name="panel-right" size={14} style={{ color: 'var(--muted)' }} />
          <h2 style={{ color: 'var(--ink-soft)', fontSize: 12, margin: 0 }}>Context</h2>
        </span>
        <IconButton label="Close context rail" onClick={onClose}><Icon name="x" size={15} /></IconButton>
      </header>
      <div style={{ overflowY: 'auto', padding: '3px 11px 20px' }}>
        <RailSection action={<span style={{ color: '#74746d', fontSize: 9.5 }}>2 people · Avalon</span>} title="People">
          {data.people.map((person) => (
            <div key={person.id} style={{ alignItems: 'center', borderRadius: 6, display: 'flex', gap: 8, minHeight: 38, padding: '4px 5px' }}>
              <Avatar name={person.name} size="small" />
              <span style={{ display: 'flex', flex: 1, flexDirection: 'column', minWidth: 0 }}>
                <strong style={{ color: 'var(--ink-soft)', fontSize: 11 }}>{person.name}</strong>
                <small style={{ color: '#74746d', fontSize: 9.5 }}>{person.role}</small>
              </span>
            </div>
          ))}
        </RailSection>
        <RailSection action={<Icon name="plus" size={13} style={{ color: 'var(--muted)' }} />} title="Resources">
          <ul style={{ display: 'grid', gap: 5, margin: 0, padding: 0 }}>
            {data.resources.map((resource) => (
              <RailCard
                icon={resource.icon}
                key={resource.id}
                meta={resource.meta}
                onWatchChange={() => setWatched({ ...watched, [resource.id]: !watched[resource.id] })}
                title={resource.title}
                watchable
                watched={Boolean(watched[resource.id])}
              />
            ))}
          </ul>
        </RailSection>
        <RailSection action={<span style={{ color: '#74746d', fontSize: 9.5 }}>In progress 1</span>} title="Background work">
          <ul style={{ display: 'grid', gap: 5, margin: 0, padding: 0 }}>
            {data.tasks.map((task) => (
              <RailCard
                icon={task.state === 'running' ? 'loader-circle' : 'check'}
                key={task.id}
                meta={task.meta}
                title={task.title}
                trailing={<StatusDot compact status={task.state} />}
              />
            ))}
          </ul>
        </RailSection>
      </div>
    </aside>
  );
}

Object.assign(window, { ContextRail, RailSection });
