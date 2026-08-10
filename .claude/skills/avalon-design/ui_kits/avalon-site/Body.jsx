const NS = window.AvalonDesignSystem_5d1c5e;
const { AvalonMark, SiteButton, Kicker, FeatureCard, IntegrationTile, SignalStrip } = NS;
const MARK2 = '../../assets/brand/avalon-mark.png';

function Shell({ children, style }) {
  return <div style={{ marginInline: 'auto', maxWidth: 1440, paddingInline: 'clamp(1.1rem,5vw,5.4rem)', width: '100%', ...style }}>{children}</div>;
}

function SectionIntro({ kicker, title, accent, children }) {
  return (
    <div style={{ maxWidth: 880 }}>
      <Kicker>{kicker}</Kicker>
      <h2 style={{ fontSize: 'clamp(3.3rem,6.6vw,6.8rem)', fontWeight: 500, letterSpacing: '-.068em', lineHeight: .92, margin: '1.2rem 0 0' }}>
        {title}<br /><em style={{ color: 'var(--brand-primary)', fontFamily: 'var(--font-serif)', fontWeight: 400 }}>{accent}</em>
      </h2>
      {children && <p style={{ color: 'var(--muted)', fontSize: 'clamp(.95rem,1.3vw,1.08rem)', lineHeight: 1.7, margin: '2rem 0 0', maxWidth: 680 }}>{children}</p>}
    </div>
  );
}

function HowItWorks() {
  const steps = [
    ['01', 'Open a work stream', 'Start with the outcome in plain language. Add the people and resources that belong to it.'],
    ['02', 'Avalon moves it forward', 'Avalon reads connected context, uses tools, and works in the background without hiding the process.'],
    ['03', 'Review what matters', 'Questions surface when judgment is needed. Outputs, sources, and decisions return to the same stream.']
  ];
  return (
    <section style={{ paddingBlock: 'clamp(6.8rem,12vw,11rem)' }}>
      <Shell>
        <SectionIntro accent="Keep the work together." kicker="The operating model" title="Describe the outcome.">
          Avalon gives each piece of work a durable home. The people, instructions, resources, agent activity, decisions, and final artifact remain attached to the outcome.
        </SectionIntro>
        <ol style={{ display: 'grid', gap: 1, gridTemplateColumns: 'repeat(3,1fr)', listStyle: 'none', margin: 'clamp(4rem,8vw,7rem) 0 0', padding: 0 }}>
          {steps.map(([index, title, body], position) => (
            <li key={index} style={{ borderLeft: position === 0 ? 0 : '1px solid var(--line)', display: 'grid', gap: '2rem', gridTemplateColumns: 'auto 1fr', minHeight: 220, padding: position === 0 ? '1rem clamp(1.2rem,3vw,2.8rem) 1rem 0' : '1rem clamp(1.2rem,3vw,2.8rem)' }}>
              <span style={{ color: 'var(--brand-primary)', fontFamily: 'var(--font-mono)', fontSize: 9 }}>{index}</span>
              <div>
                <h3 style={{ fontSize: 'clamp(1.35rem,2vw,1.8rem)', fontWeight: 500, letterSpacing: '-.035em', margin: '-.45rem 0 1rem' }}>{title}</h3>
                <p style={{ color: 'var(--muted)', fontSize: 13, lineHeight: 1.7, margin: 0 }}>{body}</p>
              </div>
            </li>
          ))}
        </ol>
      </Shell>
    </section>
  );
}

