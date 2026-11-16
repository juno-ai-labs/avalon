import { recordFailure, recordTiming } from './diagnostics';
import { artifactInsetScript } from './layout';
import { artifactBackground, artifactPresented, artifactPresentationScript } from './artifact-presentation';
import { useTheme } from './theme';
import { forwardRef, useEffect, useId, useImperativeHandle, useRef, useState } from 'react';
import { recovery } from './recovery-order';
import { Linking, Platform, StyleSheet, View, Text, Pressable, ActivityIndicator } from 'react-native';
import { WebView } from 'react-native-webview';
import { randomUUID } from 'expo-crypto';
import { openAuthSessionAsync } from 'expo-web-browser';
import { MOBILE_CONNECTOR_CALLBACK } from '@rally/contracts/connector-oauth-claim';
import { MOBILE_CAPABILITIES, MOBILE_CAPABILITIES_GLOBAL, artifactAuthHandoff, artifactLoadFailure, artifactPreparationNavigation, commandScript, isAppUrl, parseMobileEvent, type MobileCommand, type MobileEvent, type NativeArtifact } from './protocol';

export interface CanvasWebViewHandle { send: (command: MobileCommand) => void; reload: () => void }
export interface CanvasWebViewProps {
  url: string;
  appUrl: string;
  background: string;
  topInset?: number;
  /** Shown to the person now. Defaults to true; hidden views recover last. */
  focused?: boolean;
  /** Recovery identity, so other code can `wake` this renderer. */
  recoveryId?: string;
  /** The page's renderer died; it answers nothing until it reloads. */
  onTerminated?: () => void;
  onEvent: (event: MobileEvent) => void;
  onLoading: () => void;
  onError: () => void;
}

export const CanvasWebView = forwardRef<CanvasWebViewHandle, CanvasWebViewProps>(function CanvasWebView(props, ref) {
  const web = useRef<WebView<unknown>>(null);
  const token = useRef(randomUUID());
  const lastNavigation = useRef(props.url);
  const generatedId = useId();
  const recoveryId = props.recoveryId ?? generatedId;
  const focused = props.focused ?? true;
  const shown = useRef(focused);
  shown.current = focused;
  useEffect(() => { if (focused) recovery.wake(recoveryId); else recovery.settled(recoveryId); }, [focused, recoveryId]);
  useEffect(() => () => recovery.forget(recoveryId), [recoveryId]);
  const terminated = () => {
    recordFailure('webview_process_terminated');
    props.onTerminated?.();
    const reload = () => web.current?.reload();
    if (!shown.current) { recovery.defer(recoveryId, reload); return; }
    recovery.recovering(recoveryId);
    reload();
  };
  useEffect(() => { web.current?.injectJavaScript(`document.documentElement.style.setProperty("--mobile-top-inset", "${props.topInset ?? 0}px"); true;`); }, [props.topInset]);
  useImperativeHandle(ref, () => ({
    send: (command) => web.current?.injectJavaScript(commandScript(command, props.appUrl)),
    reload: () => web.current?.reload(),
  }), [props.appUrl]);
  return <WebView<unknown>
    ref={web}
    source={{ uri: props.url }}
    style={[styles.web, { backgroundColor: props.background }]}
    sharedCookiesEnabled
    thirdPartyCookiesEnabled={false}
    javaScriptCanOpenWindowsAutomatically={false}
    setSupportMultipleWindows
    allowsBackForwardNavigationGestures={false}
    allowsInlineMediaPlayback
    contentInsetAdjustmentBehavior="never"
    automaticallyAdjustContentInsets={false}
    removeIosKeyboardObserver
    injectedJavaScriptBeforeContentLoaded={`window.__RALLY_MOBILE_BRIDGE_TOKEN__=${JSON.stringify(token.current)}; window.${MOBILE_CAPABILITIES_GLOBAL}=${JSON.stringify(MOBILE_CAPABILITIES)}; true;`}
    injectedJavaScriptBeforeContentLoadedForMainFrameOnly
    onLoadStart={(event) => {
      const previous = new URL(lastNavigation.current);
      const next = new URL(event.nativeEvent.url);
      lastNavigation.current = next.href;
      const sameDocument = previous.origin === next.origin && previous.pathname === next.pathname && previous.search === next.search && previous.hash !== next.hash;
      if (!sameDocument) props.onLoading();
    }}
    onLoadEnd={() => { recovery.settled(recoveryId); web.current?.injectJavaScript(`window.__RALLY_MOBILE_BRIDGE_TOKEN__=${JSON.stringify(token.current)}; document.documentElement.style.setProperty("--mobile-top-inset", "${props.topInset ?? 0}px"); window.dispatchEvent(new Event("rally:mobile-ready")); true;`); }}
    onError={() => { recovery.settled(recoveryId); recordFailure('webview_load_failed'); props.onError(); }}
    onHttpError={(event) => { if (event.nativeEvent.statusCode >= 400 && isAppUrl(event.nativeEvent.url, props.appUrl)) { recordFailure('webview_load_failed'); props.onError(); } }}
    onContentProcessDidTerminate={terminated}
    onRenderProcessGone={terminated}
    onMessage={(event) => {
      const message = parseMobileEvent(event.nativeEvent.data, event.nativeEvent.url, props.appUrl, token.current);
      if (message?.type === 'open-external') { void Linking.openURL(message.url); return; }
      if (message?.type === 'connector-authorize') {
        // Safari has no Rally session, so the page that started this claims
        // the callback; the auth session hands it back instead of Safari.
        void openAuthSessionAsync(message.url, MOBILE_CONNECTOR_CALLBACK).then((result) => {
          if (result.type === 'success') web.current?.injectJavaScript(commandScript({ type: 'connector-complete', url: result.url }, props.appUrl));
        });
        return;
      }
      if (message) props.onEvent(message);
    }}
    onShouldStartLoadWithRequest={(request) => {
      // Cross-origin artifact frames retain their existing sandbox. Only the
      // top-level application can navigate the shell or send bridge events.
      if (request.isTopFrame === false || request.url === 'about:blank') return true;
      try {
        const target = new URL(request.url);
        if (target.origin === new URL(props.appUrl).origin) return true;
        if (['https:', 'http:', 'mailto:', 'tel:'].includes(target.protocol)) void Linking.openURL(target.href);
      } catch { /* Non-URL web navigation cannot leave the app. */ }
      return false;
    }}
    onOpenWindow={(event) => {
      try {
        const url = new URL(event.nativeEvent.targetUrl);
        if (['https:', 'http:'].includes(url.protocol)) void Linking.openURL(url.href);
      } catch { /* Ignore a malformed popup destination. */ }
    }}
  />;
});
const styles = StyleSheet.create({ web: { flex: 1 } });

