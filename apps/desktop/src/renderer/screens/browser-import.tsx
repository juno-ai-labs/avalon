import type { SessionImportPreview } from '@rally/contracts';
import { X } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import type { BrowserImportContext } from '../../common/browser-import';
import { EmbeddedBrowserNavigation, EmbeddedBrowserTabs, useEmbeddedBrowser, useEmbeddedBrowserPlacement } from '../components/embedded-browser-view';
import { Button, DropdownSelect, IconButton, InlineError, Modal } from '../components/primitives';
import { useAppSession } from '../lib/app-session';
import { browserConversation, readBrowserConversation } from '../lib/browser-conversation-import';
import { desktopBridge } from '../lib/platform';

/** Where a person starts: the two providers whose signed-in chats can be read. */
const PROVIDERS = [
  { label: 'claude.ai', url: 'https://claude.ai/' },
  { label: 'chatgpt.com', url: 'https://chatgpt.com/' },
] as const;

interface PendingImport {
  preview: SessionImportPreview;
  clientMessageId: string;
}

/**
 * The import window: the account's browser with Close and Import around it.
 *
 * Import reads the conversation the active tab is showing, previews it through
 * the ordinary import boundary, and asks only for what a Channel needs — its
 * name and Space — before creating it. The main window then opens the new
 * Channel and this window closes.
 */
export function BrowserImportWindow(): React.JSX.Element {
  const { api } = useAppSession();
  const bridge = desktopBridge();
  const { state, active, error: browserError, command } = useEmbeddedBrowser();
  const pageRef = useRef<HTMLElement>(null);
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

  // A failure names the chat it was about; it does not follow the person to the next one.
  useEffect(() => { setFailure(null); }, [conversation?.url]);

  const beginImport = async (): Promise<void> => {
    if (!conversation || !api || reading) return;
    setReading(true);
    setFailure(null);
    const url = conversation.url;
    try {
      const read = await readBrowserConversation(bridge, url);
      const preview = await api.previewSessionImport({ kind: 'export', provider: read.provider, text: read.text, sourceUrl: url });
      const spaces = context?.spaces ?? [];
      setName(preview.title);
      setSpaceId((current) => spaces.some((space) => space.id === current) ? current : spaces[0]?.id ?? '');
      setImportFailure(null);
      setPending({ preview, clientMessageId: crypto.randomUUID() });
    } catch (error) {
      setFailure(error instanceof Error ? error.message : 'The conversation could not be read.');
    } finally {
      setReading(false);
    }
  };

  const createChannel = async (): Promise<void> => {
    if (!pending || !api || saving || !name.trim() || !spaceId) return;
    setSaving(true);
    setImportFailure(null);
    try {
      const id = await api.importSession(pending.preview, pending.clientMessageId, { title: name.trim(), spaceIds: [spaceId] });
      await bridge.completeBrowserImport(id);
    } catch (error) {
      setImportFailure(error instanceof Error ? error.message : 'The channel could not be created.');
      setSaving(false);
    }
  };

  const spaces = context?.spaces ?? [];
  return <div className={darwin ? 'browser-import-window has-overlay-window-controls' : 'browser-import-window'}>
    <header className="browser-import-titlebar window-drag">
      <EmbeddedBrowserNavigation active={active} command={command} />
      <Button className="button-primary" disabled={!conversation || !api || reading}
        onClick={() => void beginImport()}
        title={conversation ? `Import “${conversation.title}”` : 'Open a Claude or ChatGPT chat to import it'}>
        {reading ? 'Reading…' : 'Import'}
      </Button>
      <IconButton label="Close" onClick={() => window.close()}><X size={17} /></IconButton>
    </header>
    {state.tabs.length > 1 && <EmbeddedBrowserTabs className="browser-import-tabs" command={command} state={state} />}
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
          <DropdownSelect ariaLabel="Space" disabled={saving} onValueChange={setSpaceId}
            options={spaces.map((space) => ({ label: space.name, value: space.id }))} value={spaceId} />
        </label>
        <label className="form-field" htmlFor={nameId}>
          <span>Name of channel</span>
          <input autoFocus disabled={saving} id={nameId} maxLength={180} onChange={(event) => setName(event.target.value)} required value={name} />
        </label>
        {spaces.length === 0 && <InlineError>There is no Space to import into. Create one in Rally first.</InlineError>}
        {importFailure && <InlineError>{importFailure}</InlineError>}
      </form>
    </Modal>
  </div>;
}
