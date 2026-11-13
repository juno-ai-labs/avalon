import { useCrashReporting } from './src/crashes';
import { RecoveryBoundary } from './src/RecoveryBoundary';
import { DiagnosticsScreen } from './src/DiagnosticsScreen';
import { registerBackgroundSync } from './src/background';
import { useNotifications } from './src/notifications';
import { notificationTarget } from './src/notification-target';
import { shareDiagnostics } from './src/diagnostics';
import * as Notifications from 'expo-notifications';
import { useNetworkState } from 'expo-network';
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, AppState, Linking, Keyboard, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, View, type KeyboardEvent, type ImageSourcePropType } from 'react-native';
import { NavigationContainer, StackActions, createNavigationContainerRef, DefaultTheme, DarkTheme, useIsFocused, type ParamListBase } from '@react-navigation/native';
import { createNativeBottomTabNavigator, type NativeBottomTabScreenProps } from '@bottom-tabs/react-navigation';
import { createNativeStackNavigator, type NativeStackScreenProps } from '@react-navigation/native-stack';
import { useHeaderHeight } from '@react-navigation/elements';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { SafeAreaView } from 'react-native-screens/experimental';
import { Menu, MessageCircle, X } from 'lucide-react-native';
import { StatusBar, useVerticalBarEdgeIOS } from 'expo-status-bar';
import { useBottomTabBarHeight } from 'react-native-bottom-tabs';
import { systemSignIn } from './src/auth';
import { CanvasWebView, ArtifactView, type CanvasWebViewHandle } from './src/CanvasWebView';
import { NativeTabIcon } from './src/NativeTabIcon';
import { allocatePinSlots } from './src/pin-routes';
import { Sidebar } from './src/Sidebar';
import { mobileUrl, trustedArtifact, VISIBLE_PIN_COUNT, type CanvasSummary, type NativeArtifact, type MobileCommand, type MobileEvent, type MobileSnapshot } from './src/protocol';
import { useTheme } from './src/theme';

const APP_URL = process.env.EXPO_PUBLIC_RALLY_APP_URL || 'https://app.rallywith.ai';
const ARTIFACT_DOMAIN = process.env.EXPO_PUBLIC_RALLY_ARTIFACT_DOMAIN || 'rallyusercontent.com';
const START_URL = mobileUrl(APP_URL);
const Tabs = createNativeBottomTabNavigator();
type RootRoutes = { Canvases: { screen: 'Home' } | undefined; Diagnostics: undefined; Conversation: { id: string; workspacePath: string; title: string } };
const Stack = createNativeStackNavigator<RootRoutes>();
const rootNavigation = createNavigationContainerRef<RootRoutes>();

type Session = {
  directory: MobileSnapshot | null;
  updateDirectory: (snapshot: MobileSnapshot | null) => void;
  controls: React.RefObject<Map<string, CanvasWebViewHandle>>;
  signIn: (web: CanvasWebViewHandle | null) => Promise<void>;
  signOut: () => void;
  authEpoch: number;
  notifications: ReturnType<typeof useNotifications>;
  receiveCrashEvent: (event: MobileEvent) => void;
  notificationOpened: (url: string) => void;
};
const SessionContext = createContext<Session | null>(null);
const CanvasRoutesContext = createContext<Record<string, string | null>>({});
function useSession() {
  const session = useContext(SessionContext);
  if (!session) throw new Error('Canvas session provider is missing');
  return session;
}

export default function App() { return <RecoveryBoundary><AppContent /></RecoveryBoundary>; }

