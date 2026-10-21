import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { sessionImportCanonicalUrl } from '@rally/contracts/workstream-links';
import { IconCheck, IconClockHour4 } from '@tabler/icons-react';
import { CircleAlert, Copy, Ellipsis, LoaderCircle, X } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { BrowserImportContext } from '../../common/browser-import';
import {
  EmbeddedBrowserNavigation,
  EmbeddedBrowserTabs,
  focusAddress,
  useEmbeddedBrowser,
  useEmbeddedBrowserPlacement,
  useEmbeddedBrowserShortcuts,
} from '../components/embedded-browser-view';
import { Button, DropdownSelect, IconButton, ErrorNotice, Modal } from '../components/primitives';
import { useAppSession } from '../lib/app-session';
import { browserConversation, conversationAt } from '../lib/browser-conversation';
import {
  SESSION_IMPORT_FAILURE_COPY,
  startSessionImportRun,
  type SessionImportRun,
  type SessionImportRunResult,
  type SessionImportStep,
} from '../lib/session-import-run';
import { desktopBridge } from '../lib/platform';

/** Where a person starts: the two providers whose signed-in chats can be read. */
const PROVIDERS = [
  { label: 'claude.ai', url: 'https://claude.ai/' },
  { label: 'chatgpt.com', url: 'https://chatgpt.com/' },
] as const;

interface PendingImport {
  clientMessageId: string;
}

/** What the window says when a run ends without importing. */
function endedMessage(result: SessionImportRunResult): string | null {
  if (result.kind === 'imported' || result.kind === 'cancelled') return null;
  if (result.kind === 'failed') return SESSION_IMPORT_FAILURE_COPY[result.reason];
  if (result.kind === 'unfinished') {
    return result.refusal
      ? `The import did not finish. Rally refused it: ${result.refusal}`
      : 'The import did not finish. Try again, or cancel.';
  }
  return result.message;
}

/** How many of the latest steps the import modal lists by name; older ones fold into one line. */
const LISTED_STEPS = 3;

/** The agent's latest steps, newest last, under a count of the ones before them. */
function ImportSteps({ steps }: { steps: readonly SessionImportStep[] }): React.JSX.Element {
  if (steps.length === 0) {
    return <p aria-live="polite" className="browser-import-steps-empty"><LoaderCircle aria-hidden="true" className="spin" size={14} />Starting the import…</p>;
  }
  const earlier = Math.max(0, steps.length - LISTED_STEPS);
  return <ol aria-live="polite" className="browser-import-steps">
    {earlier > 0 && <li className="is-earlier" key="earlier">
      <IconClockHour4 aria-hidden="true" size={14} />
      <span>{earlier} previous {earlier === 1 ? 'action' : 'actions'}</span>
    </li>}
    {steps.slice(earlier).map((step) => <li className={`is-${step.status}`} key={step.id}>
      {step.status === 'running'
        ? <LoaderCircle aria-label="In progress" className="spin" size={14} />
        : step.status === 'failed'
          ? <CircleAlert aria-label="Failed" size={14} />
          : <IconCheck aria-label="Done" size={14} />}
      <span>{step.label}</span>
    </li>)}
    {/* Between tools the model is choosing what to do next; the list should not look stalled. */}
    {steps.every((step) => step.status !== 'running') && <li className="is-running" key="deciding">
      <LoaderCircle aria-label="In progress" className="spin" size={14} />
      <span>Deciding the next step…</span>
    </li>}
  </ol>;
}

/**
 * The import window: the account's browser with Close and Import around it.
 *
 * Import asks only for what a Channel needs — its name and Space — and then
 * starts Rally's import agent, which reads the conversation the active tab is
 * showing through this window's browser while the person watches. The Channel
 * is listed from the start and opens when the agent finishes; the main window
 * then opens it and this window closes. Opened to update a Channel, the window
 * goes to its recorded conversation and adds what changed instead.
 */
