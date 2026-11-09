import * as ContextMenu from '@radix-ui/react-context-menu';
import {
  Children,
  cloneElement,
  useEffect,
  useId,
  useRef,
  useState,
  type MouseEvent,
  type ReactElement,
} from 'react';

import { logError } from '../../common/logger';
import { desktopBridge, desktopRuntimeConfig, desktopServicesAvailable } from '../lib/platform';
import {
  cloneMessageHtml,
  EMPTY_MESSAGE_TEXT_SNAPSHOT,
  restoreMessageSelection,
  snapshotMessageSelection,
  writeFormattedClipboard,
  type MessageTextSnapshot,
} from '../lib/message-text-clipboard';
import { reportTelemetryProductIntent } from '../lib/telemetry';
import { useSpeechPlayback } from './speech-playback';

/**
 * Right-click menu on a feed message body. Copy / Copy as markdown / Speak
 * share the action row's speech toggle and the window's one-voice mutex;
 * Look Up and Share are macOS-only OS affordances behind trusted IPC.
 */
export function MessageTextMenu({ children, markdown, speechKind = 'response', streaming = false, telemetry }: {
  children: ReactElement<{
    onContextMenuCapture?: (event: MouseEvent<HTMLElement>) => void;
  }>;
  markdown: string;
  speechKind?: 'response' | 'message';
  streaming?: boolean;
  telemetry?: { messageId: string; workstreamId: string; turnId?: string | undefined };
}) {
  const snapshotRef = useRef<MessageTextSnapshot>(EMPTY_MESSAGE_TEXT_SNAPSHOT);
  const bodyRef = useRef<HTMLElement | null>(null);
  const [hasSelection, setHasSelection] = useState(false);
  const [darwinDesktop, setDarwinDesktop] = useState(false);
  const fallbackSpeechId = useId();
  const speech = useSpeechPlayback();
  const speechId = telemetry?.messageId ?? fallbackSpeechId;
  const speaking = speech?.activeMessageId === speechId;
  const speakLabel = speaking ? 'Stop speaking' : 'Speak';
  const speakName = speaking
    ? 'Stop speaking'
    : speechKind === 'message' ? 'Speak' : 'Speak response';

  useEffect(() => {
    if (!desktopServicesAvailable()) return;
    let cancelled = false;
    void desktopRuntimeConfig().then((config) => {
      if (!cancelled) setDarwinDesktop(config.platform === 'darwin');
    }).catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const captureSelection = (event: MouseEvent<HTMLElement>): void => {
    const root = event.currentTarget;
    bodyRef.current = root;
    const snapshot = snapshotMessageSelection(root);
    snapshotRef.current = snapshot;
    setHasSelection(snapshot.plain.length > 0);
  };

  const reportCopied = (): void => {
    if (!telemetry) return;
    reportTelemetryProductIntent({
      kind: 'content_copied',
      contentType: 'message_response',
      resourceType: 'message',
      resourceId: telemetry.turnId ?? telemetry.messageId,
      workstreamId: telemetry.workstreamId,
    });
  };

  const copyFormatted = (): void => {
    const snapshot = snapshotRef.current;
    const body = bodyRef.current;
    void (async () => {
      if (snapshot.plain.length > 0) {
        await writeFormattedClipboard(snapshot.html, snapshot.plain);
      } else if (body) {
        const whole = cloneMessageHtml(body);
        await writeFormattedClipboard(whole.html, whole.plain);
      }
      reportCopied();
    })().catch((error) => {
      logError('rally', 'could not copy this message', error);
    });
  };

  const copyMarkdown = (): void => {
    void navigator.clipboard.writeText(markdown).then(reportCopied).catch((error) => {
      logError('rally', 'could not copy this message as markdown', error);
    });
  };

  const toggleSpeech = (): void => {
    if (!speech) return;
    if (speaking) speech.stop();
    else speech.speak(speechId, markdown);
  };

  const lookUp = (): void => {
    restoreMessageSelection(snapshotRef.current.range);
    void desktopBridge().showDefinitionForSelection().catch((error) => {
      logError('rally', 'could not look up this selection', error);
    });
  };

  const share = (): void => {
    const body = bodyRef.current;
    const text = snapshotRef.current.plain.length > 0
      ? snapshotRef.current.plain
      : body ? cloneMessageHtml(body).plain : '';
    if (text.length === 0) return;
    void desktopBridge().shareText(text).catch((error) => {
      logError('rally', 'could not share this message', error);
    });
  };

  const child = Children.only(children);
  const nativeServices = darwinDesktop && desktopServicesAvailable();
  const offerSpeech = speech && !streaming;

  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>
        {cloneElement(child, { onContextMenuCapture: captureSelection })}
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className="menu-content sidebar-context-menu" collisionPadding={8}>
          <ContextMenu.Item className="menu-item" onSelect={copyFormatted}>Copy</ContextMenu.Item>
          <ContextMenu.Item className="menu-item" onSelect={copyMarkdown}>Copy as markdown</ContextMenu.Item>
          {offerSpeech && (
            <ContextMenu.Item aria-label={speakName} className="menu-item" onSelect={toggleSpeech}>
              {speakLabel}
            </ContextMenu.Item>
          )}
          {nativeServices && <ContextMenu.Separator className="menu-separator" />}
          {nativeServices && (
            <ContextMenu.Item className="menu-item" disabled={!hasSelection} onSelect={lookUp}>
              Look Up
            </ContextMenu.Item>
          )}
          {nativeServices && (
            <ContextMenu.Item className="menu-item" onSelect={share}>Share</ContextMenu.Item>
          )}
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