function ProductTour() {
  return (
    <section id="tour" style={{ background: '#0f110e', borderBlock: '1px solid var(--line-soft)', overflow: 'hidden', paddingBlock: 'clamp(6.8rem,12vw,11rem)' }}>
      <Shell>
        <SectionIntro accent="Let the rest keep moving." kicker="One quiet work surface" title="See what needs you." />
        <figure style={{ background: '#121411', border: '1px solid rgba(240,239,232,.18)', borderRadius: 'calc(var(--radius-site) * 1.2)', boxShadow: 'var(--shadow-site-window)', margin: 'clamp(3.5rem,7vw,6rem) 0 0', overflow: 'hidden' }}>
          <div style={{ alignItems: 'center', background: '#191b17', borderBottom: '1px solid var(--line-soft)', display: 'grid', gridTemplateColumns: '1fr auto 1fr', height: 47, paddingInline: 15 }}>
            <div style={{ display: 'flex', gap: 6 }}>{['#ee6a5f', '#e9bf43', '#61c954'].map((color) => <i key={color} style={{ background: color, borderRadius: '50%', height: 9, width: 9 }} />)}</div>
            <span style={{ alignItems: 'center', color: 'var(--muted)', display: 'flex', fontSize: 9, gap: 6 }}><AvalonMark size={14} src={MARK2} /> Avalon</span>
            <small style={{ color: 'var(--muted-2)', fontSize: 8, justifySelf: 'end' }}>Desktop preview</small>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '230px minmax(0,1fr) 275px', height: 560 }}>
            <aside style={{ background: '#171915', borderRight: '1px solid var(--line-soft)', display: 'flex', flexDirection: 'column', padding: '15px 11px' }}>
              <div style={{ alignItems: 'center', display: 'flex', fontSize: 11, gap: 7, padding: '5px 7px' }}><AvalonMark size={18} src={MARK2} /><strong>Avalon</strong></div>
              <div style={{ background: '#282a25', border: '1px solid rgba(240,239,232,.1)', borderRadius: 6, color: 'var(--ink-soft)', fontSize: 9, marginTop: 14, padding: 7 }}>＋ New work stream</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginTop: 22 }}>
                <p style={{ color: 'var(--muted-2)', fontSize: 8, margin: '0 0 5px 7px' }}>Automations</p>
                {['◌ Weekly changelog', '◌ Customer signal watch'].map((item) => <span key={item} style={{ borderRadius: 5, color: 'var(--muted)', fontSize: 8, padding: '6px 7px' }}>{item}</span>)}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginTop: 22 }}>
                <p style={{ color: 'var(--muted-2)', fontSize: 8, margin: '0 0 5px 7px' }}>Last hour</p>
                {[['● Research onboarding gaps', false], ['● Plan the August launch', true], ['● Update pricing narrative', false], ['◌ Partner follow-up', false]].map(([item, selected]) => (
                  <span key={item} style={{ background: selected ? '#2b2d28' : 'transparent', borderRadius: 5, color: selected ? 'var(--ink)' : 'var(--muted)', fontSize: 8, padding: '6px 7px' }}>{item}</span>
                ))}
              </div>
            </aside>
            <div style={{ display: 'grid', gridTemplateRows: 'auto 1fr auto', minWidth: 0 }}>
              <header style={{ alignItems: 'center', borderBottom: '1px solid var(--line-soft)', display: 'flex', fontSize: 8, justifyContent: 'space-between', minHeight: 42, paddingInline: 13 }}>
                <span style={{ alignItems: 'center', display: 'flex', gap: 7 }}><i style={{ background: 'var(--brand-primary)', borderRadius: '50%', height: 6, width: 6 }} /> Plan the August launch</span>
                <b style={{ background: '#292b26', borderRadius: 4, color: 'var(--muted)', fontSize: 7, fontWeight: 500, padding: '4px 6px' }}>Marketing</b>
              </header>
              <div style={{ margin: 'auto', maxWidth: 550, padding: 24, width: '100%' }}>
                <p style={{ alignItems: 'center', display: 'flex', fontSize: 13, fontWeight: 600, gap: 8, margin: '0 0 22px' }}><AvalonMark size={22} src={MARK2} /> Welcome back</p>
                <small style={{ color: 'var(--muted-2)', fontSize: 7, textTransform: 'uppercase' }}>Waiting for you</small>
                {[['var(--brand-primary)', 'Needs input', 'Plan the August launch', 'Choose the final story and audience', '4m', 1], ['var(--brand-secondary)', 'Ready', 'Update pricing narrative', 'Draft is ready for review', '18m', 1], ['#666861', 'Waiting', 'Research onboarding gaps', 'Maya is adding interview notes', '1h', .62]].map(([dot, state, title, detail, time, opacity]) => (
                  <div key={title} style={{ alignItems: 'center', background: '#1a1c18', border: '1px solid var(--line-soft)', borderRadius: 7, display: 'grid', gap: 10, gridTemplateColumns: 'auto 1fr auto', marginTop: 7, minHeight: 66, opacity, padding: '10px 12px' }}>
                    <i style={{ background: dot, borderRadius: '50%', height: 7, width: 7 }} />
                    <span style={{ display: 'grid', gap: 2 }}>
                      <strong style={{ color: 'var(--brand-primary)', fontSize: 7, textTransform: 'uppercase' }}>{state}</strong>
                      <b style={{ fontSize: 9, fontWeight: 550 }}>{title}</b>
                      <small style={{ color: 'var(--muted-2)', fontSize: 7 }}>{detail}</small>
                    </span>
                    <time style={{ color: 'var(--muted-2)', fontSize: 7 }}>{time}</time>
                  </div>
                ))}
              </div>
              <div style={{ borderTop: '1px solid var(--line-soft)', padding: '10px 13px 13px' }}>
                <p style={{ alignItems: 'center', background: '#1e201c', border: '1px solid rgba(240,239,232,.1)', borderRadius: 7, color: 'var(--muted-2)', display: 'flex', fontSize: 8, justifyContent: 'space-between', margin: 0, padding: 10 }}>Ask Avalon or update the work stream <b style={{ color: 'var(--muted)' }}>↵</b></p>
              </div>
            </div>
            <aside style={{ background: '#171915', borderLeft: '1px solid var(--line-soft)', padding: '14px 12px' }}>
              <header style={{ alignItems: 'center', display: 'flex', fontSize: 9, justifyContent: 'space-between' }}><span>Background work</span><i style={{ color: 'var(--muted)', fontStyle: 'normal' }}>×</i></header>
              <p style={{ color: 'var(--muted-2)', fontSize: 7 }}>In progress 2 <b style={{ float: 'right', fontWeight: 500 }}>Clear</b></p>
              {[['Compare launch narratives', 'Avalon · Working', true], ['Summarize customer interviews', 'Avalon · Completed · 2m 14s', false], ['Collect linked resources', 'Automation · Completed', false]].map(([title, meta, working]) => (
                <article key={title} style={{ background: '#1d1f1b', border: '1px solid var(--line-soft)', borderRadius: 7, display: 'flex', flexDirection: 'column', gap: 7, marginTop: 8, padding: 11 }}>
                  <strong style={{ alignItems: 'center', display: 'flex', fontSize: 8, gap: 6 }}>{working && <i style={{ animation: 'pulse-dot 2s infinite', background: 'var(--brand-primary)', borderRadius: '50%', height: 5, width: 5 }} />}{title}</strong>
                  <span style={{ color: 'var(--muted-2)', fontSize: 7 }}>{meta}</span>
                  {working && <div style={{ background: '#2a2c27', borderRadius: 2, height: 3, overflow: 'hidden' }}><i style={{ background: 'var(--brand-primary)', display: 'block', height: '100%', width: '58%' }} /></div>}
                </article>
              ))}
            </aside>
          </div>
          <figcaption style={{ borderTop: '1px solid var(--line-soft)', color: 'var(--muted)', fontSize: 11, lineHeight: 1.7, padding: '15px 18px' }}>
            Waiting work comes forward without becoming another inbox. Open a stream and its people, history, resources, and background work are already there.
          </figcaption>
        </figure>
      </Shell>
    </section>
  );
}