function AppContent() {
  const { colors, isDark } = useTheme();
  const [directory, updateDirectory] = useState<MobileSnapshot | null>(null);
  const controls = useRef(new Map<string, CanvasWebViewHandle>());
  const [pendingNotification, setPendingNotification] = useState<string | null>(null);
  const pendingNotificationRef = useRef(pendingNotification);
  pendingNotificationRef.current = pendingNotification;
  const sendHome = useCallback((command: MobileCommand) => controls.current.get('Home')?.send(command), []);
  const openNotification = useCallback((data: unknown) => {
    const target = notificationTarget(data, APP_URL);
    if (!target) { void Notifications.clearLastNotificationResponseAsync().catch(() => undefined); return; }
    if (target.external) { void Linking.openURL(target.url).catch(() => Alert.alert('Unable to open notification', 'Try opening Rally in your browser.')); void Notifications.clearLastNotificationResponseAsync().catch(() => undefined); }
    else setPendingNotification(target.url);
  }, []);
  const notificationOpened = useCallback((url: string) => {
    if (pendingNotificationRef.current !== url) return;
    setPendingNotification(null);
    void Notifications.clearLastNotificationResponseAsync().catch(() => undefined);
  }, []);
  const notifications = useNotifications(directory, sendHome, openNotification);
  const receiveCrashEvent = useCrashReporting(directory, sendHome);
  useEffect(() => { void registerBackgroundSync(); }, []);
  useEffect(() => {
    if (!pendingNotification || !directory || !rootNavigation.isReady()) return;
    rootNavigation.dispatch(StackActions.popTo('Canvases', { screen: 'Home' }));
    sendHome({ type: 'open-notification', url: pendingNotification });
  }, [Boolean(directory), pendingNotification, sendHome]);
  const signingIn = useRef(false);
  const [authEpoch, setAuthEpoch] = useState(0);
  const signIn = useCallback(async (web: CanvasWebViewHandle | null) => {
    if (signingIn.current) return;
    signingIn.current = true;
    receiveCrashEvent({ type: 'signed-out' });
    try {
      const proof = await systemSignIn(APP_URL);
      if (proof) web?.send({ type: 'sign-in-complete', proof });
    } catch { Alert.alert('Sign-in couldn’t finish', 'Please try again.'); }
    finally { signingIn.current = false; setAuthEpoch((value) => value + 1); }
  }, [receiveCrashEvent]);
  const signOut = useCallback(() => {
    updateDirectory(null);
    controls.current.get('Home')?.reload();
  }, []);
  const theme = isDark ? DarkTheme : DefaultTheme;
  return <SafeAreaProvider>
    <StatusBar style={isDark ? 'light' : 'dark'} />
    <SessionContext value={{ directory, updateDirectory, controls, signIn, signOut, authEpoch, notifications, notificationOpened, receiveCrashEvent }}>
      <NavigationContainer ref={rootNavigation} theme={{ ...theme, colors: { ...theme.colors, background: colors.background, card: colors.surface, text: colors.text, primary: colors.accent, border: colors.line } }}>
        <Stack.Navigator initialRouteName="Canvases">
          <Stack.Screen name="Diagnostics" options={{ title: 'Settings and diagnostics' }}>{() => <DiagnosticsScreen notifications={notifications} signedIn={Boolean(directory)} />}</Stack.Screen>
          <Stack.Screen name="Canvases" component={CanvasTabs} options={{ headerTitle: '', headerTransparent: true, headerShadowVisible: false, headerTintColor: colors.text }} />
          <Stack.Screen name="Conversation" component={Conversation} options={{ presentation: Platform.OS === 'ios' ? 'formSheet' : 'card', title: 'Conversation', sheetGrabberVisible: true }} />
        </Stack.Navigator>
      </NavigationContainer>
    </SessionContext>
  </SafeAreaProvider>;
}