/** Redeem in a real, attached WebView so the platform stores the HttpOnly cookie.
 * Stop at the redirect: generated artifact code never runs in the background. */
export function ArtifactSessionPreparation({ access, onReady }: { access: NativeArtifact; onReady: () => void }) {
  const [finished, setFinished] = useState(false);
  const complete = useRef(false);
  const stop = () => { complete.current = true; setFinished(true); };
  if (finished) return null;
  return <View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ position: 'absolute', width: 1, height: 1, opacity: 0 }}>
    <WebView source={{ uri: access.openUrl }} sharedCookiesEnabled thirdPartyCookiesEnabled={false}
      javaScriptCanOpenWindowsAutomatically={false} setSupportMultipleWindows
      onError={stop} onHttpError={stop} onContentProcessDidTerminate={stop} onRenderProcessGone={stop}
      onShouldStartLoadWithRequest={(request) => {
        if (complete.current) return false;
        const action = artifactPreparationNavigation(access.canonicalUrl, request.url);
        if (action === 'ready') { stop(); onReady(); }
        return action === 'allow';
      }} />
  </View>;
}

/** A first-party artifact WebView avoids Safari's cross-site cookie restriction.
 * Only a presentation inset is injected; generated code has no native capability.
 *
 * A terminated renderer recovers in place: the redeemed cookie lives in the
 * platform cookie store, not the dead process, so a new WebView on the canonical
 * URL needs no fresh access from Home. A lost cookie still reaches `renew`. */
