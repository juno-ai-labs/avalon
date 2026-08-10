const { Icon, AvalonMark, SidebarRow, Avatar, Badge } = window.AvalonDesignSystem_5d1c5e;

function SidebarSection({ heading, children }) {
  return (
    <div style={{ marginTop: 22 }}>
      <div style={{ alignItems: 'center', display: 'flex', height: 26, padding: '0 8px' }}>
        <h2 style={{ color: '#74746d', fontSize: 11, fontWeight: 530, margin: 0 }}>{heading}</h2>
      </div>
      <div style={{ display: 'grid', gap: 1 }}>{children}</div>
    </div>
  );
}

function SidebarAction({ icon, label, active, onClick }) {
  const [hover, setHover] = React.useState(false);
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{ alignItems: 'center', background: active ? '#343530' : hover ? '#22231f' : 'transparent', border: 0, borderRadius: 6, color: active || hover ? 'var(--ink)' : '#b7b6af', cursor: 'pointer', display: 'flex', fontFamily: 'inherit', fontSize: 13, gap: 10, minHeight: 31, padding: '4px 9px', textAlign: 'left', width: '100%' }}
      type="button"
    >
      <Icon name={icon} size={15} />{label}
    </button>
  );
}

function Sidebar({ route, onRoute, data, markSrc }) {
  return (
    <aside style={{ background: 'var(--sidebar)', borderRight: '1px solid #282924', bottom: 0, display: 'flex', flexDirection: 'column', left: 0, position: 'absolute', top: 0, width: 300, zIndex: 30 }}>
      <div style={{ alignItems: 'center', display: 'flex', gap: 9, height: 48, padding: '0 12px 7px 14px' }}>
        <AvalonMark size={20} src={markSrc} />
        <strong style={{ fontSize: 13 }}>Avalon</strong>
      </div>
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '6px 8px 18px' }}>
        <div style={{ display: 'grid', gap: 3, marginBottom: 18 }}>
          <SidebarAction active={route.name === 'home'} icon="square-pen" label="New work stream" onClick={() => onRoute({ name: 'home' })} />
          <SidebarAction icon="notebook-pen" label="Meeting notes" />
          <SidebarAction active={route.name === 'automations'} icon="repeat" label="Automations" onClick={() => onRoute({ name: 'automations' })} />
        </div>
        <SidebarSection heading="Automations">
          {data.automations.map((automation) => (
            <SidebarRow hint={automation.hint} icon="repeat" key={automation.id} onClick={() => onRoute({ name: 'automations' })} scope={automation.scope} title={automation.title} />
          ))}
        </SidebarSection>
        <SidebarSection heading="Last hour">
          {data.workstreams.map((workstream) => (
            <SidebarRow
              active={route.name === 'workstream' && route.id === workstream.id}
              hint={workstream.hint}
              icon="circle-dot"
              key={workstream.id}
              onClick={() => onRoute({ name: 'workstream', id: workstream.id })}
              title={workstream.title}
              unread={workstream.unread}
            />
          ))}
        </SidebarSection>
      </div>
      <button
        onClick={() => onRoute({ name: 'settings' })}
        style={{ alignItems: 'center', background: 'var(--sidebar)', border: 0, borderTop: '1px solid #282924', color: 'var(--ink-soft)', cursor: 'pointer', display: 'flex', fontFamily: 'inherit', gap: 8, minHeight: 54, padding: '8px 12px', textAlign: 'left', width: '100%' }}
        type="button"
      >
        <Avatar name={data.workspace.member} size="medium" />
        <span style={{ display: 'flex', flex: 1, flexDirection: 'column', minWidth: 0 }}>
          <strong style={{ fontSize: 11.5 }}>{data.workspace.member}</strong>
          <span style={{ color: 'var(--muted)', fontSize: 10 }}>{data.workspace.name}</span>
        </span>
        <Icon name="settings" size={14} style={{ color: 'var(--muted)' }} />
      </button>
    </aside>
  );
}

Object.assign(window, { Sidebar, SidebarSection, SidebarAction });