function CanvasTabs() {
  const { directory, controls } = useSession();
  const [images, setImages] = useState<Record<string, ImageSourcePropType>>({});
  const saveImage = useCallback((id: string, image: ImageSourcePropType) => setImages((current) => ({ ...current, [id]: image })), []);
  const { colors } = useTheme();
  const scope = directory ? `${directory.userId}:${directory.workspaceId}` : '';
  const pins = directory?.pins.slice(0, VISIBLE_PIN_COUNT) ?? [];
  const [allocation, setAllocation] = useState<{ scope: string; slots: (string | null)[] }>({ scope: '', slots: [] });
  const slots = allocatePinSlots(allocation.scope === scope ? allocation.slots : [], pins, VISIBLE_PIN_COUNT);
  if (Platform.OS === 'android' && (allocation.scope !== scope || slots.some((id, index) => id !== allocation.slots[index]))) {
    setAllocation({ scope, slots });
  }
  // Android's native destinations stay mounted. Only their canvas content and
  // documented tabBarItemHidden option change when pins are inserted/removed.
  const routes = Platform.OS === 'android'
    ? [...pins.map((id) => ({ name: `pin-${slots.indexOf(id) + 1}`, id })), ...slots.flatMap((id, index) => id ? [] : [{ name: `pin-${index + 1}`, id: null }])]
    : pins.map((id) => ({ name: id, id }));
  const routeCanvases = Object.fromEntries([['Home', 'Home'], ...routes.map(({ name, id }) => [name, id])]);
  const tabs = ['Home', ...pins];
  return <View style={styles.fill}>
    {tabs.map((id) => <TabIconAsset key={id} id={id} canvas={directory?.canvases.find((canvas) => canvas.id === id)} save={saveImage} />)}
    <CanvasRoutesContext value={routeCanvases}><Tabs.Navigator backBehavior="firstRoute" labeled={false} tabBarHidden={!directory}
      activeIndicatorColor={colors.selected}
      tabBarStyle={Platform.OS === 'android' ? { backgroundColor: colors.surface } : undefined}
      screenOptions={({ route }) => {
        const id = routeCanvases[route.name];
        const image = id ? images[id] : undefined;
        return { lazy: true, tabBarIcon: image ? () => image : undefined, tabBarIconRenderingMode: 'original' };
      }}>
    <Tabs.Screen name="Home" component={CanvasScreen} options={{ title: 'Home' }} listeners={{ tabPress: () => controls.current.get('Home')?.send({ type: 'home' }) }} />
    {routes.map(({ name, id }) => <Tabs.Screen
      key={Platform.OS === 'android' ? name : `${scope}:${id}`} name={name}
      navigationKey={Platform.OS === 'android' ? undefined : scope}
      component={Platform.OS === 'android' ? AndroidCanvasRoute : CanvasScreen}
      options={{ title: id ? directory?.canvases.find((canvas) => canvas.id === id)?.title || 'Canvas' : '', tabBarItemHidden: !id }}
    />)}
  </Tabs.Navigator></CanvasRoutesContext></View>;
}

function AndroidCanvasRoute(props: NativeBottomTabScreenProps<ParamListBase>) {
  const canvasId = useContext(CanvasRoutesContext)[props.route.name];
  const focused = useIsFocused();
  const previousCanvas = useRef(canvasId);
  useEffect(() => {
    if (focused && (!canvasId || previousCanvas.current !== canvasId)) props.navigation.navigate('Home');
    previousCanvas.current = canvasId;
  }, [canvasId, focused, props.navigation]);
  return canvasId ? <CanvasScreen key={canvasId} {...props} canvasId={canvasId} /> : null;
}

function TabIconAsset({ id, canvas, save }: { id: string; canvas?: CanvasSummary; save: (id: string, image: ImageSourcePropType) => void }) {
  const onImage = useCallback((image: ImageSourcePropType) => save(id, image), [id, save]);
  return <NativeTabIcon canvas={canvas} onImage={onImage} />;
}
function useKeyboardVisible() {
  const { authEpoch } = useSession();
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    setVisible(false);
    const show = (event: KeyboardEvent) => setVisible(event.endCoordinates.height > 0);
    const listeners = [Keyboard.addListener('keyboardWillShow', show), Keyboard.addListener('keyboardDidShow', show), Keyboard.addListener('keyboardDidHide', () => setVisible(false))];
    return () => listeners.forEach((listener) => listener.remove());
  }, [authEpoch]);
  return visible;
}