export function ArtifactView({ access, appUrl, background, topInset, focused = true, onRetry, onPresented, onBackground }: { access: NativeArtifact; appUrl: string; background: string; topInset: number; focused?: boolean; onRetry: () => void; onPresented?: () => void; onBackground?: (color: string) => void }) {
  const { colors } = useTheme();
  const web = useRef<WebView<unknown>>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const renewing = useRef(false);
  const renew = () => { if (!renewing.current) { renewing.current = true; onRetry(); } };
  // After a crash this access's one-time open URL is spent; only the cookie
  // path remains. Fresh access from the parent starts from its own open URL.
  const [restart, setRestart] = useState({ count: 0, openUrl: '' });
  const uri = restart.openUrl === access.openUrl ? access.canonicalUrl : access.openUrl;
  const recoveryId = useId();
  const shown = useRef(focused);
  shown.current = focused;
  const recoveringSince = useRef<number | null>(null);
  const presentedLoad = useRef(false);
  const presented = () => {
    setLoading(false);
    if (presentedLoad.current) return;
    presentedLoad.current = true;
    onPresented?.();
    if (recoveringSince.current !== null) { recordTiming('artifact_recovery', performance.now() - recoveringSince.current); recoveringSince.current = null; }
  };
  const terminated = () => {
    recordFailure('artifact_process_terminated');
    // Only a recovery the person watches is timed.
    recoveringSince.current = shown.current ? performance.now() : null;
    setFailed(false); setLoading(true);
    const openUrl = access.openUrl;
    // Changing the source alone would load into the hidden view at once, so
    // the remount sets the spent open URL and the new key together.
    const remount = () => setRestart(({ count }) => ({ count: count + 1, openUrl }));
    if (!shown.current) { recovery.defer(recoveryId, remount); return; }
    recovery.recovering(recoveryId);
    remount();
  };
  useEffect(() => { if (focused) recovery.wake(recoveryId); else recovery.settled(recoveryId); }, [focused, recoveryId]);
  useEffect(() => { if (!loading || failed) recovery.settled(recoveryId); }, [loading, failed, recoveryId]);
  useEffect(() => () => recovery.forget(recoveryId), [recoveryId]);
  useEffect(() => { web.current?.injectJavaScript(artifactInsetScript(topInset)); }, [topInset]);
  return <View style={{ flex: 1, backgroundColor: background }}>
    <WebView<unknown> key={restart.count} ref={web} source={{ uri }} style={styles.web}
      sharedCookiesEnabled thirdPartyCookiesEnabled={false} javaScriptCanOpenWindowsAutomatically={false} setSupportMultipleWindows
      contentInsetAdjustmentBehavior="never" automaticallyAdjustContentInsets={false}
      removeIosKeyboardObserver
      injectedJavaScriptBeforeContentLoaded={artifactPresentationScript(topInset)}
      injectedJavaScriptBeforeContentLoadedForMainFrameOnly
      onMessage={(event) => {
        const { data, url } = event.nativeEvent;
        if (artifactPresented(data, url, access.canonicalUrl)) { presented(); return; }
        const color = artifactBackground(data, url, access.canonicalUrl);
        if (color) onBackground?.(color);
      }}
      onLoadStart={() => { presentedLoad.current = false; setLoading(true); setFailed(false); }} onLoadEnd={() => { web.current?.injectJavaScript(artifactInsetScript(topInset)); presented(); }}
      onError={() => { recordFailure('artifact_load_failed'); setFailed(true); setLoading(false); }}
      onHttpError={(event) => {
        const action = artifactLoadFailure({ openUrl: uri, canonicalUrl: access.canonicalUrl }, event.nativeEvent.url, event.nativeEvent.statusCode);
        if (action === 'ignore') return;
        if (action === 'renew') { renew(); return; }
        recordFailure('artifact_load_failed'); setFailed(true);
      }}
      onContentProcessDidTerminate={terminated} onRenderProcessGone={terminated}
      onOpenWindow={(event) => {
        try {
          const url = new URL(event.nativeEvent.targetUrl);
          if (['https:', 'http:'].includes(url.protocol)) void Linking.openURL(url.href);
        } catch { /* Ignore a malformed popup destination. */ }
      }}
      onShouldStartLoadWithRequest={(request) => {
        if (request.url === 'about:blank' || request.isTopFrame === false) return true;
        if (artifactAuthHandoff(access.canonicalUrl, request.url, appUrl)) {
          if (uri === access.canonicalUrl) renew();
          else { recordFailure('artifact_load_failed'); setFailed(true); setLoading(false); }
          return false;
        }
        try {
          const url = new URL(request.url);
          if (url.origin === new URL(access.canonicalUrl).origin) return true;
          if ((request.navigationType === 'click' || Platform.OS === 'android') && ['https:', 'http:'].includes(url.protocol)) void Linking.openURL(url.href);
        } catch { /* Keep the artifact inside its own origin. */ }
        return false;
      }} />
    {(loading || failed) && <View style={[StyleSheet.absoluteFill, { backgroundColor: background, justifyContent: 'center', alignItems: 'center', padding: 24 }]}>
      {failed ? <><Text style={{ color: colors.text }}>This canvas couldn’t load.</Text><Pressable accessibilityRole="button" onPress={onRetry} style={{ padding: 18 }}><Text style={{ color: colors.text }}>Try again</Text></Pressable></> : <ActivityIndicator color={colors.text} />}
    </View>}
  </View>;
}