function Features() {
  return (
    <section style={{ paddingBlock: 'clamp(6.8rem,12vw,11rem)' }}>
      <Shell>
        <div style={{ marginBottom: 'clamp(4rem,8vw,7rem)' }}>
          <SectionIntro accent="is part of the product." kicker="Built for consequential work" title="Everything around the answer" />
        </div>
        <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(3,1fr)' }}>
          <FeatureCard label="01 · Work streams" title="A durable home for the outcome" wide>Messages, files, people, questions, tool activity, and outputs stay attached to the work they support.</FeatureCard>
          <FeatureCard label="02 · Collaboration" title="Human conversation stays human">In shared streams, people can talk to one another. Avalon acts when addressed or when assigned work.</FeatureCard>
          <FeatureCard label="03 · Inspectability" title="Open the work, not a magic box">See sources, tool calls, retries, blockers, decisions, and artifacts in the stream where they happened.</FeatureCard>
          <FeatureCard label="04 · Connections" title="Context from tools you already use">Bring in mail, calendars, documents, projects, and repositories with permission-scoped connections.</FeatureCard>
          <FeatureCard label="05 · Automations" title="Repeat the outcome, not the setup">Describe recurring work conversationally. Run it manually, on a schedule, from connected activity, by resource change, webhook, or email.</FeatureCard>
        </div>
      </Shell>
    </section>
  );
}