function HeaderButton({ kind, label, onPress }: { kind: 'menu' | 'chat' | 'close'; label: string; onPress: () => void }) {
  const { colors } = useTheme();
  const Icon = kind === 'menu' ? Menu : kind === 'chat' ? MessageCircle : X;
  return <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} style={({ pressed }) => ({ padding: 10, opacity: pressed ? 0.5 : 1 })}><Icon size={24} color={colors.text} /></Pressable>;
}

function CanvasScreen({ route, navigation, canvasId: assignedCanvasId }: NativeBottomTabScreenProps<ParamListBase> & { canvasId?: string }) {
  const { directory, updateDirectory, controls, signIn, signOut, notifications, notificationOpened, receiveCrashEvent } = useSession();
  const { colors } = useTheme();
  const canvasId = assignedCanvasId ?? route.name;
  const routeCanvases = useContext(CanvasRoutesContext);
  const tabs = navigation;
  const home = canvasId === 'Home';
  const focused = useIsFocused();
  const network = useNetworkState();
  const headerHeight = useHeaderHeight();
  const tabBarHeight = useBottomTabBarHeight();
  const verticalBarEdge = useVerticalBarEdgeIOS();
  // Callstack tab scenes extend behind the iPhone bar. Reserve its measured
  // height, including the home indicator, once. Duo rails use native side insets.
  const bottomTabInset = Platform.OS === 'ios' && !Platform.isPad && !Platform.isTV
    && verticalBarEdge === null && directory ? tabBarHeight : 0;
  const web = useRef<CanvasWebViewHandle>(null);
  const [url] = useState(() => {
    if (home || !directory) return START_URL;
    const initial = new URL(mobileUrl(APP_URL, directory.workspacePath));
    initial.hash = `/canvases/${encodeURIComponent(canvasId)}?tab=1`;
    return initial.href;
  });
  const [snapshot, setSnapshot] = useState<MobileSnapshot | null>(null);
  const [artifacts, setArtifacts] = useState<Record<string, NativeArtifact>>({});
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [sidebar, setSidebar] = useState(false);
  const keyboardVisible = useKeyboardVisible();
  const scope = useRef<string | null>(null);
  const open = useCallback((id: string) => {
    if (directory?.pins.slice(0, VISIBLE_PIN_COUNT).includes(id)) {
      const destination = Object.keys(routeCanvases).find((name) => routeCanvases[name] === id);
      if (destination) tabs.navigate(destination);
    }
    else {
      tabs?.navigate('Home');
      controls.current.get('Home')?.send({ type: 'open', id, pinned: false });
    }
  }, [controls, directory?.pins, routeCanvases, tabs]);
  const send = useCallback((command: MobileCommand) => {
    if (command.type === 'open') { open(command.id); return; }
    if (command.type === 'pin' || command.type === 'reorder' || command.type === 'refresh' || command.type === 'load-more') {
      // Android can pause rendering in an inactive tab's WebView. Keep pin
      // acknowledgments on the visible page so the directory updates promptly.
      web.current?.send(command);
      return;
    }
    if (command.type === 'sign-out' || command.type === 'switch-workspace') receiveCrashEvent({ type: 'signed-out' });
    if (command.type === 'home' || command.type === 'create' || command.type === 'switch-workspace' || command.type === 'sign-out') tabs?.navigate('Home');
    controls.current.get('Home')?.send(command);
  }, [controls, tabs, open, receiveCrashEvent]);
  const receive = useCallback((event: MobileEvent) => {
    if (event.type === 'notification-opened') { notificationOpened(event.url); return; }
    notifications.receive(event);
    if (home) receiveCrashEvent(event);
    if (event.type === 'sign-in') {
      if (home) void signIn(web.current);
      else { tabs?.navigate('Home'); signOut(); }
      return;
    }
    setReady(true); setFailed(false);
    if (event.type === 'open-canvas') {
      if (event.id === canvasId) web.current?.send({ type: 'open', id: event.id, pinned: true });
      else open(event.id);
    }
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
      // A newly visited tab has no directory until its socket's first sync.
      // That loading snapshot must not remove the existing native routes.
      if (focused && !event.snapshot.loading) updateDirectory(event.snapshot);
    }
    if (event.type === 'signed-out') {
      setArtifacts({}); setSnapshot(null); setSidebar(false);
      if (home) updateDirectory(null); else signOut();
    }
  }, [focused, home, tabs, open, canvasId, signIn, signOut, updateDirectory, notifications.receive, notificationOpened, receiveCrashEvent]);
  useEffect(() => {
    const registry = controls.current;
    const handle = web.current;
    if (handle) registry.set(canvasId, handle);
    return () => { if (registry.get(canvasId) === handle) registry.delete(canvasId); };
  }, [controls, canvasId]);
  useEffect(() => {
    if (focused && ready && network.isConnected) web.current?.send({ type: 'refresh' });
    const listener = AppState.addEventListener('change', (state) => { if (state === 'active' && focused && ready) web.current?.send({ type: 'refresh' }); });
    return () => listener.remove();
  }, [focused, ready, network.isConnected]);
  useEffect(() => {
    if (!focused) return;
    const chat = snapshot?.view === 'artifact' && snapshot.canvasId ? () => tabs.getParent()?.navigate('Conversation', { id: snapshot.canvasId, workspacePath: snapshot.workspacePath, title: snapshot.title }) : undefined;
    const menu = () => setSidebar(true);
    navigation.getParent()?.setOptions({
      headerLeft: directory ? () => <HeaderButton kind="menu" label="Open sidebar" onPress={menu} /> : undefined,
      headerRight: chat ? () => <HeaderButton kind="chat" label="Open conversation" onPress={chat} /> : undefined,
      unstable_headerLeftItems: () => directory ? [{ type: 'button', label: 'Open sidebar', icon: { type: 'sfSymbol', name: 'sidebar.left' }, onPress: menu }] : [],
      unstable_headerRightItems: () => chat ? [{ type: 'button', label: 'Open conversation', icon: { type: 'sfSymbol', name: 'bubble.left' }, onPress: chat }] : [],
    });
  }, [directory, focused, navigation, snapshot, tabs]);
  const hosted = snapshot?.view === 'artifact' && artifacts[snapshot.canvasId ?? '']?.resourceId === snapshot.artifactId;
  // Native safe areas follow the system rail (including its side in Split View).
  // Content extends behind the transparent header; the initial inset scrolls away.
  return <SafeAreaView edges={{ left: true, right: true, bottom: bottomTabInset === 0 }} style={{ backgroundColor: colors.background }}>
    <KeyboardAvoidingView enabled={keyboardVisible} style={[styles.fill, { marginBottom: bottomTabInset }]} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View collapsable={false} style={styles.fill} accessibilityElementsHidden={hosted || !focused} importantForAccessibility={hosted || !focused ? 'no-hide-descendants' : 'auto'}>
        <CanvasWebView ref={web} url={url} appUrl={APP_URL} background={colors.background} topInset={headerHeight + 12} onEvent={receive}
          onLoading={() => {
            // Loading Home must not close other tabs and discard their drafts.
            // Authentication snapshots and signed-out events own the directory.
            setReady(false); setFailed(false); setSnapshot(null); setSidebar(false);
          }} onError={() => setFailed(true)} />
      </View>
      {Object.values(artifacts).map((access) => {
        const visible = snapshot?.view === 'artifact' && snapshot.canvasId === access.canvasId && snapshot.artifactId === access.resourceId;
        return <View key={access.canvasId} collapsable={false} accessibilityElementsHidden={!visible || !focused} importantForAccessibility={visible && focused ? 'auto' : 'no-hide-descendants'} pointerEvents={visible ? 'auto' : 'none'} style={[StyleSheet.absoluteFill, { top: snapshot?.artifactPicker ? headerHeight + 60 : 0, opacity: visible ? 1 : 0 }]}>
          <ArtifactView topInset={snapshot?.artifactPicker ? 0 : headerHeight + 12} access={access} background={colors.background} onRetry={() => web.current?.send({ type: 'reopen-artifact', canvasId: access.canvasId, resourceId: access.resourceId })} />
        </View>;
      })}
      {(!ready || failed) && <Loading failed={failed} retry={() => { setFailed(false); web.current?.reload(); }} />}
    </KeyboardAvoidingView>
    {directory && <Sidebar visible={sidebar} snapshot={{ ...directory, ...snapshot, ...{ canvases: directory.canvases, pins: directory.pins, pinBusy: directory.pinBusy, pinError: directory.pinError }, tabId: home ? null : canvasId }} close={() => setSidebar(false)} send={send} diagnostics={() => rootNavigation.navigate('Diagnostics')} />}
  </SafeAreaView>;
}

