import { usePreparedSiteAccess } from './src/prepared-site-access';
import { useAppResume } from './src/use-app-resume';
import { usePreparedCanvases } from './src/prepared-canvases';
import { directoryKey } from './src/directory';
import { loadSavedDirectory, saveDirectory } from './src/saved-directory';
import { HOME_RENDERER, recovery } from './src/recovery-order';
import { useCrashReporting } from './src/crashes';
import { RecoveryBoundary } from './src/RecoveryBoundary';
import { DiagnosticsScreen } from './src/DiagnosticsScreen';
import { registerBackgroundSync } from './src/background';
import { useNotifications } from './src/notifications';
import { notificationTarget } from './src/notification-target';
import { recordTiming, shareDiagnostics } from './src/diagnostics';
import * as Notifications from 'expo-notifications';
import { useNetworkState } from 'expo-network';
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, BackHandler, Linking, Keyboard, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, View, type KeyboardEvent, type ImageSourcePropType } from 'react-native';
import { NavigationContainer, StackActions, createNavigationContainerRef, DefaultTheme, DarkTheme, useIsFocused, type ParamListBase } from '@react-navigation/native';
import { createNativeBottomTabNavigator, type NativeBottomTabScreenProps } from '@bottom-tabs/react-navigation';
import { createNativeStackNavigator, type NativeStackScreenProps } from '@react-navigation/native-stack';
import { useHeaderHeight } from '@react-navigation/elements';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { SafeAreaView } from 'react-native-screens/experimental';
import { Menu, MessageCircle, Plus, X } from 'lucide-react-native';
import { StatusBar, useVerticalBarEdgeIOS } from 'expo-status-bar';
import { useBottomTabBarHeight } from 'react-native-bottom-tabs';
import { systemSignIn } from './src/auth';
import { CanvasWebView, ArtifactView, ArtifactSessionPreparation, type CanvasWebViewHandle } from './src/CanvasWebView';
import { NativeTabIcon } from './src/NativeTabIcon';
import { allocatePinSlots } from './src/pin-routes';
import { Sidebar } from './src/Sidebar';
import { mobileContentReady, mobileUrl, trustedArtifact, VISIBLE_PIN_COUNT, type CanvasSummary, type NativeArtifact, type MobileCommand, type MobileEvent, type MobileSnapshot, type PreparedCanvas } from './src/protocol';
import { useTheme } from './src/theme';

const APP_URL = process.env.EXPO_PUBLIC_RALLY_APP_URL || 'https://app.rallywith.ai';
const ARTIFACT_DOMAIN = process.env.EXPO_PUBLIC_RALLY_ARTIFACT_DOMAIN || 'rallyusercontent.com';
const START_URL = mobileUrl(APP_URL);
// Opening Home at the last organization skips the session and organization-list
// reads before it can draw. `HOME_FALLBACK` recovers if that access is gone.
const SAVED_DIRECTORY = loadSavedDirectory();
const JS_STARTED = performance.now();
let dashboardTimed = false;
const HOME_URL = SAVED_DIRECTORY ? mobileUrl(APP_URL, SAVED_DIRECTORY.workspacePath) : START_URL;
const Tabs = createNativeBottomTabNavigator();
type RootRoutes = { Canvases: { screen: 'Home' } | undefined; Diagnostics: undefined; Conversation: { id: string; workspacePath: string; title: string } };
const Stack = createNativeStackNavigator<RootRoutes>();
const rootNavigation = createNavigationContainerRef<RootRoutes>();

