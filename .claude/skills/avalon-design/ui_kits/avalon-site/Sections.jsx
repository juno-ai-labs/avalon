const NS = window.AvalonDesignSystem_5d1c5e;
const { AvalonMark, SiteButton, Kicker, FeatureCard, IntegrationTile, SignalStrip, Icon } = NS;
const MARK = '../../assets/brand/avalon-mark.png';
const BIOMES = { runway: 'high-desert', valley: 'boreal-wetland', proof: 'volcanic-coast', afterlight: 'alpine-tundra' };

function SiteHeader() {
  return (
    <header style={{ backdropFilter: 'blur(18px)', background: 'rgba(9,11,9,.72)', borderBottom: '1px solid var(--line-soft)', left: 0, position: 'absolute', right: 0, top: 0, zIndex: 40 }}>
      <div style={{ alignItems: 'center', display: 'grid', gridTemplateColumns: '1fr auto 1fr', margin: '0 auto', maxWidth: 1440, minHeight: 76, paddingInline: 'clamp(1.1rem,5vw,5.4rem)' }}>
        <a href="#" style={{ alignItems: 'center', display: 'inline-flex', fontSize: 15, fontWeight: 600, gap: 9, letterSpacing: '-.02em', width: 'max-content' }}>
          <AvalonMark size={24} src={MARK} />Avalon
        </a>
        <nav style={{ alignItems: 'center', color: 'rgba(240,239,232,.62)', display: 'flex', fontSize: 12, gap: '2rem' }}>
          {['How it works', 'Features', 'Compare', 'Connections'].map((item) => <a href="#" key={item}>{item}</a>)}
        </nav>
        <a href="#" style={{ alignItems: 'center', border: '1px solid rgba(240,239,232,.2)', borderRadius: 999, display: 'inline-flex', fontSize: 11, gap: 13, justifySelf: 'end', padding: '9px 13px' }}>
          Download for macOS <span style={{ color: 'var(--brand-warm)' }}>↘</span>
        </a>
      </div>
    </header>
  );
}