function Conversation({ route, navigation }: NativeStackScreenProps<RootRoutes, 'Conversation'>) {
  const { colors } = useTheme();
  const { controls, signOut } = useSession();
  const web = useRef<CanvasWebViewHandle>(null);
  const [loading, setLoading] = useState(true);
  const keyboardVisible = useKeyboardVisible();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const close = () => navigation.goBack();
    navigation.setOptions({
      headerRight: Platform.OS === 'ios' ? () => <HeaderButton kind="close" label="Close conversation" onPress={close} /> : undefined,
      unstable_headerRightItems: () => [{ type: 'button', label: 'Close conversation', icon: { type: 'sfSymbol', name: 'xmark' }, onPress: close }],
    });
    return () => { for (const control of controls.current.values()) control.send({ type: 'refresh' }); };
  }, [controls, navigation]);
  return <SafeAreaView edges={{ left: true, right: true, bottom: true }} style={{ backgroundColor: colors.background }}>
    <KeyboardAvoidingView enabled={keyboardVisible} style={styles.fill} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View collapsable={false} style={styles.fill}>
        <CanvasWebView ref={web} url={mobileUrl(APP_URL, route.params.workspacePath, route.params.id)} appUrl={APP_URL} background={colors.background}
          onLoading={() => { setLoading(true); setFailed(false); }} onError={() => { setLoading(false); setFailed(true); }}
          onEvent={(event) => { setLoading(false); if (event.type === 'signed-out') { navigation.goBack(); signOut(); } if (event.type === 'open-canvas') { navigation.goBack(); (controls.current.get(event.id) ?? controls.current.get('Home'))?.send({ type: 'open', id: event.id, pinned: controls.current.has(event.id) }); } }} />
      </View>
      {(loading || failed) && <Loading failed={failed} retry={() => web.current?.reload()} />}
    </KeyboardAvoidingView>
  </SafeAreaView>;
}
function Loading({ failed, retry }: { failed: boolean; retry: () => void }) {
  const { colors } = useTheme();
  return <View style={[StyleSheet.absoluteFill, styles.loading, { backgroundColor: colors.background }]}>
    {failed ? <><Text style={{ color: colors.text }}>Rally couldn’t load. Check your connection.</Text><Pressable accessibilityRole="button" onPress={retry} style={{ padding: 20 }}><Text style={{ color: colors.text }}>Try again</Text></Pressable><Pressable accessibilityRole="button" onPress={() => { void shareDiagnostics().catch(() => undefined); }} style={{ padding: 16 }}><Text style={{ color: colors.text }}>Share diagnostics</Text></Pressable></> : <ActivityIndicator accessibilityLabel="Opening Rally" color={colors.accent} />}
  </View>;
}
const styles = StyleSheet.create({ fill: { flex: 1 }, loading: { alignItems: 'center', justifyContent: 'center', padding: 24 } });
