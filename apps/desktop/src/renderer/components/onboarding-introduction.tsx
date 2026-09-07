import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { ArrowRight, GitBranch, LockKeyhole, Plus, Search } from 'lucide-react';
import { onboardingMotion } from '../lib/onboarding-motion';
import { Button, InlineError, RallyMark } from './primitives';
import { PersonalAvatar } from './personal-avatar';
import { ResourceEmbedCard } from './markdown-citations';
import '../styles/onboarding-introduction.css';

const slides = [
  { scene: 3, title: 'Meet Rally. Work moves forward together.', description: 'Bring your team and Rally into the same stream. Share context, give direction, and build on each other’s work.', next: 'Meet streams' },
  { scene: 1, title: 'A stream gives your work a home.', description: 'Give each area of work its own stream. As your team and Rally make progress, active work rises to the top.', next: 'Explore substreams' },
  { scene: 2, title: 'Explore an idea in a substream.', description: 'Take a focused conversation off Main, with context from your stream.', next: 'Get started' },
] as const;

const sidebarStreams = [
  { id: 'pilot', title: 'Customer pilot', color: 'blue', detail: 'Harper added feedback' },
  { id: 'launch', title: 'Product launch', color: 'purple', detail: 'Rally updated the launch plan' },
  { id: 'feedback', title: 'Customer feedback', color: 'cyan', detail: 'Aspen started a workstream' },
  { id: 'hiring', title: 'Growing our team', color: 'green', detail: 'Harper started a workstream' },
] as const;
const sidebarOrders = [
  ['pilot', 'launch'], ['feedback', 'pilot', 'launch'],
  ['launch', 'feedback', 'pilot'], ['hiring', 'launch', 'feedback', 'pilot'],
  ['pilot', 'hiring', 'launch', 'feedback'],
];

const sidebarArrivals = [
  { author: 'Aspen', text: 'Let’s collect our customer feedback here.', rally: false },
  { author: 'Rally', text: 'The launch plan is ready for review.', rally: true },
  { author: 'Harper', text: 'Let’s plan our next two hires.', rally: false },
  { author: 'Harper', text: 'The pilot feedback is in. Here’s what we learned.', rally: false },
];

function SidebarStory(): React.JSX.Element {
  const [phase, setPhase] = useState(0);
  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const start = () => setPhase(media.matches ? sidebarOrders.length - 1 : 0);
    start(); media.addEventListener('change', start);
    return () => media.removeEventListener('change', start);
  }, []);
  const order = sidebarOrders[phase]!;
  const arrival = sidebarArrivals[phase];
  const destination = sidebarOrders[phase + 1]?.[0];
  const landingRow = Math.max(0, destination ? order.indexOf(destination) : 0);
  return <div className="onboarding-sidebar-preview" aria-label="Workstreams organized by recent activity">
    <div className="onboarding-sidebar-brand"><RallyMark /><strong>Rally</strong><Plus size={18} aria-hidden="true" /></div>
    <div className="onboarding-sidebar-search"><Search size={17} /><span>Search</span></div>
    <small className="onboarding-sidebar-label">Today</small>
    <div className="onboarding-sidebar-streams">
      {sidebarStreams.filter((stream) => order.includes(stream.id)).map((stream) => <div key={stream.id} className={`onboarding-sidebar-stream ${order[0] === stream.id ? 'is-active' : ''}`} style={{ transform: `translateY(${order.indexOf(stream.id) * 76}px)`, '--stream-color': `var(--av-sys-color-project-${stream.color})` } as CSSProperties}>
        <span className="onboarding-sidebar-dot" /><div><strong>{stream.title}</strong><small>{order[0] === stream.id && phase > 0 ? stream.detail : 'Ready when you are'}</small></div>{order[0] === stream.id && phase > 0 && <span className="onboarding-sidebar-unread" />}
      </div>)}
      {arrival && <div key={phase} className={`onboarding-sidebar-arrival onboarding-preview-message ${arrival.rally ? 'onboarding-preview-rally' : ''} ${arrival.author === 'Harper' ? 'onboarding-preview-sam' : ''}`} style={{ '--arrival-y': `${landingRow * 76}px` } as CSSProperties} onAnimationEnd={(event) => { if (event.target === event.currentTarget) setPhase((value) => Math.min(value + 1, sidebarOrders.length - 1)); }}>
        <span className="onboarding-story-person">{arrival.rally && <RallyMark />}<strong>{arrival.author}</strong></span><p>{arrival.text}</p>
      </div>}
    </div>
  </div>;
}