type ChatReturn = { scope: string; tab: string };
type Session = {
  chatReturn: ChatReturn | null;
  setChatReturn: (value: ChatReturn | null) => void;
  prepared: ReturnType<typeof usePreparedCanvases>;
  directory: MobileSnapshot | null;
  updateDirectory: (snapshot: MobileSnapshot | null) => void;
  controls: React.RefObject<Map<string, CanvasWebViewHandle>>;
  directoryOwner: React.RefObject<string>;
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
  const [directory, setDirectory] = useState<MobileSnapshot | null>(null);
  const shownDirectory = useRef('');
  const updateDirectory = useCallback((next: MobileSnapshot | null) => {
    const key = directoryKey(next);
    if (key === shownDirectory.current) return;
    shownDirectory.current = key;
    setDirectory(next);
    saveDirectory(next);
  }, []);
  const controls = useRef(new Map<string, CanvasWebViewHandle>());
  const directoryOwner = useRef('Home');
  const [chatReturn, setChatReturn] = useState<ChatReturn | null>(null);
  const accountScope = directory ? `${directory.userId}:${directory.workspaceId}` : '';
  useEffect(() => { if (chatReturn && chatReturn.scope !== accountScope) setChatReturn(null); }, [accountScope, chatReturn]);
  const [pendingNotification, setPendingNotification] = useState<string | null>(null);
  const pendingNotificationRef = useRef(pendingNotification);
  pendingNotificationRef.current = pendingNotification;
  const sendHome = useCallback((command: MobileCommand) => controls.current.get('Home')?.send(command), []);
  // A queued access request needs Home now, even while it waits behind the screen in front.
  const wakeHome = useCallback(() => recovery.wake(HOME_RENDERER), []);
  const prepared = usePreparedCanvases(directory, sendHome, wakeHome);
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
  // Home feeds every tab, so it refreshes on resume whichever screen is in front.
  useAppResume(() => sendHome({ type: 'refresh' }));
  useEffect(() => {
    if (!pendingNotification || !directory || !rootNavigation.isReady()) return;
    setChatReturn(null);
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
    setChatReturn(null); updateDirectory(null);
    controls.current.get('Home')?.reload();
  }, []);
  const session = useMemo(() => ({ directoryOwner, chatReturn, setChatReturn, prepared, directory, updateDirectory, controls, signIn, signOut, authEpoch, notifications, notificationOpened, receiveCrashEvent }),
    [chatReturn, prepared, directory, updateDirectory, signIn, signOut, authEpoch, notifications, notificationOpened, receiveCrashEvent]);
  const theme = isDark ? DarkTheme : DefaultTheme;
  return <SafeAreaProvider>
    <StatusBar style={isDark ? 'light' : 'dark'} />
    <SessionContext value={session}>
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
  const { directory, controls, prepared, chatReturn } = useSession();
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
    {Object.values(prepared.canvases).map((canvas) => <PrepareArtifactSession key={`${scope}:${canvas.canvasId}:${canvas.resourceId}`} canvas={canvas} scope={scope} />)}
    {tabs.map((id) => <TabIconAsset key={id} id={id} canvas={directory?.canvases.find((canvas) => canvas.id === id)} save={saveImage} />)}
    <CanvasRoutesContext value={routeCanvases}><Tabs.Navigator backBehavior="firstRoute" labeled={false} tabBarHidden={!directory || Boolean(chatReturn)}
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
      component={Platform.OS === 'android' ? AndroidCanvasRoute : PinnedCanvasRoute}
      options={{ title: id ? directory?.canvases.find((canvas) => canvas.id === id)?.title || 'Canvas' : '', tabBarItemHidden: !id }}
    />)}
  </Tabs.Navigator></CanvasRoutesContext></View>;
}

function PrepareArtifactSession({ canvas, scope }: { canvas: PreparedCanvas; scope: string }) {
  const { prepared } = useSession();
  const [access, setAccess] = useState<NativeArtifact | null>(null);
  useEffect(() => {
    let active = true;
    void prepared.open(canvas).then((artifact) => {
      if (active && artifact && trustedArtifact(artifact, ARTIFACT_DOMAIN)) setAccess(artifact);
    });
    return () => { active = false; };
  }, [canvas.canvasId, canvas.resourceId, prepared.open]);
  return access ? <ArtifactSessionPreparation access={access} onReady={() => prepared.rememberSession(scope, access)} /> : null;
}