function Integrations() {
  const names = ['Gmail', 'Google Calendar', 'Google Drive', 'Google Docs', 'Google Sheets', 'GitHub', 'Linear', 'Notion'];
  return (
    <section style={{ background: '#10120f', borderBlock: '1px solid var(--line-soft)', paddingBlock: 'clamp(6.8rem,12vw,11rem)' }}>
      <Shell style={{ alignItems: 'end', display: 'grid', gap: '9vw', gridTemplateColumns: 'minmax(0,.85fr) minmax(430px,.65fr)' }}>
        <SectionIntro accent="Leave the sprawl behind." kicker="Connected, with permission" title="Bring the right context.">
          Connect only what a work stream needs. Avalon can work with your communication, documents, planning, and development context while keeping the outcome in one place.
        </SectionIntro>
        <div style={{ display: 'grid', gap: 8, gridTemplateColumns: 'repeat(2,1fr)' }}>
          {names.map((name) => <IntegrationTile key={name} name={name} />)}
        </div>
      </Shell>
    </section>
  );
}

function DownloadPanel() {
  return (
    <section id="download" style={{ paddingBlock: 'clamp(4rem,8vw,7rem)' }}>
      <Shell>
        <div style={{ alignItems: 'center', background: 'linear-gradient(130deg, rgba(206,220,0,.13), rgba(240,239,232,.03) 42%, rgba(255,99,55,.08))', border: '1px solid rgba(240,239,232,.16)', borderRadius: 'calc(var(--radius-site) * 1.4)', display: 'grid', gap: 'clamp(2rem,5vw,5rem)', gridTemplateColumns: 'auto 1fr auto', minHeight: 390, overflow: 'hidden', padding: 'clamp(2rem,6vw,5rem)', position: 'relative' }}>
          <div style={{ border: '1px solid rgba(206,220,0,.18)', borderRadius: '50%', height: 480, position: 'absolute', right: -190, top: -220, width: 480 }} />
          <div style={{ position: 'relative' }}><AvalonMark size={66} src={MARK2} /></div>
          <div style={{ position: 'relative', zIndex: 2 }}>
            <Kicker>Avalon desktop preview</Kicker>
            <h2 style={{ fontSize: 'clamp(3rem,5.5vw,5.8rem)', fontWeight: 500, letterSpacing: '-.068em', lineHeight: .9, margin: '1.1rem 0' }}>Make a place<br /><em style={{ color: 'var(--brand-primary)', fontFamily: 'var(--font-serif)', fontWeight: 400 }}>for the work.</em></h2>
            <p style={{ color: 'var(--muted)', fontSize: 13, lineHeight: 1.7, margin: 0, maxWidth: 560 }}>Start an outcome, invite the right people, and let Avalon keep the context and the work moving together.</p>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, position: 'relative', zIndex: 2 }}>
            <span style={{ alignItems: 'center', background: '#2a2c27', border: '1px solid var(--line)', borderRadius: 'calc(var(--radius-site) * .72)', color: 'var(--muted)', display: 'inline-flex', fontSize: 12, fontWeight: 600, justifyContent: 'center', minHeight: 48, minWidth: 220, padding: '11px 16px' }}>Downloads opening soon</span>
            <span style={{ color: 'var(--ink-soft)', fontFamily: 'var(--font-mono)', fontSize: 11, marginLeft: 3, textTransform: 'uppercase' }}>macOS · Apple silicon · Private preview</span>
          </div>
        </div>
      </Shell>
    </section>
  );
}

function SiteFooter() {
  const links = ['How it works', 'Features', 'Compare', 'Slack', 'Terms', 'Privacy', 'Acceptable Use', 'DPA', 'Sub-processors', 'Cookies', 'Security', 'Support'];
  return (
    <footer style={{ alignItems: 'center', borderTop: '1px solid var(--line-soft)', color: 'var(--muted)', display: 'grid', fontSize: 10, gap: '2rem', gridTemplateColumns: 'auto minmax(140px,.45fr) minmax(420px,1.8fr)', marginInline: 'auto', maxWidth: 1440, minHeight: 180, paddingInline: 'clamp(1.1rem,5vw,5.4rem)' }}>
      <a href="#" style={{ alignItems: 'center', display: 'inline-flex', fontSize: 15, fontWeight: 600, gap: 9 }}><AvalonMark size={20} src={MARK2} />Avalon</a>
      <p style={{ margin: 0 }}>Work, still in context.</p>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px 18px', justifyContent: 'flex-end', justifySelf: 'end', maxWidth: 760 }}>
        {links.map((link) => <a href="#" key={link}>{link}</a>)}
        <span>© 2026 Juno AI Labs</span>
      </div>
    </footer>
  );
}

Object.assign(window, { Shell, SectionIntro, HowItWorks, ProductTour, Features, Integrations, DownloadPanel, SiteFooter });