function SubstreamStory(): React.JSX.Element {
  const [phase, setPhase] = useState(0);
  const [reduced, setReduced] = useState(false);
  const [openFile, setOpenFile] = useState(false);
  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => { setReduced(media.matches); setPhase(media.matches ? 5 : 0); };
    update(); media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  useEffect(() => {
    if (reduced || phase >= 5) return;
    const timer = setTimeout(() => setPhase(phase + 1), onboardingMotion.demoBeat * (phase === 2 ? 2.5 : 1.5));
    return () => clearTimeout(timer);
  }, [phase, reduced]);
  const child = phase >= 3;
  const title = child ? 'Feedback questions' : 'Customer pilot plan';
  return <div className="onboarding-substream-demo onboarding-story-frame">
    <aside className="onboarding-substream-nav">
      <strong>Customer pilot</strong>
      <button type="button" className={!child ? 'is-selected' : ''} onClick={() => { setPhase(0); setOpenFile(false); }}>Main log</button>
      {child && <div className="onboarding-substream-branch"><GitBranch size={17} /><button type="button" className="is-selected" onClick={() => setPhase(5)}><PersonalAvatar initials="A" color="blue" /><span>Feedback questions</span></button></div>}
    </aside>
    <div className="onboarding-substream-conversation">
      <div className="onboarding-substream-caption">{child ? <><LockKeyhole size={13} /> Private to Aspen</> : 'Main log'}</div>
      {!child && <div className="onboarding-preview-message onboarding-preview-rally">
        <span className="onboarding-story-person"><RallyMark /><strong>Rally</strong></span>
        <p>The customer pilot plan is ready.</p>
        <ResourceEmbedCard label="Customer pilot plan" resource={{ id: 'substream-demo-plan', title: 'Customer pilot plan.md', resourceType: 'file', mimeType: 'text/markdown' }} onOpen={() => setOpenFile((value) => !value)} />
        {openFile && <p>Welcome session · Tuesday<br />Feedback session · Friday<br />Next · Review what customers learned</p>}
        <button className={`onboarding-substream-start ${phase === 1 ? 'is-highlighted' : ''}`} type="button" onClick={() => setPhase(2)}><GitBranch size={14} /> Start substream</button>
      </div>}
      {phase === 2 && <div className="onboarding-substream-review"><strong>Review starting context</strong><p>Customer pilot · Five customers<br />Feedback session planned for Friday</p><Button className="button-primary" onClick={() => setPhase(3)}>Create substream</Button></div>}
      {child && <div className="onboarding-substream-chat">
        <small className="onboarding-substream-context">Starting context reviewed from Main</small>
        {phase >= 4 && <div className="onboarding-preview-message"><span className="onboarding-story-person"><strong>Aspen</strong></span><p>Help me write three questions for Friday.</p></div>}
        {phase >= 5 && <div className="onboarding-preview-message onboarding-preview-rally"><span className="onboarding-story-person"><RallyMark /><strong>Rally</strong></span><p>Here are three questions to learn what worked and what needs improving.</p><ResourceEmbedCard label="Feedback questions" resource={{ id: 'substream-demo-questions', title: 'Feedback questions.md', resourceType: 'file', mimeType: 'text/markdown' }} onOpen={() => setOpenFile((value) => !value)} />{openFile && <p>What felt useful?<br />Where did you get stuck?<br />What would you change?</p>}</div>}
      </div>}
      <div className="onboarding-preview-composer"><span>Message {title}…</span><ArrowRight size={16} /></div>
    </div>
  </div>;
}