function AndroidCanvasRoute(props: NativeBottomTabScreenProps<ParamListBase>) {
  const canvasId = useContext(CanvasRoutesContext)[props.route.name];
  const focused = useIsFocused();
  const previousCanvas = useRef(canvasId);
  useEffect(() => {
    if (focused && (!canvasId || previousCanvas.current !== canvasId)) props.navigation.navigate('Home');
    previousCanvas.current = canvasId;
  }, [canvasId, focused, props.navigation]);
  return canvasId ? <PinnedCanvasRoute key={canvasId} {...props} canvasId={canvasId} /> : null;
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

function HeaderButton({ kind, label, onPress }: { kind: 'menu' | 'chat' | 'create' | 'close'; label: string; onPress: () => void }) {
  const { colors } = useTheme();
  const Icon = kind === 'menu' ? Menu : kind === 'chat' ? MessageCircle : kind === 'create' ? Plus : X;
  return <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} style={({ pressed }) => ({ padding: 10, opacity: pressed ? 0.5 : 1 })}><Icon size={24} color={colors.text} /></Pressable>;
}

function useChatNavigation(navigation: NativeBottomTabScreenProps<ParamListBase>['navigation'], returnTab: string) {
  const { controls, directory, chatReturn, setChatReturn } = useSession();
  const openChat = useCallback((id: string, title: string) => {
    if (!directory) return;
    if (!directory.inlineChat) {
      navigation.getParent()?.navigate('Conversation', { id, title, workspacePath: directory.workspacePath });
      return;
    }
    setChatReturn({ scope: `${directory.userId}:${directory.workspaceId}`, tab: returnTab });
    controls.current.get('Home')?.send({ type: 'open-chat', id });
    navigation.navigate('Home');
  }, [controls, directory, navigation, returnTab, setChatReturn]);
  const closeChat = useCallback(() => {
    Keyboard.dismiss();
    controls.current.get('Home')?.send({ type: 'close-chat' });
    const destination = chatReturn?.tab;
    setChatReturn(null);
    navigation.navigate(destination && navigation.getState().routeNames.includes(destination) ? destination : 'Home');
  }, [chatReturn, controls, navigation, setChatReturn]);
  return { openChat, closeChat, chatReturn };
}

