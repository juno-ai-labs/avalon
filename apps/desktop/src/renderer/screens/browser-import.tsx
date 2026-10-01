import type { SessionImportPreview } from '@rally/contracts';
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
import { browserConversation, readBrowserConversation } from '../lib/browser-conversation-import';
import { desktopBridge } from '../lib/platform';
import { uuidV7 } from '../lib/telemetry';

/** Where a person starts: the two providers whose signed-in chats can be read. */
const PROVIDERS = [
  { label: 'claude.ai', url: 'https://claude.ai/' },
  { label: 'chatgpt.com', url: 'https://chatgpt.com/' },
] as const;

interface PendingImport {
  preview: SessionImportPreview;
  clientMessageId: string;
  /** Minted here so the main window can list the Channel before it exists. */
  workstreamId: string;
}

/**
 * One create: the receipt key and the id it claims travel together. A retry of
 * an unchanged request keeps both; a changed one takes both anew, because a
 * failed attempt can leave its id reserved under its own key.
 */
function requestIdentity(): Pick<PendingImport, 'clientMessageId' | 'workstreamId'> {
  return { clientMessageId: crypto.randomUUID(), workstreamId: uuidV7() };
}

/**
 * The import window: the account's browser with Close and Import around it.
 *
 * Import reads the conversation the active tab is showing, previews it through
 * the ordinary import boundary, and asks only for what a Channel needs — its
 * name and Space — before creating it. The main window lists the Channel as
 * pending, under the id this window gives it, while the create runs; it then
 * opens the Channel and this window closes.
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
  const [reading, setReading] = useState(false);
  const [pending, setPending] = useState<PendingImport | null>(null);
  const [name, setName] = useState('');
  const [spaceId, setSpaceId] = useState('');
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [importFailure, setImportFailure] = useState<string | null>(null);

  const conversation = active ? browserConversation(active) : null;
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

  // Main reuses an open window and replaces its context, so a choice the new
  // Spaces no longer hold, or a Space the new context locks away, moves to the
  // first one it offers. A different Space is a different Channel, so an open
  // sheet takes a new request identity with it.
  useEffect(() => {
    const offered = context?.spaces ?? [];
    if (spaceId === '' || offered.some((space) => space.id === spaceId)) return;
    setSpaceId(offered[0]?.id ?? '');
    setPending((current) => current && { ...current, ...requestIdentity() });
  }, [context, spaceId]);

  // A failure names the chat it was about; it does not follow the person to the next one.
  useEffect(() => { setFailure(null); }, [conversation?.url]);

  const beginImport = async (): Promise<void> => {
    if (!conversation || !api || reading) return;
    setReading(true);
    setFailure(null);
    const url = conversation.url;
    try {
      const read = await readBrowserConversation(bridge, url, { tabId: active?.id });
      const preview = await api.previewSessionImport({ kind: 'export', provider: read.provider, text: read.text, sourceUrl: url });
      const spaces = context?.spaces ?? [];
      setName(preview.title);
      setSpaceId((current) => spaces.some((space) => space.id === current) ? current : spaces[0]?.id ?? '');
      setImportFailure(null);
      setPending({ preview, ...requestIdentity() });
    } catch (error) {
      setFailure(error instanceof Error ? error.message : 'The conversation could not be read.');
    } finally {
      setReading(false);
    }
  };

  // A retry of the same request keeps its identity; a changed name or Space is
  // a different Channel, which the creation receipt would refuse under the old one.
  const renewRequest = (): void => {
    setPending((current) => current && { ...current, ...requestIdentity() });
  };

  const createChannel = async (): Promise<void> => {
    if (!pending || !api || saving || !name.trim() || !context?.spaces.some((space) => space.id === spaceId)) return;
    setSaving(true);
    setImportFailure(null);
    const title = name.trim();
    const { workstreamId } = pending;
    let id: string;
    try {
      // Listed first: the Channel appears in its Space while its room is still
      // being written, and only the main window's pending row keeps it from
      // being opened before the room accepts a connection.
      await bridge.reportBrowserImport({ phase: 'importing', workstreamId, title, spaceId });
      id = await api.importSession(pending.preview, pending.clientMessageId, { title, spaceIds: [spaceId], workstreamId });
    } catch (error) {
      void bridge.reportBrowserImport({ phase: 'failed', workstreamId }).catch(() => undefined);
      setImportFailure(error instanceof Error ? error.message : 'The channel could not be created.');
      setSaving(false);
      return;
    }
    // A receipt reserved by a Worker from before `workstreamId` replays under
    // the id that Worker minted. The announced row then names nothing: take it
    // away, and the hand-off below opens the Channel under its real id.
    if (id !== workstreamId) await bridge.reportBrowserImport({ phase: 'failed', workstreamId }).catch(() => undefined);
    await bridge.completeBrowserImport(id).catch((error: unknown) => {
      // The Channel exists; the main window must not keep waiting on it.
      if (id === workstreamId) void bridge.reportBrowserImport({ phase: 'imported', workstreamId }).catch(() => undefined);
      setImportFailure(error instanceof Error ? error.message : 'The channel was created but could not be opened.');
      setSaving(false);
    });
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
      <Button className="button-primary" disabled={!conversation || !api || reading}
        onClick={() => void beginImport()}
        title={conversation ? `Import “${conversation.title}”` : 'Open a Claude or ChatGPT chat to import it'}>
        {reading ? 'Reading…' : 'Import'}
      </Button>
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
        <Button disabled={saving} onClick={() => setPending(null)}>Cancel</Button>
        <Button className="button-primary" disabled={saving || !name.trim() || !spaceId} onClick={() => void createChannel()}>
          {saving ? 'Importing…' : 'Import'}
        </Button>
      </>}
      onOpenChange={(open) => { if (!open && !saving) setPending(null); }}
      open={pending !== null}
      title="Import channel"
    >
      <form className="space-create-form" onSubmit={(event) => { event.preventDefault(); void createChannel(); }}>
        <label className="form-field">
          <span>Space</span>
          <DropdownSelect ariaLabel="Space" disabled={saving || context?.spaceLocked === true} onValueChange={(value) => { setSpaceId(value); renewRequest(); }}
            options={spaces.map((space) => ({ label: space.name, value: space.id }))} value={spaceId} />
        </label>
        <label className="form-field" htmlFor={nameId}>
          <span>Name of channel</span>
          <input autoFocus disabled={saving} id={nameId} maxLength={180} onChange={(event) => { setName(event.target.value); renewRequest(); }} required value={name} />
        </label>
        {spaces.length === 0 && <InlineError>There is no Space to import into. Create one in Rally first.</InlineError>}
        {importFailure && <InlineError>{importFailure}</InlineError>}
      </form>
    </Modal>
  </div>;
}