export function BrowserImportWindow(): React.JSX.Element {
  const { api, session } = useAppSession();
  const bridge = desktopBridge();
  const { state, active, error: browserError, command } = useEmbeddedBrowser();
  const pageRef = useRef<HTMLElement>(null);
  const addressRef = useRef<HTMLInputElement>(null);
  const [run, setRun] = useState<SessionImportRun | null>(null);
  // While the agent drives the page, no key may move it.
  useEmbeddedBrowserShortcuts({ state, command, addressRef, enabled: run === null });
  const nameId = useId();
  const [darwin, setDarwin] = useState(false);
  const [context, setContext] = useState<BrowserImportContext | null>(null);
  const [pending, setPending] = useState<PendingImport | null>(null);
  const [name, setName] = useState('');
  const [spaceId, setSpaceId] = useState('');
  const [steps, setSteps] = useState<readonly SessionImportStep[]>([]);
  const [mirror, setMirror] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  // The running import's agent conversation and its Channel, which a bad import is debugged from.
  const [importRun, setImportRun] = useState<{ workstreamId: string; substreamId: string } | null>(null);
  const [copyFailed, setCopyFailed] = useState(false);

  const conversation = active ? browserConversation(active) : null;
  const update = context?.update ?? null;
  // Opened from a thread's composer: the import becomes a Breakout of that thread.
  const breakout = context?.breakout ?? null;
  // An update reads only the conversation the Channel was imported from.
  const updatable = update !== null && conversation !== null && conversation.url === conversationAt(update.sourceUrl, '')?.url;
  const starting = active === undefined || active.url === 'about:blank';
  useEmbeddedBrowserPlacement(pageRef, !starting && browserError === null);

  useEffect(() => {
    let live = true;
    void bridge.getRuntimeConfig().then((config) => { if (live) setDarwin(config.platform === 'darwin'); }).catch(() => undefined);
    const load = (): void => {
      void bridge.getBrowserImportContext().then((next) => { if (live) setContext(next); }).catch(() => undefined);
    };
    load();
    const unsubscribe = bridge.onBrowserImportContextChanged(load);
    return () => { live = false; unsubscribe(); };
  }, [bridge]);

  // An update starts on the recorded conversation, in the tab already showing it.
  // Once per recorded conversation, not on every page change after it.
  const updateUrl = update?.sourceUrl ?? null;
  const openedUpdate = useRef<string | null>(null);
  useEffect(() => {
    // A run drives the tab; a context that arrives during it waits for it to end.
    if (!updateUrl || !active || run || openedUpdate.current === updateUrl) return;
    openedUpdate.current = updateUrl;
    if (active.url !== updateUrl) void command({ action: 'navigate', tabId: active.id, url: updateUrl });
  }, [updateUrl, active, run, command]);

  // Main reuses an open window and replaces its context, so a choice the new
  // Spaces no longer hold, or a Space the new context locks away, moves to the
  // first one it offers. A different Space is a different Channel, so an open
  // sheet takes a new request identity with it. A sheet opened before the
  // window learned its Spaces has no choice yet, and takes the first too.
  useEffect(() => {
    const offered = context?.spaces ?? [];
    if (run || offered.some((space) => space.id === spaceId)) return;
    if (spaceId === '' && (!pending || offered.length === 0)) return;
    setSpaceId(offered[0]?.id ?? '');
    setPending((current) => current && { ...current, clientMessageId: crypto.randomUUID() });
  }, [context, pending, spaceId, run]);

  // A failure names the chat it was about; it does not follow the person to the next one.
  useEffect(() => { setFailure(null); }, [conversation?.url]);

  // The run's modal covers the page, which main then parks out of the window
  // at full size so the agent keeps working on it. What shows behind the blur
  // is this capture of it, refreshed as each step ends.
  const tabId = active?.id ?? null;
  const capture = useCallback((): void => {
    if (!tabId) return;
    void bridge.commandEmbeddedBrowser({ action: 'screenshot', tabId }).then((result) => {
      if (result.kind === 'screenshot') setMirror(`data:${result.mimeType};base64,${result.data}`);
    }).catch(() => undefined);
  }, [bridge, tabId]);
  const settledSteps = steps.filter((step) => step.status !== 'running').length;
  useEffect(() => { if (run) capture(); }, [run, settledSteps, capture]);

  /**
   * A new import's Channel, as the main window lists it: pending from the
   * moment the API reserves it, confirmed when the import lands, and taken
   * away on any other ending. An update's Channel already exists.
   */
  const reserved = useRef<string | null>(null);
  const watch = (started: SessionImportRun): void => {
    capture();
    setRun(started);
    setSteps([]);
    setImportRun(null);
    setCopyFailed(false);
    void started.done.then(async (result) => {
      const workstreamId = reserved.current;
      reserved.current = null;
      if (result.kind === 'imported') {
        if (workstreamId) await bridge.reportBrowserImport({ phase: 'imported', workstreamId }).catch(() => undefined);
        try {
          await bridge.completeBrowserImport(result.workstreamId, result.substreamId);
          return;
        } catch {
          // The Channel is imported and listed; only opening it failed, so the
          // window lets go of the page rather than holding the modal forever.
          setRun(null);
          setMirror(null);
          setFailure(result.substreamId
            ? 'The conversation was imported, but Rally could not open it. Find it in the thread’s breakouts.'
            : 'The conversation was imported, but Rally could not open it. Find it in your Threads.');
          return;
        }
      }
      if (workstreamId) void bridge.reportBrowserImport({ phase: 'failed', workstreamId }).catch(() => undefined);
      setRun(null);
      setMirror(null);
      setFailure(endedMessage(result));
    });
  };

  const beginImport = (): void => {
    if (!conversation || !api || run) return;
    setFailure(null);
    if (update) {
      if (!updatable || !active) return;
      watch(startSessionImportRun({ api, bridge, tabId: active.id, sourceUrl: conversation.url,
        mode: { kind: 'update', workstreamId: update.workstreamId }, onSteps: setSteps,
        onStarted: setImportRun }));
      return;
    }
    const spaces = context?.spaces ?? [];
    setName(conversation.title);
    setSpaceId((current) => spaces.some((space) => space.id === current) ? current : spaces[0]?.id ?? '');
    setPending({ clientMessageId: crypto.randomUUID() });
  };

  // A changed name or Space is a different Channel, which the creation receipt
  // would refuse under the old request identity.
  const renewRequest = (): void => {
    setPending((current) => current && { ...current, clientMessageId: crypto.randomUUID() });
  };

  const startChannel = (): void => {
    if (!pending || !api || !conversation || !active || run || !name.trim()) return;
    if (breakout) {
      setPending(null);
      watch(startSessionImportRun({ api, bridge, tabId: active.id, sourceUrl: conversation.url,
        mode: { kind: 'breakout', workstreamId: breakout.workstreamId, title: name.trim(), clientMessageId: pending.clientMessageId },
        onSteps: setSteps,
        onStarted: setImportRun }));
      return;
    }
    if (!context?.spaces.some((space) => space.id === spaceId)) return;
    setPending(null);
    const title = name.trim();
    watch(startSessionImportRun({ api, bridge, tabId: active.id, sourceUrl: conversation.url,
      mode: { kind: 'create', title, spaceIds: [spaceId], clientMessageId: pending.clientMessageId },
      onSteps: setSteps,
      onStarted: (started) => {
        reserved.current = started.workstreamId;
        setImportRun(started);
        void bridge.reportBrowserImport({ phase: 'importing', workstreamId: started.workstreamId, title, spaceId }).catch(() => undefined);
      } }));
  };

  const copyImportId = (): void => {
    const workspace = session?.workspace;
    if (!importRun || !workspace) return;
    setCopyFailed(false);
    void bridge.getRuntimeConfig().then(({ webBaseUrl }) => bridge.copyText(sessionImportCanonicalUrl(webBaseUrl, {
      region: workspace.region, workspaceId: workspace.id, importId: importRun.substreamId, workstreamId: importRun.workstreamId,
    }))).catch(() => setCopyFailed(true));
  };

  const spaces = context?.spaces ?? [];
  return <div className={darwin ? 'browser-import-window has-overlay-window-controls' : 'browser-import-window'}>
    <header className="browser-import-titlebar window-drag">
      <EmbeddedBrowserTabs command={command} onNewTab={() => void command({ action: 'open' }).then(() => focusAddress(addressRef))} state={state} />
      <IconButton label="Close" onClick={() => window.close()}><X size={17} /></IconButton>
    </header>
    <div className="browser-import-toolbar">
      <EmbeddedBrowserNavigation active={active} addressRef={addressRef} command={command} />
      {/* Import reads the foreground tab — the one this window is showing. */}
      <Button className="button-primary" disabled={!conversation || !api || run !== null || (update !== null && !updatable)}
        onClick={beginImport}
        title={conversation ? `Import “${conversation.title}”` : 'Open a Claude or ChatGPT chat to import it'}>
        {update ? 'Import updates' : 'Import'}
      </Button>
    </div>
    {(failure ?? browserError) && <ErrorNotice>{failure ?? browserError}</ErrorNotice>}
    <main className="browser-import-page" ref={pageRef}>
      {run && mirror && <img alt="" className="browser-import-mirror" src={mirror} />}
      {starting && <section aria-labelledby={`${nameId}-start`} className="browser-import-start">
        <h1 id={`${nameId}-start`}>Import a conversation</h1>
        <ol>
          <li>
            <span>Go to {PROVIDERS.map((provider, index) => <span key={provider.url}>
              {index > 0 && ' or '}
              <button className="browser-import-link" onClick={() => void command({ action: 'navigate', url: provider.url })} type="button">{provider.label}</button>
            </span>)}</span>
          </li>
          <li><span>Log in to your account</span></li>
          <li><span>Open the chat you want to import, or a shared link to one</span></li>
          <li><span>Click <strong>Import</strong></span></li>
        </ol>
      </section>}
    </main>
    <Modal
      backdrop="blur"
      description="Rally is using a large language model and computer use to read the page. This can take between 20 and 60 seconds."
      dismissible={false}
      footer={<Button onClick={() => void run?.cancel()}>Cancel</Button>}
      headerActions={<DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <IconButton label="More import actions"><Ellipsis size={16} /></IconButton>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content align="end" className="menu-content" sideOffset={8}>
            <DropdownMenu.Item className="menu-item" disabled={!importRun || !session?.workspace} onSelect={copyImportId}>
              <Copy size={14} /> Copy import id
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>}
      onOpenChange={(open) => { if (!open) void run?.cancel(); }}
      open={run !== null}
      title={update ? 'Importing updates' : 'Importing conversation'}
    >
      <ImportSteps steps={steps} />
      {copyFailed && <ErrorNotice>The import id could not be copied.</ErrorNotice>}
    </Modal>
    <Modal
      footer={<>
        <Button onClick={() => setPending(null)}>Cancel</Button>
        <Button className="button-primary" disabled={!name.trim() || (!breakout && !spaceId)} onClick={startChannel}>Import</Button>
      </>}
      onOpenChange={(open) => { if (!open) setPending(null); }}
      open={pending !== null}
      title={breakout ? 'Import as breakout' : 'Import thread'}
    >
      <form className="space-create-form" onSubmit={(event) => { event.preventDefault(); startChannel(); }}>
        {breakout ? <label className="form-field">
          <span>Thread</span>
          {/* Opened from this thread's composer: where the Breakout lands is not a choice made here. */}
          <input disabled value={breakout.title} />
        </label> : <label className="form-field">
          <span>Channel</span>
          <DropdownSelect ariaLabel="Channel" disabled={context?.spaceLocked === true} onValueChange={(value) => { setSpaceId(value); renewRequest(); }}
            options={spaces.map((space) => ({ label: space.name, value: space.id }))} value={spaceId} />
        </label>}
        <label className="form-field" htmlFor={nameId}>
          <span>{breakout ? 'Name of breakout' : 'Name of thread'}</span>
          <input autoFocus id={nameId} maxLength={180} onChange={(event) => { setName(event.target.value); renewRequest(); }} required value={name} />
        </label>
        {!breakout && context !== null && spaces.length === 0 && <ErrorNotice>There is no channel to import into. Create one in Rally first.</ErrorNotice>}
      </form>
    </Modal>
  </div>;
}
