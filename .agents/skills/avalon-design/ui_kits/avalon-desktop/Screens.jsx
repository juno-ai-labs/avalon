const NS = window.AvalonDesignSystem_5d1c5e;
const { Icon, IconButton, Button, Badge, StatusDot, Avatar, AvatarStack, AvalonMark, MessageBlock, ToolBlock, ArtifactBlock, SuggestionBlock, ElicitationPanel, Composer, EmptyState, SearchField, SelectField, OptionCard, ToggleSwitch, TextField } = NS;

function ScreenHeader({ origin, title, status, participants, railOpen, onToggleRail }) {
  return (
    <header style={{ alignItems: 'center', borderBottom: '1px solid var(--line-soft)', display: 'flex', gap: 12, height: 55, justifyContent: 'space-between', padding: '6px 10px 6px 16px' }}>
      <div style={{ alignItems: 'center', display: 'flex', gap: 9, minWidth: 0 }}>
        <span style={{ color: '#9b9a94', display: 'flex' }}><Icon name="circle-dot" size={15} /></span>
        <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          <span style={{ alignItems: 'center', display: 'flex', gap: 8 }}>
            <h1 style={{ fontSize: 13, margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</h1>
            <Badge>{origin}</Badge>
          </span>
          <span style={{ alignItems: 'center', display: 'flex', gap: 10, marginTop: 2 }}>
            <StatusDot status={status} />
            <span style={{ alignItems: 'center', color: 'var(--muted)', display: 'flex', fontSize: 10, gap: 4 }}><Icon name="users" size={11} />2 participants · Avalon</span>
          </span>
        </span>
      </div>
      <div style={{ alignItems: 'center', display: 'flex', gap: 2 }}>
        {participants}
        <IconButton label="HyperSight"><Icon name="sparkles" size={15} /></IconButton>
        <IconButton label="Work-stream menu"><Icon name="ellipsis" size={15} /></IconButton>
        <IconButton active={railOpen} label="Context rail" onClick={onToggleRail}><Icon name="panel-right" size={15} /></IconButton>
      </div>
    </header>
  );
}

function WorkstreamScreen({ workstream, data, markSrc, railOpen, onToggleRail }) {
  const [messages, setMessages] = React.useState([]);
  const [draft, setDraft] = React.useState('');
  const [choice, setChoice] = React.useState(null);
  const [answered, setAnswered] = React.useState(false);
  React.useEffect(() => { setMessages([]); setAnswered(false); setChoice(null); }, [workstream.id]);
  const send = () => {
    if (!draft.trim()) return;
    setMessages(messages.concat([{ author: data.workspace.member, body: draft.trim() }, { agent: true, body: 'Understood. Adding that to the brief and continuing the comparison — I will post the revised narrative here.' }]));
    setDraft('');
  };
  return (
    <div style={{ display: 'grid', gridTemplateRows: '55px minmax(0,1fr)', height: '100%', minWidth: 0, position: 'relative' }}>
      <ScreenHeader
        onToggleRail={onToggleRail}
        origin={workstream.origin}
        participants={<AvatarStack members={data.people} />}
        railOpen={railOpen}
        status={workstream.status}
        title={workstream.title}
      />
      <div style={{ minHeight: 0, overflowY: 'auto', position: 'relative' }}>
        <div style={{ margin: '0 auto', maxWidth: 860, padding: '42px 34px 200px' }}>
          <MessageBlock author="Adam Jarvis" time="9:02">Pull the three strongest launch narratives out of the customer interviews, then tell me which one to lead with.</MessageBlock>
          <MessageBlock agent markSrc={markSrc} time="9:02">Reading the connected Drive folder now. I will compare repeated objections across the twelve interviews before proposing narratives.</MessageBlock>
          <div style={{ marginBottom: 16 }}>
            <ToolBlock detail="Customer interviews · 12 files" duration="16s" icon="search" name="drive.search" state="completed">{'{\n  "folder": "Customer interviews",\n  "returned": 12\n}'}</ToolBlock>
          </div>
          <div style={{ marginBottom: 16 }}>
            <ToolBlock detail="Repeated objections across 12 transcripts" duration="42s" icon="brain" name="agent.compare" state="completed" />
          </div>
          <MessageBlock agent markSrc={markSrc} time="9:04">
            Three narratives hold up. <strong>Continuity</strong> is strongest on evidence: nine of twelve interviews describe losing context when work moves between tools. <strong>Inspectability</strong> is second, and <strong>speed</strong> is weakest — only two interviews raised it unprompted.
          </MessageBlock>
          <div style={{ marginBottom: 16 }}>
            <ArtifactBlock description="Draft · three narratives with supporting quotes" kind="Document" title="Launch narrative.md" />
          </div>
          <SuggestionBlock reason="It mentions the August launch and both participants of this stream." title="Route JUN-412 into this work stream" />
          {messages.map((message, index) => (
            <MessageBlock agent={message.agent} author={message.author} key={index} markSrc={markSrc} time="now">{message.body}</MessageBlock>
          ))}
          {answered && (
            <p style={{ alignItems: 'center', color: '#77766f', display: 'flex', fontSize: 10.5, gap: 8, margin: '20px 0' }}>
              <span style={{ background: '#565750', borderRadius: '50%', height: 4, width: 4 }} />Adam answered “{choice === 'teams' ? 'Fast-moving teams' : 'Enterprise buyers'}” · Avalon resumed the run
            </p>
          )}
        </div>
        <div style={{ background: 'linear-gradient(to bottom, transparent, var(--surface) 18%)', bottom: 0, left: 0, padding: '20px 28px 14px', position: 'absolute', right: 0 }}>
          <div style={{ display: 'grid', gap: 9, margin: '0 auto', maxWidth: 860 }}>
            {!answered && (
              <ElicitationPanel
                onSelect={setChoice}
                onSkip={() => setAnswered(true)}
                onSubmit={() => choice && setAnswered(true)}
                options={[
                  { value: 'enterprise', title: 'Enterprise buyers', description: 'Lead with governance, audit, and inspectable agent work' },
                  { value: 'teams', title: 'Fast-moving teams', description: 'Lead with continuity and one durable home for the work' }
                ]}
                question="Which audience should the launch narrative lead with?"
                selected={choice}
              />
            )}
            <Composer hint="⌘↵ to send · @ to mention a person or resource" onChange={(event) => setDraft(event.target.value)} onSend={send} value={draft} />
          </div>
        </div>
      </div>
    </div>
  );
}

function HomeScreen({ data, markSrc, onOpen }) {
  const waiting = data.workstreams.slice(0, 3);
  const tone = { needs_input: 'var(--brand-primary)', running: 'var(--brand-secondary)', completed: '#666861', idle: '#666861' };
  return (
    <div style={{ display: 'grid', gridTemplateRows: '55px minmax(0,1fr)', height: '100%' }}>
      <header style={{ alignItems: 'center', borderBottom: '1px solid var(--line-soft)', display: 'flex', height: 55, justifyContent: 'space-between', padding: '6px 12px 6px 16px' }}>
        <span style={{ alignItems: 'center', display: 'flex', gap: 8 }}><Icon name="square-pen" size={15} style={{ color: '#9b9a94' }} /><h1 style={{ fontSize: 13, margin: 0 }}>New work stream</h1></span>
        <Badge>{data.workspace.region}</Badge>
      </header>
      <div style={{ display: 'grid', overflowY: 'auto', placeItems: 'center', padding: 24 }}>
        <div style={{ maxWidth: 560, width: '100%' }}>
          <p style={{ alignItems: 'center', display: 'flex', fontSize: 13, fontWeight: 600, gap: 8, margin: '0 0 22px' }}><AvalonMark size={22} src={markSrc} />Welcome back, Adam</p>
          <small style={{ color: 'var(--muted-2)', fontSize: 9, letterSpacing: '.06em', textTransform: 'uppercase' }}>Waiting for you</small>
          <div style={{ display: 'grid', gap: 7, margin: '7px 0 22px' }}>
            {waiting.map((workstream) => (
              <button
                key={workstream.id}
                onClick={() => onOpen(workstream.id)}
                style={{ alignItems: 'center', background: '#1a1c18', border: '1px solid var(--line-soft)', borderRadius: 7, cursor: 'pointer', display: 'grid', gap: 10, gridTemplateColumns: 'auto 1fr auto', minHeight: 66, padding: '10px 12px', textAlign: 'left', width: '100%' }}
                type="button"
              >
                <span style={{ background: tone[workstream.status], borderRadius: '50%', height: 7, width: 7 }} />
                <span style={{ display: 'grid', gap: 2 }}>
                  <strong style={{ color: 'var(--brand-primary)', fontSize: 7.5, letterSpacing: '.06em', textTransform: 'uppercase' }}>{workstream.status.replace('_', ' ')}</strong>
                  <b style={{ color: 'var(--ink)', fontSize: 12, fontWeight: 550 }}>{workstream.title}</b>
                  <small style={{ color: 'var(--muted-2)', fontSize: 10 }}>{workstream.hint}</small>
                </span>
                <Icon name="chevron-right" size={14} style={{ color: 'var(--muted-2)' }} />
              </button>
            ))}
          </div>
          <Composer hint="Describe the outcome. Avalon opens a work stream for it." placeholder="What should this work stream accomplish?" />
        </div>
      </div>
    </div>
  );
}

function AutomationsScreen({ data }) {
  return (
    <div style={{ display: 'grid', gridTemplateRows: '55px minmax(0,1fr)', height: '100%' }}>
      <header style={{ alignItems: 'center', borderBottom: '1px solid var(--line-soft)', display: 'flex', height: 55, justifyContent: 'space-between', padding: '6px 12px 6px 16px' }}>
        <span style={{ alignItems: 'center', display: 'flex', gap: 8 }}><Icon name="repeat" size={15} style={{ color: '#9b9a94' }} /><h1 style={{ fontSize: 13, margin: 0 }}>Automations</h1></span>
        <Button icon={<Icon name="plus" size={13} />} size="small" variant="primary">New automation</Button>
      </header>
      <div style={{ overflowY: 'auto', padding: '24px 28px' }}>
        <div style={{ margin: '0 auto', maxWidth: 860 }}>
          {data.automations.map((automation) => (
            <article key={automation.id} style={{ background: 'var(--surface-2)', border: '1px solid var(--line-soft)', borderRadius: 9, display: 'grid', gap: 8, marginBottom: 9, padding: '15px 16px' }}>
              <header style={{ alignItems: 'center', display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ alignItems: 'center', display: 'flex', gap: 8 }}>
                  <span style={{ background: automation.state === 'active' ? 'var(--status-green)' : 'var(--status-yellow)', borderRadius: '50%', height: 6, width: 6 }} />
                  <strong style={{ fontSize: 12 }}>{automation.title}</strong>
                </span>
                <Badge>{automation.scope}</Badge>
              </header>
              <p style={{ alignItems: 'center', color: 'var(--muted-2)', display: 'flex', fontFamily: 'var(--font-mono)', fontSize: 9, gap: 7, margin: 0 }}>{automation.hint} · v3</p>
              <div style={{ alignItems: 'center', display: 'flex', gap: 7, justifyContent: 'space-between' }}>
                <span style={{ color: 'var(--ink-soft)', fontSize: 11 }}>Last run completed with 3 signals</span>
                <span style={{ display: 'flex', gap: 6 }}><Button size="small" variant="quiet">History</Button><Button size="small">Run now</Button></span>
              </div>
            </article>
          ))}
        </div>
      </div>
    </div>
  );
}

function SettingsScreen({ data }) {
  const groups = [
    ['Account', ['Profile', 'Sessions']],
    ['Workspace', ['Members', 'Invitations', 'Region']],
    ['Connections', ['Google', 'GitHub', 'Linear', 'Notion']],
    ['Application', ['Appearance', 'App icon', 'Diagnostics']]
  ];
  const [active, setActive] = React.useState('Members');
  const [query, setQuery] = React.useState('');
  const [invites, setInvites] = React.useState(true);
  return (
    <div style={{ background: '#191a17', display: 'grid', gridTemplateColumns: '210px minmax(0,1fr)', height: '100%', overflow: 'hidden' }}>
      <nav style={{ borderRight: '1px solid var(--line)', display: 'flex', flexDirection: 'column', minHeight: 0, padding: '20px 12px 18px' }}>
        <SearchField onChange={(event) => setQuery(event.target.value)} placeholder="Search settings" value={query} />
        <div style={{ minHeight: 0, overflowY: 'auto', paddingTop: 14 }}>
          {groups.map(([group, items]) => (
            <div key={group} style={{ marginTop: 13 }}>
              <span style={{ color: '#74766e', display: 'block', fontSize: 10, margin: '0 8px 6px' }}>{group}</span>
              {items.filter((item) => item.toLowerCase().includes(query.toLowerCase())).map((item) => (
                <button
                  key={item}
                  onClick={() => setActive(item)}
                  style={{ alignItems: 'center', background: active === item ? '#353631' : 'transparent', border: 0, borderLeft: '2px solid ' + (active === item ? 'var(--brand-primary)' : 'transparent'), borderRadius: 7, color: active === item ? 'var(--ink)' : '#babbb4', cursor: 'pointer', display: 'flex', fontFamily: 'inherit', fontSize: 12, gap: 9, minHeight: 36, padding: '0 10px', textAlign: 'left', width: '100%' }}
                  type="button"
                >{item}</button>
              ))}
            </div>
          ))}
        </div>
      </nav>
      <div style={{ background: '#292a27', display: 'grid', gridTemplateRows: 'auto minmax(0,1fr)', minHeight: 0 }}>
        <header style={{ alignItems: 'center', display: 'flex', justifyContent: 'space-between', minHeight: 58, padding: '11px 22px 7px 28px' }}>
          <h1 style={{ fontSize: 16, letterSpacing: '-0.015em', margin: 0 }}>{active}</h1>
          <Button size="small" variant="primary">Invite member</Button>
        </header>
        <div style={{ overflowY: 'auto', padding: '4px 28px 28px' }}>
          <p style={{ color: 'var(--muted)', fontSize: 12, margin: '0 0 18px', maxWidth: 560 }}>Members of {data.workspace.name}. The organization region is locked to {data.workspace.region} and cannot be changed after signup.</p>
          <div style={{ border: '1px solid var(--line)', borderRadius: 10, overflow: 'hidden' }}>
            {[['Adam Jarvis', 'adam@juno-labs.com', 'Owner'], ['Maya Lin', 'maya@juno-labs.com', 'Member'], ['Tomás Rey', 'tomas@juno-labs.com', 'Invited']].map(([name, email, role]) => (
              <div key={email} style={{ alignItems: 'center', borderBottom: '1px solid var(--line-soft)', display: 'grid', gap: 12, gridTemplateColumns: 'auto minmax(0,1fr) auto auto', minHeight: 56, padding: '8px 14px' }}>
                <Avatar name={name} size="medium" />
                <span style={{ display: 'grid' }}><strong style={{ fontSize: 12 }}>{name}</strong><small style={{ color: 'var(--muted)', fontSize: 10.5 }}>{email}</small></span>
                <Badge>{role}</Badge>
                <IconButton label={'Manage ' + name}><Icon name="ellipsis" size={15} /></IconButton>
              </div>
            ))}
          </div>
          <div style={{ alignItems: 'center', display: 'flex', gap: 16, marginTop: 20 }}>
            <ToggleSwitch checked={invites} label="Allow members to send invitations" onChange={() => setInvites(!invites)} />
            <SelectField ariaLabel="Default role" options={[{ value: 'member', label: 'Default role · Member' }, { value: 'admin', label: 'Default role · Admin' }]} value="member" />
          </div>
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { WorkstreamScreen, HomeScreen, AutomationsScreen, SettingsScreen, ScreenHeader });