function CanvasScreen({ route, navigation, canvasId: assignedCanvasId, onContentReady }: NativeBottomTabScreenProps<ParamListBase> & { canvasId?: string; onContentReady?: () => void }) {
  const { directory, updateDirectory, controls, signIn, signOut, notifications, notificationOpened, receiveCrashEvent, prepared, setChatReturn, directoryOwner } = useSession();
  const { colors } = useTheme();
  const canvasId = assignedCanvasId ?? route.name;
  const routeCanvases = useContext(CanvasRoutesContext);
  const tabs = navigation;
  const { openChat, closeChat, chatReturn } = useChatNavigation(navigation, route.name);
  const home = canvasId === 'Home';
  const focused = useIsFocused();
  useLayoutEffect(() => { if (focused) directoryOwner.current = canvasId; }, [focused, canvasId, directoryOwner]);
  const network = useNetworkState();
  const headerHeight = useHeaderHeight();
  const tabBarHeight = useBottomTabBarHeight();
  const verticalBarEdge = useVerticalBarEdgeIOS();
  // Callstack tab scenes extend behind the iPhone bar. Reserve its measured
  // height, including the home indicator, once. Duo rails use native side insets.
  const bottomTabInset = Platform.OS === 'ios' && !Platform.isPad && !Platform.isTV
    && verticalBarEdge === null && directory && !chatReturn ? tabBarHeight : 0;
  const web = useRef<CanvasWebViewHandle>(null);
  const [url, setUrl] = useState(() => {
    if (home) return HOME_URL;
    if (!directory) return START_URL;
    const initial = new URL(mobileUrl(APP_URL, directory.workspacePath));
    initial.hash = `/canvases/${encodeURIComponent(canvasId)}?tab=1`;
    return initial.href;
  });
  const [snapshot, setSnapshot] = useState<MobileSnapshot | null>(null);
  const [artifacts, setArtifacts] = useState<Record<string, NativeArtifact>>({});
  const [ready, setReady] = useState(false);
  const [contentReady, setContentReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [sidebar, setSidebar] = useState(false);
  const keyboardVisible = useKeyboardVisible();
  const scope = useRef<string | null>(null);
  const snapshotSeen = useRef(false);
  const open = useCallback((id: string) => {
    if (chatReturn) closeChat();
    if (directory?.pins.slice(0, VISIBLE_PIN_COUNT).includes(id)) {
      const destination = Object.keys(routeCanvases).find((name) => routeCanvases[name] === id);
      if (destination) tabs.navigate(destination);
    }
    else {
      tabs?.navigate('Home');
      controls.current.get('Home')?.send({ type: 'open', id, pinned: false });
    }
  }, [controls, directory?.pins, routeCanvases, tabs, chatReturn, closeChat]);
  const send = useCallback((command: MobileCommand) => {
    if (command.type === 'open') { open(command.id); return; }
    if (command.type === 'pin' || command.type === 'reorder' || command.type === 'refresh' || command.type === 'load-more') {
      // Android can pause rendering in an inactive tab's WebView. Keep pin
      // acknowledgments on the visible page so the directory updates promptly.
      web.current?.send(command);
      return;
    }
    if (command.type === 'sign-out' || command.type === 'switch-workspace') receiveCrashEvent({ type: 'signed-out' });
    if (command.type === 'home' || command.type === 'create' || command.type === 'switch-workspace' || command.type === 'sign-out') { if (chatReturn) closeChat(); tabs?.navigate('Home'); }
    controls.current.get('Home')?.send(command);
  }, [controls, tabs, open, receiveCrashEvent, chatReturn, closeChat]);
  const receive = useCallback((event: MobileEvent) => {
    if (home && prepared.receive(event)) return;
    if (event.type === 'notification-opened') { notificationOpened(event.url); return; }
    notifications.receive(event);
    if (home) receiveCrashEvent(event);
    if (event.type === 'sign-in') {
      // Opened at a saved organization the account may no longer reach: the
      // page reads that as signed out. Retry once from the plain start first.
      if (home && url !== START_URL && !snapshotSeen.current) { saveDirectory(null); setUrl(START_URL); return; }
      if (home) void signIn(web.current);
      else { tabs?.navigate('Home'); signOut(); }
      return;
    }
    setReady(true); setFailed(false);
    if (mobileContentReady(event)) {
      setContentReady(true);
      if (home && !dashboardTimed) { dashboardTimed = true; recordTiming('launch_to_dashboard', performance.now() - JS_STARTED); }
    }
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
      snapshotSeen.current = true;
      const nextScope = `${event.snapshot.userId}:${event.snapshot.workspaceId}`;
      if (scope.current !== nextScope) { scope.current = nextScope; setArtifacts({}); }
      setSnapshot(event.snapshot);
      if (!event.snapshot.loading && (event.snapshot.view === 'conversation' || event.snapshot.artifactId)) onContentReady?.();
      // A newly visited tab has no directory until its socket's first sync.
      // That loading snapshot must not remove the existing native routes.
      if (directoryOwner.current === canvasId && !event.snapshot.loading) updateDirectory(event.snapshot);
    }
    if (event.type === 'signed-out') {
      setArtifacts({}); setSnapshot(null); setSidebar(false);
      if (home) updateDirectory(null); else signOut();
    }
  }, [directoryOwner, home, url, tabs, open, canvasId, signIn, signOut, updateDirectory, notifications.receive, notificationOpened, receiveCrashEvent, prepared.receive, onContentReady]);
  useEffect(() => {
    const registry = controls.current;
    const handle = web.current;
    if (handle) registry.set(canvasId, handle);
    return () => { if (registry.get(canvasId) === handle) registry.delete(canvasId); };
  }, [controls, canvasId]);
  const previousConnection = useRef(network.isConnected);
  useEffect(() => {
    const reconnected = previousConnection.current === false && network.isConnected;
    previousConnection.current = network.isConnected;
    if (focused && ready && reconnected) web.current?.send({ type: 'refresh' });
  }, [focused, ready, network.isConnected]);
  useEffect(() => {
    if (!home || !focused || !chatReturn) return;
    const back = BackHandler.addEventListener('hardwareBackPress', () => { closeChat(); return true; });
    return () => back.remove();
  }, [home, focused, chatReturn, closeChat]);
  // Home is refreshed once for the whole app on resume; other shells refresh themselves.
  useAppResume(() => { if (!home && focused && ready) web.current?.send({ type: 'refresh' }); });
  // Header items are native views: rebuild them only when what they show changes.
  const view = snapshot?.view;
  const viewCanvas = snapshot?.canvasId;
  const viewTitle = snapshot?.title ?? '';
  const signedIn = Boolean(directory);
  useEffect(() => {
    if (!focused) return;
    const chat = view === 'artifact' && viewCanvas ? () => openChat(viewCanvas, viewTitle) : undefined;
    const close = home && chatReturn ? closeChat : undefined;
    const menu = () => setSidebar(true);
    const create = view === 'home' ? () => web.current?.send({ type: 'create' }) : undefined;
    navigation.getParent()?.setOptions({
      headerLeft: signedIn ? () => <HeaderButton kind="menu" label="Open sidebar" onPress={menu} /> : undefined,
      headerRight: close ? () => <HeaderButton kind="close" label="Close conversation" onPress={close} /> : create ? () => <HeaderButton kind="create" label="Create a canvas" onPress={create} /> : chat ? () => <HeaderButton kind="chat" label="Open conversation" onPress={chat} /> : undefined,
      unstable_headerLeftItems: () => signedIn ? [{ type: 'button', label: 'Open sidebar', icon: { type: 'sfSymbol', name: 'sidebar.left' }, onPress: menu }] : [],
      unstable_headerRightItems: () => close ? [{ type: 'button', label: 'Close conversation', icon: { type: 'sfSymbol', name: 'xmark' }, onPress: close }] : create ? [{ type: 'button', label: 'Create a canvas', icon: { type: 'sfSymbol', name: 'plus' }, onPress: create }] : chat ? [{ type: 'button', label: 'Open conversation', icon: { type: 'sfSymbol', name: 'bubble.left' }, onPress: chat }] : [],
    });
  }, [signedIn, focused, navigation, view, viewCanvas, viewTitle, home, chatReturn, closeChat, openChat]);
  const hosted = snapshot?.view === 'artifact' && artifacts[snapshot.canvasId ?? '']?.resourceId === snapshot.artifactId;
  // Native safe areas follow the system rail (including its side in Split View).
  // Content extends behind the transparent header; the initial inset scrolls away.
  return <SafeAreaView edges={{ left: true, right: true, bottom: bottomTabInset === 0 }} style={{ backgroundColor: colors.background }}>
    <KeyboardAvoidingView enabled={keyboardVisible} style={[styles.fill, { marginBottom: bottomTabInset }]} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View collapsable={false} style={styles.fill} accessibilityElementsHidden={hosted || !focused} importantForAccessibility={hosted || !focused ? 'no-hide-descendants' : 'auto'}>
        <CanvasWebView ref={web} url={url} appUrl={APP_URL} background={colors.background} topInset={headerHeight + 12} onEvent={receive}
          focused={focused && !hosted} recoveryId={`web:${canvasId}`}
          onLoading={() => {
            // Loading Home must not close other tabs and discard their drafts.
            // Authentication snapshots and signed-out events own the directory.
            if (home) { prepared.reset(); setChatReturn(null); } setReady(false); setContentReady(false); setFailed(false); setSnapshot(null); setSidebar(false);
          }} onError={() => { if (home) prepared.fail(); setFailed(true); }} />
      </View>
      {Object.values(artifacts).map((access) => {
        const visible = snapshot?.view === 'artifact' && snapshot.canvasId === access.canvasId && snapshot.artifactId === access.resourceId;
        return <View key={access.canvasId} collapsable={false} accessibilityElementsHidden={!visible || !focused} importantForAccessibility={visible && focused ? 'auto' : 'no-hide-descendants'} pointerEvents={visible ? 'auto' : 'none'} style={[StyleSheet.absoluteFill, { top: snapshot?.artifactPicker ? headerHeight + 60 : 0, opacity: visible ? 1 : 0 }]}>
          <ArtifactView appUrl={APP_URL} topInset={snapshot?.artifactPicker ? 0 : headerHeight + 12} access={access} background={colors.background} focused={focused && visible} onRetry={() => web.current?.send({ type: 'reopen-artifact', canvasId: access.canvasId, resourceId: access.resourceId })} />
        </View>;
      })}
      {(!contentReady || failed) && <Loading failed={failed} retry={() => { setFailed(false); web.current?.reload(); }} />}
    </KeyboardAvoidingView>
    {directory && <Sidebar visible={sidebar} snapshot={{ ...directory, ...snapshot, ...{ canvases: directory.canvases, pins: directory.pins, pinBusy: directory.pinBusy, pinError: directory.pinError }, tabId: home ? null : canvasId }} close={() => setSidebar(false)} send={send} diagnostics={() => rootNavigation.navigate('Diagnostics')} />}
  </SafeAreaView>;
}

