import { artifactInsetScript } from './layout';
import { useTheme } from './theme';
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { Linking, Platform, StyleSheet, View, Text, Pressable, ActivityIndicator } from 'react-native';
import { WebView } from 'react-native-webview';
import { randomUUID } from 'expo-crypto';
import { commandScript, isAppUrl, parseMobileEvent, type MobileCommand, type MobileEvent, type NativeArtifact } from './protocol';

export interface CanvasWebViewHandle { send: (command: MobileCommand) => void; reload: () => void }
export interface CanvasWebViewProps {
  url: string;
  appUrl: string;
  background: string;
  topInset?: number;
  onEvent: (event: MobileEvent) => void;
  onLoading: () => void;
  onError: () => void;
}

export const CanvasWebView = forwardRef<CanvasWebViewHandle, CanvasWebViewProps>(function CanvasWebView(props, ref) {
  const web = useRef<WebView<unknown>>(null);
  const token = useRef(randomUUID());
  const lastNavigation = useRef(props.url);
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
    injectedJavaScriptBeforeContentLoaded={`window.__RALLY_MOBILE_BRIDGE_TOKEN__=${JSON.stringify(token.current)}; true;`}
    injectedJavaScriptBeforeContentLoadedForMainFrameOnly
    onLoadStart={(event) => {
      const previous = new URL(lastNavigation.current);
      const next = new URL(event.nativeEvent.url);
      lastNavigation.current = next.href;
      const sameDocument = previous.origin === next.origin && previous.pathname === next.pathname && previous.search === next.search && previous.hash !== next.hash;
      if (!sameDocument) props.onLoading();
    }}
    onLoadEnd={() => web.current?.injectJavaScript(`window.__RALLY_MOBILE_BRIDGE_TOKEN__=${JSON.stringify(token.current)}; document.documentElement.style.setProperty("--mobile-top-inset", "${props.topInset ?? 0}px"); window.dispatchEvent(new Event("rally:mobile-ready")); true;`)}
    onError={props.onError}
    onHttpError={(event) => { if (event.nativeEvent.statusCode >= 400 && isAppUrl(event.nativeEvent.url, props.appUrl)) props.onError(); }}
    onContentProcessDidTerminate={() => web.current?.reload()}
    onRenderProcessGone={() => web.current?.reload()}
    onMessage={(event) => {
      const message = parseMobileEvent(event.nativeEvent.data, event.nativeEvent.url, props.appUrl, token.current);
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

/** A first-party artifact WebView avoids Safari's cross-site cookie restriction.
 * Only a presentation inset is injected; generated code has no native capability. */
export function ArtifactView({ access, background, topInset, onRetry }: { access: NativeArtifact; background: string; topInset: number; onRetry: () => void }) {
  const { colors } = useTheme();
  const web = useRef<WebView<unknown>>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  useEffect(() => { web.current?.injectJavaScript(artifactInsetScript(topInset)); }, [topInset]);
  return <View style={{ flex: 1, backgroundColor: background }}>
    <WebView<unknown> ref={web} source={{ uri: access.openUrl }} style={styles.web}
      sharedCookiesEnabled thirdPartyCookiesEnabled={false} javaScriptCanOpenWindowsAutomatically={false} setSupportMultipleWindows
      contentInsetAdjustmentBehavior="never" automaticallyAdjustContentInsets={false}
      onLoadStart={() => { setLoading(true); setFailed(false); }} onLoadEnd={() => { web.current?.injectJavaScript(artifactInsetScript(topInset)); setLoading(false); }}
      onError={() => { setFailed(true); setLoading(false); }}
      onHttpError={(event) => { if (event.nativeEvent.statusCode >= 400 && [access.openUrl, access.canonicalUrl, new URL('/redeem', access.canonicalUrl).href].includes(event.nativeEvent.url)) setFailed(true); }}
      onContentProcessDidTerminate={() => web.current?.reload()} onRenderProcessGone={() => web.current?.reload()}
      onOpenWindow={(event) => {
        try {
          const url = new URL(event.nativeEvent.targetUrl);
          if (['https:', 'http:'].includes(url.protocol)) void Linking.openURL(url.href);
        } catch { /* Ignore a malformed popup destination. */ }
      }}
      onShouldStartLoadWithRequest={(request) => {
        if (request.url === 'about:blank' || request.isTopFrame === false) return true;
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
