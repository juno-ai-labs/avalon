import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { randomUUID } from 'expo-crypto';
import { MOBILE_CHANNEL, parseMobileEvent } from './protocol';
import type { CanvasWebViewHandle, CanvasWebViewProps } from './CanvasWebView';

/** Development preview only. Device builds use WKWebView / Android WebView. */
export const CanvasWebView = forwardRef<CanvasWebViewHandle, CanvasWebViewProps>(function CanvasWebView(props, ref) {
  const frame = useRef<HTMLIFrameElement>(null);
  const token = useRef(randomUUID());
  const origin = new URL(props.appUrl).origin;
  const frameUrl = new URL(props.url);
  frameUrl.searchParams.set('mobilePreviewOrigin', window.location.origin);
  useImperativeHandle(ref, () => ({
    send: (command) => frame.current?.contentWindow?.postMessage({ channel: MOBILE_CHANNEL, token: token.current, command }, origin),
    reload: () => { if (frame.current) frame.current.src = frameUrl.href; },
  }), [origin, props.url]);
  useEffect(() => {
    function receive(event: MessageEvent) {
      if (event.origin !== origin || event.source !== frame.current?.contentWindow) return;
      const parsed = parseMobileEvent(JSON.stringify(event.data), props.url, props.appUrl, token.current);
      if (parsed) props.onEvent(parsed);
    }
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, [origin, props]);
  return <iframe ref={frame} src={frameUrl.href} title="Rally canvas content" style={{ flex: 1, width: '100%', height: '100%', border: 0, background: props.background }}
    onLoad={() => {
      props.onLoading();
      frame.current?.contentWindow?.postMessage({ channel: MOBILE_CHANNEL, attach: token.current, topInset: props.topInset ?? 0 }, origin);
    }} onError={props.onError} />;
});

export function ArtifactView() { return null; }
