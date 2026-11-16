import { systemSignIn } from './src/auth';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, AppState, BackHandler, Keyboard, KeyboardAvoidingView, Modal, Platform, Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { CanvasWebView, ArtifactView, type CanvasWebViewHandle } from './src/CanvasWebView';
import { EXPANDED_LAYOUT_WIDTH, FLOATING_HEADER_INSET } from './src/layout';
import { Glass } from './src/Glass';
import { TabBar, TAB_BAR_SPACE, TAB_RAIL_SPACE } from './src/PreviewTabBar';
import { Sidebar } from './src/Sidebar';
import { SettingsScreen } from './src/SettingsScreen';
import { mobileUrl, trustedArtifact, type NativeArtifact, type MobileCommand, type MobileEvent, type MobileSnapshot } from './src/protocol';
import { useTheme } from './src/theme';

const APP_URL = process.env.EXPO_PUBLIC_RALLY_APP_URL || 'https://app.rallywith.ai';
const ARTIFACT_DOMAIN = process.env.EXPO_PUBLIC_RALLY_ARTIFACT_DOMAIN || 'rallyusercontent.com';
const START_URL = mobileUrl(APP_URL);

export default function App() {
  return <SafeAreaProvider><CanvasApp /></SafeAreaProvider>;
}

function CanvasApp() {
  const { colors, isDark } = useTheme();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const expanded = width - insets.left - insets.right >= EXPANDED_LAYOUT_WIDTH;
  const root = useRef<CanvasWebViewHandle>(null);
  const [artifacts, setArtifacts] = useState<Record<string, NativeArtifact>>({});
  const scope = useRef<string | null>(null);
  const [snapshot, setSnapshot] = useState<MobileSnapshot | null>(null);
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  const [keyboardVisible, setKeyboardVisible] = useState(false);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [sidebar, setSidebar] = useState(false);
  const [conversation, setConversation] = useState<string | null>(null);
  const [settings, setSettings] = useState(false);
  const send = useCallback((command: MobileCommand) => root.current?.send(command), []);
  const closeConversation = useCallback(() => { setConversation(null); send({ type: 'refresh' }); }, [send]);
  const signingIn = useRef(false);
  const signIn = useCallback(async () => {
    if (signingIn.current) return;
    signingIn.current = true;
    try {
      const proof = await systemSignIn(APP_URL);
      if (proof) send({ type: 'sign-in-complete', proof });
    } catch { Alert.alert('Sign-in couldn’t finish', 'Please try again.'); }
    finally { signingIn.current = false; setKeyboardVisible(false); }
  }, [send]);
  const receive = useCallback((event: MobileEvent) => {
    if (event.type === 'sign-in') { void signIn(); return; }
    setReady(true);
    setFailed(false);
    if (event.type === 'open-canvas') send({ type: 'open', id: event.id, pinned: snapshotRef.current?.tabId === event.id });
    if (event.type === 'artifact') {
      if (!trustedArtifact(event.artifact, ARTIFACT_DOMAIN)) { setFailed(true); return; }
      setArtifacts((current) => ({ ...current, [event.artifact.canvasId]: event.artifact }));
    }
    if (event.type === 'artifact-unavailable') setArtifacts((current) => {
      if (current[event.canvasId]?.resourceId !== event.resourceId) return current;
      const next = { ...current }; delete next[event.canvasId]; return next;
    });
    if (event.type === 'snapshot') {
      const nextScope = `${event.snapshot.userId}:${event.snapshot.workspaceId}`;
      if (scope.current !== nextScope) { scope.current = nextScope; setArtifacts({}); }
      setSnapshot(event.snapshot);
    }
    if (event.type === 'signed-out') { setArtifacts({}); scope.current = null; setSnapshot(null); setSidebar(false); setConversation(null); }
  }, [send, signIn]);
  useEffect(() => {
    if (Platform.OS === 'web') return;
    // Duo reports zero-height show events while switching displays.
    const shown = Keyboard.addListener('keyboardWillShow', (event) => setKeyboardVisible(event.endCoordinates.height > 0));
    const androidShown = Keyboard.addListener('keyboardDidShow', (event) => setKeyboardVisible(event.endCoordinates.height > 0));
    const hidden = Keyboard.addListener('keyboardDidHide', () => setKeyboardVisible(false));
    return () => { shown.remove(); androidShown.remove(); hidden.remove(); };
  }, []);
  useEffect(() => {
    const listener = AppState.addEventListener('change', (state) => { if (state === 'active' && ready) send({ type: 'refresh' }); });
    return () => listener.remove();
  }, [ready, send]);
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    const listener = BackHandler.addEventListener('hardwareBackPress', () => {
      if (conversation) { closeConversation(); return true; }
      if (sidebar) { setSidebar(false); return true; }
      if (snapshot && snapshot.view !== 'home') { send({ type: 'home' }); return true; }
      return false;
    });
    return () => listener.remove();
  }, [closeConversation, conversation, send, sidebar, snapshot]);
  const action = (name: React.ComponentProps<typeof Ionicons>['name'], label: string, onPress: () => void) => <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} style={({ pressed }) => [styles.iconButton, { opacity: pressed ? 0.5 : 1 }]}><Ionicons name={name} size={23} color={colors.text} /></Pressable>;


  const showChrome = ready && snapshot !== null;
  // Stable native parents keep WKWebViews attached when visibility changes.
  const hostedArtifactVisible = snapshot?.view === 'artifact' && artifacts[snapshot.canvasId ?? '']?.resourceId === snapshot.artifactId;
  return <KeyboardAvoidingView enabled={keyboardVisible} behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={[styles.app, { backgroundColor: colors.background, paddingTop: insets.top, paddingLeft: insets.left, paddingRight: insets.right }]}>
    <StatusBar style={isDark ? 'light' : 'dark'} />
    <View style={{ flex: 1, marginLeft: showChrome && expanded ? TAB_RAIL_SPACE : 0, marginBottom: showChrome && !expanded && !keyboardVisible && snapshot.view !== 'artifact' ? TAB_BAR_SPACE + insets.bottom : 0 }}>
      <View collapsable={false} style={{ flex: 1 }} accessibilityElementsHidden={hostedArtifactVisible} importantForAccessibility={hostedArtifactVisible ? 'no-hide-descendants' : 'auto'}>
      <CanvasWebView ref={root} topInset={FLOATING_HEADER_INSET} appUrl={APP_URL} url={START_URL} background={colors.background} onEvent={receive}
        onLoading={() => { setReady(false); setFailed(false); setSnapshot(null); setSidebar(false); setConversation(null); }} onError={() => setFailed(true)} />
      </View>
      {Object.values(artifacts).map((access) => <View key={access.canvasId} collapsable={false} accessibilityElementsHidden={snapshot?.view !== 'artifact' || snapshot.canvasId !== access.canvasId || snapshot.artifactId !== access.resourceId} importantForAccessibility={snapshot?.view === 'artifact' && snapshot.canvasId === access.canvasId && snapshot.artifactId === access.resourceId ? 'auto' : 'no-hide-descendants'} pointerEvents={snapshot?.view === 'artifact' && snapshot.canvasId === access.canvasId && snapshot.artifactId === access.resourceId ? 'auto' : 'none'} style={[StyleSheet.absoluteFill, { top: snapshot?.artifactPicker ? FLOATING_HEADER_INSET + 48 : 0, opacity: snapshot?.view === 'artifact' && snapshot.canvasId === access.canvasId && snapshot.artifactId === access.resourceId ? 1 : 0 }]}><ArtifactView appUrl={APP_URL} topInset={snapshot?.artifactPicker ? 0 : FLOATING_HEADER_INSET} access={access} background={colors.background} onRetry={() => send({ type: 'reopen-artifact', canvasId: access.canvasId, resourceId: access.resourceId })} /></View>)}
      {(!ready || failed) && <View style={[styles.loading, { backgroundColor: colors.background }]}>
        {failed ? <><Text style={[styles.errorTitle, { color: colors.text }]}>Rally couldn’t load</Text><Text style={[styles.errorCopy, { color: colors.muted }]}>Check your connection and try again.</Text><Pressable accessibilityRole="button" onPress={() => { setFailed(false); root.current?.reload(); }} style={[styles.retry, { backgroundColor: colors.accent }]}><Text style={{ color: colors.onAccent }}>Try again</Text></Pressable></> : <ActivityIndicator accessibilityLabel="Opening Rally" color={colors.accent} />}
      </View>}
    </View>
    {showChrome && <View pointerEvents="box-none" style={[styles.toolbar, { left: insets.left + 24, right: insets.right + 24, top: insets.top + 8 }]}>
      <Glass style={styles.toolbarButton}>{action('menu-outline', 'Open sidebar', () => setSidebar(true))}</Glass>
      {snapshot.view === 'settings' && <Glass style={styles.toolbarButton}>{action('close', 'Back to settings', () => { send({ type: 'home' }); setSettings(true); })}</Glass>}
      {snapshot.view === 'home' && <Glass style={styles.toolbarButton}>{action('add', 'Create a canvas', () => send({ type: 'create' }))}</Glass>}
      {snapshot.view === 'artifact' && snapshot.canvasId && <Glass style={styles.toolbarButton}>{action('chatbubble-outline', 'Open conversation', () => setConversation(snapshot.canvasId))}</Glass>}
    </View>}
    {showChrome && !keyboardVisible && <TabBar snapshot={snapshot} bottomInset={insets.bottom} send={send} />}
    {snapshot && <Sidebar visible={sidebar} snapshot={snapshot} close={() => setSidebar(false)} send={send} openSettings={() => setSettings(true)} />}
    {/* The preview has no device notifications; the list is the native one. */}
    {snapshot && <Modal visible={settings} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setSettings(false)}>
      <SafeAreaProvider><View style={{ flex: 1, backgroundColor: colors.background, paddingTop: insets.top }}>
        <View style={styles.sheetHeader}><Text style={[styles.errorTitle, { flex: 1, color: colors.text, fontSize: 30 }]}>Settings</Text>{action('close', 'Close settings', () => setSettings(false))}</View>
        <SettingsScreen directory={snapshot} notifications={PREVIEW_NOTIFICATIONS}
          openSection={(section) => { setSettings(false); send({ type: 'settings', section }); }}
          switchOrganization={() => { setSettings(false); send({ type: 'switch-workspace' }); }}
          signOut={() => { setSettings(false); send({ type: 'sign-out' }); }}
          openDiagnostics={() => undefined} />
      </View></SafeAreaProvider>
    </Modal>}
    {snapshot && <Conversation visible={conversation !== null} url={conversation ? mobileUrl(APP_URL, snapshot.workspacePath, conversation) : START_URL} title={snapshot.title} onSignedOut={() => { closeConversation(); setArtifacts({}); setSnapshot(null); setReady(false); root.current?.reload(); }} onClose={closeConversation} onOpen={(id) => { closeConversation(); send({ type: 'open', id, pinned: snapshot.pins.includes(id) }); }} />}
  </KeyboardAvoidingView>;
}

