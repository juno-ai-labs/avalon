import { X } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import type { BrowserImportContext } from '../../common/browser-import';
import {
  EmbeddedBrowserNavigation,
  EmbeddedBrowserTabs,
  focusAddress,
  useEmbeddedBrowser,
  useEmbeddedBrowserPlacement,
  useEmbeddedBrowserShortcuts,
} from '../components/embedded-browser-view';
import { Button, DropdownSelect, IconButton, InlineError, Modal } from '../components/primitives';
import { useAppSession } from '../lib/app-session';
import { browserConversation, conversationAt } from '../lib/browser-conversation';
import { SESSION_IMPORT_FAILURE_COPY, startSessionImportRun, type SessionImportRun, type SessionImportRunResult } from '../lib/session-import-run';
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
  if (result.kind === 'imported') return null;
  if (result.kind === 'failed') return SESSION_IMPORT_FAILURE_COPY[result.reason];
  if (result.kind === 'unfinished') return 'The import did not finish. Try again, or cancel.';
  return result.message;
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
  const { api } = useAppSession();
  const bridge = desktopBridge();
  const { state, active, error: browserError, command } = useEmbeddedBrowser();
  const pageRef = useRef<HTMLElement>(null);
  const addressRef = useRef<HTMLInputElement>(null);
  useEmbeddedBrowserShortcuts({ state, command, addressRef });
  const nameId = useId();
  const [darwin, setDarwin] = useState(false);
  const [context, setContext] = useState<BrowserImportContext | null>(null);
  const [pending, setPending] = useState<PendingImport | null>(null);
  const [name, setName] = useState('');
  const [spaceId, setSpaceId] = useState('');
  const [run, setRun] = useState<SessionImportRun | null>(null);
  const [progress, setProgress] = useState(0);
  const [failure, setFailure] = useState<string | null>(null);

  const conversation = active ? browserConversation(active) : null;
  const update = context?.update ?? null;
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
    if (!updateUrl || !active || openedUpdate.current === updateUrl) return;
    openedUpdate.current = updateUrl;
    if (active.url !== updateUrl) void command({ action: 'navigate', tabId: active.id, url: updateUrl });
  }, [updateUrl, active, command]);

  // Main reuses an open window and replaces its context, so a choice the new
  // Spaces no longer hold, or a Space the new context locks away, moves to the
  // first one it offers. A different Space is a different Channel, so an open
  // sheet takes a new request identity with it.
  useEffect(() => {
    const offered = context?.spaces ?? [];
    if (spaceId === '' || offered.some((space) => space.id === spaceId)) return;
    setSpaceId(offered[0]?.id ?? '');
    setPending((current) => current && { ...current, clientMessageId: crypto.randomUUID() });
  }, [context, spaceId]);

  // A failure names the chat it was about; it does not follow the person to the next one.
  useEffect(() => { setFailure(null); }, [conversation?.url]);

  const watch = (started: SessionImportRun): void => {
    setRun(started);
    setProgress(0);
    void started.done.then(async (result) => {
      if (result.kind === 'imported') {
        await bridge.completeBrowserImport(result.workstreamId);
        return;
      }
      setRun(null);
      setFailure(endedMessage(result));
    });
  };

  const beginImport = (): void => {
    if (!conversation || !api || run) return;
    setFailure(null);
    if (update) {
      if (!updatable || !active) return;
      watch(startSessionImportRun({ api, bridge, tabId: active.id, sourceUrl: conversation.url,
        mode: { kind: 'update', workstreamId: update.workstreamId }, onProgress: ({ steps }) => setProgress(steps) }));
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
    if (!pending || !api || !conversation || !active || run || !name.trim() || !context?.spaces.some((space) => space.id === spaceId)) return;
    setPending(null);
    watch(startSessionImportRun({ api, bridge, tabId: active.id, sourceUrl: conversation.url,
      mode: { kind: 'create', title: name.trim(), spaceIds: [spaceId], clientMessageId: pending.clientMessageId },
      onProgress: ({ steps }) => setProgress(steps) }));
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
      {run
        ? <>
          <span aria-live="polite" className="browser-import-progress">
            {progress === 0 ? 'Starting the import…' : `Reading the conversation… ${progress} ${progress === 1 ? 'step' : 'steps'}`}
          </span>
          <Button onClick={() => void run.cancel()}>Cancel</Button>
        </>
        : <Button className="button-primary" disabled={!conversation || !api || (update !== null && !updatable)}
          onClick={beginImport}
          title={conversation ? `Import “${conversation.title}”` : 'Open a Claude or ChatGPT chat to import it'}>
          {update ? 'Import updates' : 'Import'}
        </Button>}
    </div>
    {(failure ?? browserError) && <div className="browser-import-banner" role="alert">{failure ?? browserError}</div>}
    <main className="browser-import-page" ref={pageRef}>
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
      footer={<>
        <Button onClick={() => setPending(null)}>Cancel</Button>
        <Button className="button-primary" disabled={!name.trim() || !spaceId} onClick={startChannel}>Import</Button>
      </>}
      onOpenChange={(open) => { if (!open) setPending(null); }}
      open={pending !== null}
      title="Import channel"
    >
      <form className="space-create-form" onSubmit={(event) => { event.preventDefault(); startChannel(); }}>
        <label className="form-field">
          <span>Space</span>
          <DropdownSelect ariaLabel="Space" disabled={context?.spaceLocked === true} onValueChange={(value) => { setSpaceId(value); renewRequest(); }}
            options={spaces.map((space) => ({ label: space.name, value: space.id }))} value={spaceId} />
        </label>
        <label className="form-field" htmlFor={nameId}>
          <span>Name of channel</span>
          <input autoFocus id={nameId} maxLength={180} onChange={(event) => { setName(event.target.value); renewRequest(); }} required value={name} />
        </label>
        {spaces.length === 0 && <InlineError>There is no Space to import into. Create one in Rally first.</InlineError>}
      </form>
    </Modal>
  </div>;
}