function PinnedCanvasRoute(props: NativeBottomTabScreenProps<ParamListBase> & { canvasId?: string }) {
  const { prepared } = useSession();
  const canvas = prepared.canvases[props.canvasId ?? props.route.name];
  // Late descriptors may replace the bootstrap spinner, but never a browser
  // artifact or conversation the person has already started using.
  const [browserShown, setBrowserShown] = useState(false);
  const keepBrowser = useCallback(() => setBrowserShown(true), []);
  return !browserShown && canvas ? <PreparedSiteScreen {...props} canvas={canvas} /> : <CanvasScreen {...props} onContentReady={keepBrowser} />;
}

/** A hosted pin uses Home's existing API/socket session and opens its actual URL.
 * Other artifact types retain the shared browser renderer. */
function PreparedSiteScreen({ canvas, navigation, route }: NativeBottomTabScreenProps<ParamListBase> & { canvas: PreparedCanvas }) {
  const { directory, controls, prepared, receiveCrashEvent, directoryOwner } = useSession();
  const { colors } = useTheme();
  const { openChat } = useChatNavigation(navigation, route.name);
  const focused = useIsFocused();
  useLayoutEffect(() => { if (focused) directoryOwner.current = 'Home'; }, [focused, directoryOwner]);
  const routeCanvases = useContext(CanvasRoutesContext);
  const network = useNetworkState();
  const keyboardVisible = useKeyboardVisible();
  const headerHeight = useHeaderHeight();
  const tabBarHeight = useBottomTabBarHeight();
  const verticalBarEdge = useVerticalBarEdgeIOS();
  const bottomTabInset = Platform.OS === 'ios' && !Platform.isPad && !Platform.isTV && verticalBarEdge === null ? tabBarHeight : 0;
  const [sidebar, setSidebar] = useState(false);
  const { access, failed, attempt, retry } = usePreparedSiteAccess(canvas, prepared.sessions, prepared.open, ARTIFACT_DOMAIN);
  // The tab mounts on its first tap, so first render approximates the tap.
  // A return to an already drawn tab is a native view switch and is not timed.
  const openedAt = useRef<number | null>(performance.now());
  const onPresented = useCallback(() => {
    if (openedAt.current === null) return;
    recordTiming('pin_tap_to_artifact', performance.now() - openedAt.current);
    openedAt.current = null;
  }, []);
  const send = (command: MobileCommand) => {
    if (command.type === 'open') {
      if (directory?.pins.slice(0, VISIBLE_PIN_COUNT).includes(command.id)) {
        const route = Object.keys(routeCanvases).find((name) => routeCanvases[name] === command.id);
        if (route) { navigation.navigate(route); return; }
      }
      navigation.navigate('Home');
    }
    if (command.type === 'sign-out' || command.type === 'switch-workspace') receiveCrashEvent({ type: 'signed-out' });
    if (['home', 'create', 'sign-out', 'switch-workspace'].includes(command.type)) navigation.navigate('Home');
    controls.current.get('Home')?.send(command);
  };
  const previousConnection = useRef(network.isConnected);
  useEffect(() => {
    // Home already keeps its socket live. A tab tap must not invalidate every
    // prepared Canvas alongside the access request.
    const reconnected = previousConnection.current === false && network.isConnected;
    previousConnection.current = network.isConnected;
    if (focused && reconnected) controls.current.get('Home')?.send({ type: 'refresh' });
  }, [focused, network.isConnected, controls]);
  useEffect(() => {
    if (!focused || !directory) return;
    const chat = () => openChat(canvas.canvasId, canvas.title);
    const menu = () => setSidebar(true);
    navigation.getParent()?.setOptions({
      headerLeft: () => <HeaderButton kind="menu" label="Open sidebar" onPress={menu} />,
      headerRight: () => <HeaderButton kind="chat" label="Open conversation" onPress={chat} />,
      unstable_headerLeftItems: () => [{ type: 'button', label: 'Open sidebar', icon: { type: 'sfSymbol', name: 'sidebar.left' }, onPress: menu }],
      unstable_headerRightItems: () => [{ type: 'button', label: 'Open conversation', icon: { type: 'sfSymbol', name: 'bubble.left' }, onPress: chat }],
    });
  }, [focused, directory, canvas.canvasId, canvas.title, navigation, openChat]);
  return <SafeAreaView edges={{ left: true, right: true, bottom: bottomTabInset === 0 }} style={{ backgroundColor: colors.background }}>
    <KeyboardAvoidingView enabled={keyboardVisible} style={[styles.fill, { marginBottom: bottomTabInset }]} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      {access && <ArtifactView appUrl={APP_URL} key={`${access.resourceId}:${access.version}:${attempt}`} access={access} background={colors.background} topInset={headerHeight + 12} focused={focused} onRetry={retry} onPresented={onPresented} />}
      {(!access || failed) && <Loading failed={failed} retry={retry} />}
    </KeyboardAvoidingView>
    {directory && <Sidebar visible={sidebar} snapshot={{ ...directory, canvasId: canvas.canvasId, tabId: canvas.canvasId, view: 'artifact', artifactId: canvas.resourceId, title: canvas.title, artifactPicker: false }} close={() => setSidebar(false)} send={send} diagnostics={() => rootNavigation.navigate('Diagnostics')} />}
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
  }, [controls, navigation]);
  return <SafeAreaView edges={{ left: true, right: true, bottom: true }} style={{ backgroundColor: colors.background }}>
    <KeyboardAvoidingView enabled={keyboardVisible} style={styles.fill} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View collapsable={false} style={styles.fill}>
        <CanvasWebView ref={web} url={mobileUrl(APP_URL, route.params.workspacePath, route.params.id)} appUrl={APP_URL} background={colors.background}
          onLoading={() => { setLoading(true); setFailed(false); }} onError={() => { setLoading(false); setFailed(true); }}
          onEvent={(event) => { if (mobileContentReady(event)) setLoading(false); if (event.type === 'signed-out') { navigation.goBack(); signOut(); } if (event.type === 'open-canvas') { navigation.goBack(); (controls.current.get(event.id) ?? controls.current.get('Home'))?.send({ type: 'open', id: event.id, pinned: controls.current.has(event.id) }); } }} />
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