const PREVIEW_NOTIFICATIONS = { permission: 'unavailable', registration: 'unavailable', enable: async () => undefined, retry: async () => undefined };

interface ConversationProps { visible: boolean; url: string; title: string; onClose: () => void; onOpen: (id: string) => void; onSignedOut: () => void }
function Conversation(props: ConversationProps) {
  return <Modal visible={props.visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={props.onClose} onDismiss={props.onClose}>
    <SafeAreaProvider><ConversationContent {...props} /></SafeAreaProvider>
  </Modal>;
}
function ConversationContent({ visible, url, title, onClose, onOpen, onSignedOut }: ConversationProps) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const web = useRef<CanvasWebViewHandle>(null);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(true);
  return <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={[styles.app, { backgroundColor: colors.surface, paddingLeft: insets.left, paddingRight: insets.right, paddingBottom: insets.bottom, paddingTop: Platform.OS === 'android' ? insets.top : 12 }]}>
      <View style={styles.sheetHeader}><View style={{ flex: 1 }}><Text style={[styles.errorTitle, { color: colors.text }]}>Conversation</Text><Text numberOfLines={1} style={{ color: colors.muted, marginTop: 4 }}>{title}</Text></View><Pressable accessibilityRole="button" accessibilityLabel="Close conversation" style={styles.iconButton} onPress={onClose}><Ionicons name="close" size={24} color={colors.text} /></Pressable></View>
      <View style={{ flex: 1 }}>
        {visible && <CanvasWebView ref={web} url={url} appUrl={APP_URL} background={colors.background} onLoading={() => { setLoading(true); setFailed(false); }} onError={() => { setLoading(false); setFailed(true); }} onEvent={(event) => { setLoading(false); if (event.type === 'signed-out') onSignedOut(); if (event.type === 'open-canvas') onOpen(event.id); }} />}
        {(loading || failed) && <View style={[styles.loading, { backgroundColor: colors.background }]}>{failed ? <><Text style={{ color: colors.text }}>Conversation couldn’t load.</Text><Pressable style={styles.retry} accessibilityRole="button" onPress={() => web.current?.reload()}><Text style={{ color: colors.accent }}>Try again</Text></Pressable></> : <ActivityIndicator color={colors.accent} />}</View>}
      </View>
    </KeyboardAvoidingView>;
}
const styles = StyleSheet.create({
  app: { flex: 1 }, toolbar: { position: 'absolute', left: 24, right: 24, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  toolbarButton: { width: 44, height: 44, borderRadius: 22, overflow: 'hidden' }, iconButton: { minWidth: 44, minHeight: 44, justifyContent: 'center', alignItems: 'center' },
  loading: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, justifyContent: 'center', alignItems: 'center', padding: 30 }, errorTitle: { fontSize: 18, fontWeight: '600' }, errorCopy: { textAlign: 'center', marginTop: 10, lineHeight: 21 }, retry: { paddingHorizontal: 24, paddingVertical: 14, marginTop: 20, borderRadius: 24 },
  sheetHeader: { flexDirection: 'row', alignItems: 'center', padding: 20, gap: 12 },
});
