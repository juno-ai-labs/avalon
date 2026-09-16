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

import { desktopBridge, desktopServicesAvailable } from '../lib/platform';
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
export function MessageTextMenu({ children, markdown, telemetry }: {
  children: ReactElement<{
    onContextMenuCapture?: (event: MouseEvent<HTMLElement>) => void;
  }>;
  markdown: string;
  telemetry?: { messageId: string; workstreamId: string };
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
  const speakName = speaking ? 'Stop speaking' : 'Speak response';

  useEffect(() => {
    if (!desktopServicesAvailable()) return;
    let cancelled = false;
    void desktopBridge().getRuntimeConfig().then((config) => {
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
      resourceId: telemetry.messageId,
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
    })().catch(() => undefined);
  };

  const copyMarkdown = (): void => {
    void navigator.clipboard.writeText(markdown).then(reportCopied).catch(() => undefined);
  };

  const toggleSpeech = (): void => {
    if (!speech) return;
    if (speaking) speech.stop();
    else speech.speak(speechId, markdown);
  };

  const lookUp = (): void => {
    restoreMessageSelection(snapshotRef.current.range);
    void desktopBridge().showDefinitionForSelection().catch(() => undefined);
  };

  const share = (): void => {
    const text = snapshotRef.current.plain.length > 0 ? snapshotRef.current.plain : markdown;
    void desktopBridge().shareText(text).catch(() => undefined);
  };

  const child = Children.only(children);
  const nativeServices = darwinDesktop && desktopServicesAvailable();

  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>
        {cloneElement(child, { onContextMenuCapture: captureSelection })}
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className="menu-content sidebar-context-menu" collisionPadding={8}>
          <ContextMenu.Item className="menu-item" onSelect={copyFormatted}>Copy</ContextMenu.Item>
          <ContextMenu.Item className="menu-item" onSelect={copyMarkdown}>Copy as markdown</ContextMenu.Item>
          {speech && (
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