function Hero({ theme, onTheme }) {
  const themes = [['runway', 'Warp'], ['valley', 'Mesh'], ['proof', 'Trace'], ['afterlight', 'Orbit']];
  return (
    <section style={{ background: '#09100d', height: 760, overflow: 'hidden', position: 'relative' }}>
      <div style={{ animation: 'landscape-drift 20s ease-in-out infinite alternate', background: `linear-gradient(180deg, rgba(5,8,6,.2), rgba(5,8,6,.05) 45%, rgba(5,8,6,.35)), linear-gradient(90deg, rgba(5,8,6,.58), rgba(5,8,6,.12) 58%, rgba(5,8,6,.08)), url('../../assets/imagery/${BIOMES[theme]}.webp') center / cover no-repeat`, filter: 'brightness(.74) saturate(.82)', inset: '-2%', position: 'absolute', transition: 'filter .45s ease' }} />
      <div style={{ backgroundImage: 'radial-gradient(rgba(240,239,232,.26) .58px, transparent .7px)', backgroundSize: '3px 3px', inset: 0, mixBlendMode: 'soft-light', opacity: .24, position: 'absolute' }} />
      <div style={{ background: 'linear-gradient(180deg, transparent 72%, var(--canvas))', bottom: -1, height: '18%', left: 0, position: 'absolute', right: 0 }} />
      <article style={{ alignItems: 'center', display: 'grid', gap: '8vw', gridTemplateColumns: 'minmax(0,1.1fr) minmax(370px,.55fr)', inset: '76px clamp(1.1rem,6vw,6.5rem) 70px', margin: '0 auto', maxWidth: 1500, position: 'absolute', zIndex: 5 }}>
        <div style={{ maxWidth: 950 }}>
          <Kicker index="01" tone="eyebrow">Warp · Desktop preview for macOS</Kicker>
          <h1 style={{ fontSize: 'clamp(4.5rem,8vw,8.6rem)', fontWeight: 500, letterSpacing: '-.075em', lineHeight: .86, margin: '1.7rem 0 0' }}>
            Give every outcome<br /><em style={{ color: 'var(--brand-primary)', fontFamily: 'var(--font-serif)', fontWeight: 400 }}>a place to run.</em>
          </h1>
          <p style={{ color: 'rgba(240,239,232,.68)', fontSize: 'clamp(.95rem,1.2vw,1.08rem)', lineHeight: 1.65, margin: '2rem 0 0', maxWidth: 650 }}>
            Start with the work—not a blank chat. Avalon opens a shared work stream, gathers the context, and moves toward a visible result.
          </p>
          <div style={{ alignItems: 'center', display: 'flex', flexWrap: 'wrap', gap: 10, marginTop: '2rem' }}>
            <SiteButton href="#download" icon={<img alt="" height="16" src="../../assets/brand/apple-logo.svg" style={{ filter: 'brightness(0)' }} width="13" />}>Download Avalon</SiteButton>
            <SiteButton arrow="→" href="#tour" variant="quiet">Follow a work stream</SiteButton>
          </div>
        </div>
        <aside style={{ backdropFilter: 'blur(16px)', background: 'rgba(18,20,17,.82)', border: '1px solid rgba(240,239,232,.18)', borderRadius: 'var(--radius-site)', boxShadow: 'var(--shadow-site-card)', overflow: 'hidden' }}>
          <header style={{ alignItems: 'center', borderBottom: '1px solid var(--line-soft)', display: 'flex', fontSize: 9, justifyContent: 'space-between', padding: '14px 15px' }}>
            <span>Prepare the launch review</span><b style={{ background: 'rgba(240,239,232,.08)', borderRadius: 4, color: 'var(--muted)', fontSize: 7, fontWeight: 500, padding: '3px 6px' }}>Shared</b>
          </header>
          <ol style={{ listStyle: 'none', margin: 0, padding: '8px 15px 10px' }}>
            {[['complete', 'Outcome described', 'Audience, evidence, decision', '9:02'], ['active', 'Avalon is working', 'Comparing three narratives', 'now'], ['', 'Review the output', 'Returns to this work stream', 'next']].map(([state, title, detail, time]) => (
              <li key={title} style={{ alignItems: 'center', display: 'grid', gap: 12, gridTemplateColumns: 'auto 1fr auto', minHeight: 68, position: 'relative' }}>
                <i style={{ animation: state === 'active' ? 'pulse-dot 2s ease-out infinite' : 'none', background: state === 'complete' ? 'var(--brand-primary)' : state === 'active' ? 'var(--brand-warm)' : '#5c5e57', borderRadius: '50%', height: 7, width: 7 }} />
                <span style={{ display: 'flex', flexDirection: 'column', gap: 4 }}><strong style={{ fontSize: 9, fontWeight: 550 }}>{title}</strong><small style={{ color: 'var(--muted-2)', fontSize: 7 }}>{detail}</small></span>
                <time style={{ color: 'var(--muted-2)', fontSize: 7 }}>{time}</time>
              </li>
            ))}
          </ol>
        </aside>
      </article>
      <div style={{ alignItems: 'center', backdropFilter: 'blur(14px)', background: 'rgba(11,13,11,.84)', border: '1px solid rgba(240,239,232,.18)', borderRadius: 999, bottom: 22, display: 'flex', gap: 3, left: '50%', padding: '5px 6px 5px 13px', position: 'absolute', transform: 'translateX(-50%)', zIndex: 20 }}>
        <span style={{ color: 'var(--muted)', fontFamily: 'var(--font-mono)', fontSize: 9, letterSpacing: '.12em', marginRight: 8, textTransform: 'uppercase' }}>Design</span>
        {themes.map(([key, label]) => (
          <button
            key={key}
            onClick={() => onTheme(key)}
            style={{ alignItems: 'center', background: theme === key ? 'var(--surface-3)' : 'transparent', border: 0, borderRadius: 999, color: theme === key ? 'var(--ink)' : 'var(--muted)', cursor: 'pointer', display: 'inline-flex', fontFamily: 'var(--font-mono)', fontSize: 10, height: 34, letterSpacing: '.06em', padding: '0 12px', textTransform: 'uppercase' }}
            type="button"
          >{label}</button>
        ))}
      </div>
    </section>
  );
}

Object.assign(window, { SiteHeader, Hero });