function Story({ step }: { step: number }): React.JSX.Element {
  const [previewOpen, setPreviewOpen] = useState(false);
  const ongoing = step === 1;
  const fileTitle = ongoing ? 'Customer pilot plan' : 'Customer welcome session';
  if (step === 1) return <SidebarStory />;
  if (step === 2) return <SubstreamStory />;
  return <div className={`onboarding-story onboarding-story-step-${step}`}>
    {step !== 3 && step !== 1 && <div className="onboarding-story-label"><span>Example</span><small>Fictional notes and teammates</small></div>}
    <div className="onboarding-story-frame">
      {step !== 3 && step !== 1 && <div className="onboarding-story-bar"><RallyMark /><strong>Customer pilot</strong><span>Work stream</span></div>}
      {(step === 3 || step === 1) && <div className="onboarding-stream-preview">

        <div className="onboarding-preview-feed">
          <div className="onboarding-preview-message"><span className="onboarding-story-person"><strong>Aspen</strong>{ongoing && <small>Last week</small>}</span><p>{ongoing ? "Let’s use this stream to plan our customer pilot." : "Rally, help us plan a welcome session for our new customers."}</p></div>
          <div className="onboarding-preview-message onboarding-preview-rally"><span className="onboarding-story-person"><RallyMark /><strong>Rally</strong></span><p>{ongoing ? "Here’s a starting plan. We can keep building on it as the pilot progresses." : "Let’s do a short walkthrough, then Q&A. Who can host?"}</p></div>
          <div className="onboarding-preview-message onboarding-preview-sam"><span className="onboarding-story-person"><strong>Harper</strong>{ongoing && <small>Today</small>}</span><p>{ongoing ? "The first five customers are in. Add a feedback session for Friday." : "I can host on Tuesday. Let’s leave time for questions."}</p></div>
          <div className="onboarding-preview-message onboarding-preview-rally"><span className="onboarding-story-person"><RallyMark /><strong>Rally</strong></span><p>{ongoing ? "Updated the same plan with Friday’s feedback session and our next steps." : "Here’s the plan for Tuesday, with Harper hosting and time for Q&A."}</p><ResourceEmbedCard label={fileTitle} resource={{ id: 'onboarding-example-plan', title: `${fileTitle}.md`, resourceType: 'file', mimeType: 'text/markdown' }} onOpen={() => setPreviewOpen((open) => !open)} />{previewOpen && (ongoing ? <p>First cohort · 5 customers<br />Feedback session · Friday<br />Next · Review feedback and update the plan</p> : <p>Welcome &amp; introductions · 5 min<br />Product walkthrough · 15 min<br />Questions &amp; next steps · 10 min</p>)}</div>
          <div className="onboarding-preview-composer"><span>Message your team and Rally…</span><ArrowRight size={16} /></div>
        </div>
      </div>}
    </div>
  </div>;
}

export function OnboardingIntroduction({ onComplete, busy, error }: {
  onComplete: () => void | Promise<void>;
  busy: boolean;
  error: string | null;
}): React.JSX.Element {
  const [step, setStep] = useState(0);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus({ preventScroll: true }); }, [step]);
  const slide = slides[step]!;
  const style = { '--story-beat': `${onboardingMotion.demoBeat}ms`, '--story-spring': onboardingMotion.standard.easing, '--story-duration': `${onboardingMotion.standard.duration}ms` } as CSSProperties;
  return <main className="guided-onboarding onboarding-introduction window-drag" style={style}>
    <section className="guided-page window-no-drag" aria-labelledby="onboarding-introduction-title">
      <header><h1 id="onboarding-introduction-title" ref={heading} tabIndex={-1}>{slide.title}</h1><p>{slide.description}</p></header>
      <div className="guided-content"><Story key={step} step={slide.scene} />{error && <InlineError>{error}</InlineError>}</div>
      <footer className="guided-footer"><Button className="button-primary" disabled={busy} onClick={() => { if (step === slides.length - 1) void onComplete(); else setStep(step + 1); }}>{busy ? 'Saving…' : slide.next}</Button><div className="onboarding-story-navigation">{step > 0 && <Button disabled={busy} onClick={() => setStep(step - 1)}>Back</Button>}{step < slides.length - 1 && <Button disabled={busy} onClick={() => void onComplete()}>Sign in</Button>}</div></footer>
    </section>
  </main>;
}
