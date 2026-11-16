import { usePreparedSiteAccess } from './src/prepared-site-access';
import { useAppResume } from './src/use-app-resume';
import { usePreparedCanvases } from './src/prepared-canvases';
import { directoryKey } from './src/directory';
import { loadSavedDirectory, saveDirectory } from './src/saved-directory';
import { loadSavedPins, savePins } from './src/saved-pins';
import { requestArtifactAccess } from './src/artifact-access';
import { loadRememberedSites, saveRememberedSites } from './src/remembered-sites';
import { acceptFreshAccess } from './src/canonical-first';
import { deployedWebBuild } from './src/web-build';
import { Dashboard } from './src/Dashboard';
import { ArtifactPicker, ARTIFACT_PICKER_HEIGHT } from './src/ArtifactPicker';
import { FloatingHeader, type FloatingHeaderActions } from './src/FloatingHeader';
import { EdgePull, type EdgePullTarget } from './src/EdgePull';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { statusBarStyleFor } from './src/artifact-presentation';
import { dashboardVisible } from './src/dashboard-visibility';
import { HOME_RENDERER, recovery } from './src/recovery-order';
import { useCrashReporting } from './src/crashes';
import { RecoveryBoundary } from './src/RecoveryBoundary';
import { DiagnosticsScreen } from './src/DiagnosticsScreen';
import { SettingsScreen } from './src/SettingsScreen';
import { registerBackgroundSync } from './src/background';
import { useNotifications } from './src/notifications';
import { notificationTarget } from './src/notification-target';
import { recordFailure, recordTiming, shareDiagnostics } from './src/diagnostics';
import * as Notifications from 'expo-notifications';
import { useNetworkState } from 'expo-network';
import { type ComponentRef, createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Animated, BackHandler, Linking, Keyboard, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, View, useWindowDimensions, type KeyboardEvent, type ImageSourcePropType } from 'react-native';
import { NavigationContainer, StackActions, createNavigationContainerRef, DefaultTheme, DarkTheme, useIsFocused, type ParamListBase } from '@react-navigation/native';
import { createNativeBottomTabNavigator, type NativeBottomTabScreenProps } from '@bottom-tabs/react-navigation';
import { createNativeStackNavigator, type NativeStackScreenProps } from '@react-navigation/native-stack';
import { useHeaderHeight } from '@react-navigation/elements';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { SafeAreaView } from 'react-native-screens/experimental';
import { Menu, MessageCircle, Plus, X } from 'lucide-react-native';
import { StatusBar, useVerticalBarEdgeIOS } from 'expo-status-bar';
import { useBottomTabBarHeight } from 'react-native-bottom-tabs';
import { systemSignIn } from './src/auth';
import { CanvasWebView, ArtifactView, ArtifactSessionPreparation, type CanvasWebViewHandle } from './src/CanvasWebView';
import { NativeTabIcon } from './src/NativeTabIcon';
import { allocatePinSlots } from './src/pin-routes';
import { Sidebar } from './src/Sidebar';
import { mobileContentReady, mobileUrl, trustedArtifact, VISIBLE_PIN_COUNT, type CanvasSummary, type NativeArtifact, type MobileCommand, type MobileEvent, type MobileSettingsSection, type MobileSnapshot, type PreparedArtifact, type PreparedCanvas, type SharedElsewhereSummary } from './src/protocol';
import { useTheme } from './src/theme';

const APP_URL = process.env.EXPO_PUBLIC_RALLY_APP_URL || 'https://app.rallywith.ai';
const ARTIFACT_DOMAIN = process.env.EXPO_PUBLIC_RALLY_ARTIFACT_DOMAIN || 'rallyusercontent.com';
const START_URL = mobileUrl(APP_URL);
// Opening Home at the last organization skips the session and organization-list
// reads before it can draw. `HOME_FALLBACK` recovers if that access is gone.
const SAVED_DIRECTORY = loadSavedDirectory();
const PREPARED_PINS = {
  store: { initial: loadSavedPins(), save: savePins },
  direct: (directory: MobileSnapshot, canvas: PreparedCanvas) => requestArtifactAccess(APP_URL, directory, canvas, { report: (reason) => recordFailure('artifact_access_failed', reason) }),
};
const JS_STARTED = performance.now();
const REMEMBERED_SITES = loadRememberedSites();
let dashboardTimed = false;
const HOME_URL = SAVED_DIRECTORY ? mobileUrl(APP_URL, SAVED_DIRECTORY.workspacePath) : START_URL;
const Tabs = createNativeBottomTabNavigator();
type RootRoutes = { Canvases: { screen: 'Home' } | undefined; Settings: undefined; Diagnostics: undefined; Conversation: { id: string; workspacePath: string; title: string } };
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
  homeStale: boolean;
  reportHomeBuild: (build: string | undefined) => void;
  /** The live directory, or the saved copy until Home delivers it. For display only. */
  shownDirectory: MobileSnapshot | null;
  /** The site a canvas last showed, on its cookie, for this account. */
  rememberedSite: (canvasId: string) => NativeArtifact | null;
  rememberSite: (access: NativeArtifact) => void;
  claimStatusBar: (owner: string, style: 'light' | 'dark') => void;
  releaseStatusBar: (owner: string) => void;
  /** The status bar style an artifact in front claimed, for controls drawn over it. */
  artifactTone: 'light' | 'dark' | undefined;
};
const SessionContext = createContext<Session | null>(null);
const CanvasRoutesContext = createContext<Record<string, string | null>>({});
type StageFrame = { x: number; y: number; width: number; height: number };
/** A screen with a native artifact in front hides the native header and shows these instead. */
const FloatingHeaderContext = createContext<{ show: (owner: string, actions: FloatingHeaderActions) => void; hide: (owner: string) => void }>({ show: () => undefined, hide: () => undefined });
/** The focused screen's sidebar for the iOS edge pull; `x` is the finger's offset its drawer follows. */
const SidebarEdgeContext = createContext<{ x: Animated.Value; show: (owner: string, target: EdgePullTarget) => void; hide: (owner: string) => void }>({ x: new Animated.Value(0), show: () => undefined, hide: () => undefined });
/** Registers a screen's sidebar with the edge pull while the screen is focused. */
function useSidebarEdge(owner: string, active: boolean, open: () => void) {
  const sidebarEdge = useContext(SidebarEdgeContext);
  const target = useRef<EdgePullTarget>(null);
  useEffect(() => {
    if (!active) return;
    sidebarEdge.show(owner, { begin: () => target.current?.begin(), end: (...args) => target.current?.end(...args) });
    return () => sidebarEdge.hide(owner);
  }, [active, sidebarEdge, owner]);
  const pull = useMemo(() => ({ x: sidebarEdge.x, open }), [sidebarEdge.x, open]);
  return { ref: target, pull };
}
let knownHeaderHeight = 0;
/** The header's height, kept while the header is hidden over an artifact, so the
 * artifact's inset does not jump when the native header gives way to the floating one. */
function useArtifactHeaderHeight(): number {
  const height = useHeaderHeight();
  const insets = useSafeAreaInsets();
  if (height > 0) knownHeaderHeight = height;
  return knownHeaderHeight || insets.top + 44;
}
/** How a pinned tab tells the PinStage where its frame is and whether it is in front. */
const PinStageContext = createContext<{
  frame: (canvasId: string, frame: StageFrame) => void;
  front: (canvasId: string, focused: boolean) => void;
  /** Hand a pin to the browser renderer at an artifact the native view cannot show (a plain file). */
  browser: (canvasId: string, resourceId: string) => void;
  browserPins: Record<string, string>;
}>({ frame: () => undefined, front: () => undefined, browser: () => undefined, browserPins: {} });
function useSession() {
  const session = useContext(SessionContext);
  if (!session) throw new Error('Canvas session provider is missing');
  return session;
}

export default function App() { return <RecoveryBoundary><AppContent /></RecoveryBoundary>; }

function AppContent() {
  const { colors, isDark } = useTheme();
  const [directory, setDirectory] = useState<MobileSnapshot | null>(null);
  const directoryKeyRef = useRef('');
  // Display only: the dashboard draws from the saved copy until Home delivers
  // the live directory. Hooks that act on the account wait for the live one.
  const [savedDirectory, setSavedDirectory] = useState(SAVED_DIRECTORY);
  const [rememberedSites, setRememberedSites] = useState(REMEMBERED_SITES);
  // An artifact in front sets the status bar text to read over its own
  // background; whoever claimed it releases it when the artifact leaves.
  const [artifactStatusBar, setArtifactStatusBar] = useState<{ owner: string; style: 'light' | 'dark' } | null>(null);
  const claimStatusBar = useCallback((owner: string, style: 'light' | 'dark') => setArtifactStatusBar((current) => current?.owner === owner && current.style === style ? current : { owner, style }), []);
  const releaseStatusBar = useCallback((owner: string) => setArtifactStatusBar((current) => current?.owner === owner ? null : current), []);
  useEffect(() => { saveRememberedSites(rememberedSites); }, [rememberedSites]);
  const updateDirectory = useCallback((next: MobileSnapshot | null) => {
    // A signed-out answer can come before any live directory, when the key below
    // is already empty; the saved copy must still go, or the last account's
    // canvases reappear at the next launch.
    if (!next) { setSavedDirectory(null); setRememberedSites({}); saveDirectory(null); }
    const key = directoryKey(next);
    if (key === directoryKeyRef.current) return;
    directoryKeyRef.current = key;
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
  // The saved directory scopes saved pins until Home answers; requests it makes
  // still wait for Home, so nothing reaches an unloaded page.
  const prepared = usePreparedCanvases(directory ?? savedDirectory, sendHome, wakeHome, PREPARED_PINS);
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
  // A newer web build marks Home stale; it reloads the next time it is hidden.
  const homeBuild = useRef<string | null>(null);
  const [homeStale, setHomeStale] = useState(false);
  const reportHomeBuild = useCallback((build: string | undefined) => { homeBuild.current = build ?? null; setHomeStale(false); }, []);
  useAppResume(() => {
    sendHome({ type: 'refresh' });
    if (!homeBuild.current) return;
    void deployedWebBuild(APP_URL).then((deployed) => { if (deployed && homeBuild.current && deployed !== homeBuild.current) setHomeStale(true); });
  });
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
  // Settings sits over the tabs; what it opens happens in Home, so it returns
  // there first. A Settings page is Home's page, like the create flow.
  const showHome = useCallback(() => {
    setChatReturn(null);
    rootNavigation.dispatch(StackActions.popTo('Canvases', { screen: 'Home' }));
  }, []);
  const openSettingsSection = useCallback((section: MobileSettingsSection) => { showHome(); sendHome({ type: 'settings', section }); }, [showHome, sendHome]);
  const accountCommand = useCallback((type: 'sign-out' | 'switch-workspace') => {
    receiveCrashEvent({ type: 'signed-out' });
    showHome();
    sendHome({ type });
  }, [showHome, sendHome, receiveCrashEvent]);
  const shownScope = (directory ?? savedDirectory) ? `${(directory ?? savedDirectory)!.userId}:${(directory ?? savedDirectory)!.workspaceId}` : null;
  const rememberedSite = useCallback((canvasId: string): NativeArtifact | null => {
    const site = rememberedSites[canvasId];
    return site && site.scope === shownScope ? { canvasId, resourceId: site.resourceId, version: site.version, openUrl: site.canonicalUrl, canonicalUrl: site.canonicalUrl } : null;
  }, [rememberedSites, shownScope]);
  const rememberSite = useCallback((access: NativeArtifact) => {
    if (!shownScope) return;
    setRememberedSites((sites) => {
      const known = sites[access.canvasId];
      if (known && known.scope === shownScope && known.resourceId === access.resourceId && known.version === access.version && known.canonicalUrl === access.canonicalUrl) return sites;
      return { ...sites, [access.canvasId]: { scope: shownScope, resourceId: access.resourceId, version: access.version, canonicalUrl: access.canonicalUrl } };
    });
  }, [shownScope]);
  const session = useMemo(() => ({ directoryOwner, chatReturn, setChatReturn, prepared, directory, updateDirectory, controls, signIn, signOut, authEpoch, notifications, notificationOpened, receiveCrashEvent, homeStale, reportHomeBuild, shownDirectory: directory ?? savedDirectory, rememberedSite, rememberSite, claimStatusBar, releaseStatusBar, artifactTone: artifactStatusBar?.style }),
    [chatReturn, prepared, directory, savedDirectory, updateDirectory, signIn, signOut, authEpoch, notifications, notificationOpened, receiveCrashEvent, homeStale, reportHomeBuild, rememberedSite, rememberSite, claimStatusBar, releaseStatusBar, artifactStatusBar]);
  const theme = isDark ? DarkTheme : DefaultTheme;
  return <GestureHandlerRootView style={styles.fill}><SafeAreaProvider>
    <StatusBar style={artifactStatusBar?.style ?? (isDark ? 'light' : 'dark')} />
    <SessionContext value={session}>
      <NavigationContainer ref={rootNavigation} theme={{ ...theme, colors: { ...theme.colors, background: colors.background, card: colors.surface, text: colors.text, primary: colors.accent, border: colors.line } }}>
        <Stack.Navigator initialRouteName="Canvases">
          <Stack.Screen name="Settings" options={{ title: 'Settings', headerLargeTitle: true, headerLargeTitleShadowVisible: false, headerShadowVisible: false, headerStyle: { backgroundColor: colors.background }, headerTintColor: colors.text }}>{({ navigation }) => <SettingsScreen
            directory={directory} notifications={notifications} openSection={openSettingsSection}
            switchOrganization={() => accountCommand('switch-workspace')} signOut={() => accountCommand('sign-out')}
            openDiagnostics={() => navigation.navigate('Diagnostics')} />}</Stack.Screen>
          <Stack.Screen name="Diagnostics" component={DiagnosticsScreen} options={{ title: 'Diagnostics', headerShadowVisible: false, headerStyle: { backgroundColor: colors.background }, headerTintColor: colors.text, headerBackTitle: 'Settings' }} />
          <Stack.Screen name="Canvases" component={CanvasTabs} options={{ headerTitle: '', headerTransparent: true, headerShadowVisible: false, headerTintColor: colors.text }} />
          <Stack.Screen name="Conversation" component={Conversation} options={{ presentation: Platform.OS === 'ios' ? 'formSheet' : 'card', title: 'Conversation', sheetGrabberVisible: true }} />
        </Stack.Navigator>
      </NavigationContainer>
    </SessionContext>
  </SafeAreaProvider></GestureHandlerRootView>;
}

function CanvasTabs() {
  // Tabs draw from the saved directory until Home answers, so pins show at launch.
  const { shownDirectory: directory, controls, prepared, chatReturn, artifactTone } = useSession();
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
  const [stageFrames, setStageFrames] = useState<Record<string, StageFrame>>({});
  const [frontPin, setFrontPin] = useState<string | null>(null);
  const [browserPins, setBrowserPins] = useState<Record<string, string>>({});
  const [floating, setFloating] = useState<{ owner: string; actions: FloatingHeaderActions } | null>(null);
  const floatingHeader = useMemo(() => ({
    show: (owner: string, actions: FloatingHeaderActions) => setFloating({ owner, actions }),
    hide: (owner: string) => setFloating((current) => current?.owner === owner ? null : current),
  }), []);
  const pullX = useRef(new Animated.Value(0)).current;
  const [edge, setEdge] = useState<{ owner: string; target: EdgePullTarget } | null>(null);
  const sidebarEdge = useMemo(() => ({
    x: pullX,
    show: (owner: string, target: EdgePullTarget) => setEdge({ owner, target }),
    hide: (owner: string) => setEdge((current) => current?.owner === owner ? null : current),
  }), [pullX]);
  const stage = useMemo(() => ({
    browserPins,
    browser: (canvasId: string, resourceId: string) => setBrowserPins((pins) => ({ ...pins, [canvasId]: resourceId })),
    frame: (canvasId: string, frame: StageFrame) => setStageFrames((frames) => {
      const known = frames[canvasId];
      return known && known.x === frame.x && known.y === frame.y && known.width === frame.width && known.height === frame.height ? frames : { ...frames, [canvasId]: frame };
    }),
    front: (canvasId: string, focused: boolean) => setFrontPin((front) => focused ? canvasId : front === canvasId ? null : front),
  }), [browserPins]);
  return <FloatingHeaderContext value={floatingHeader}><SidebarEdgeContext value={sidebarEdge}><PinStageContext value={stage}><EdgePull x={pullX} target={edge?.target ?? null} enabled={Platform.OS === 'ios'} style={styles.fill}>
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
  </Tabs.Navigator></CanvasRoutesContext>
    <PinStage canvases={prepared.canvases} frames={stageFrames} front={frontPin} handedOff={browserPins} />
    {floating && !chatReturn && <FloatingHeader actions={floating.actions} tone={artifactTone} />}
  </EdgePull></PinStageContext></SidebarEdgeContext></FloatingHeaderContext>;
}

/**
 * Every hosted tab-bar pin's artifact, loaded from launch so a tab tap shows a
 * page already drawn. iOS creates a WKWebView only once its view is in a
 * window, and a native tab's content is not until the tab is first shown, so
 * the views live here, beside the tabs, instead of inside them. Each tab is an
 * empty frame that reports its rectangle; the pin in front is placed over it,
 * and the rest stay attached at zero opacity with touches and accessibility
 * off. Hidden pins recover after the screen in front (`recovery-order.ts`).
 */
function PinStage({ canvases, frames, front, handedOff }: { canvases: Record<string, PreparedCanvas>; frames: Record<string, StageFrame>; front: string | null; handedOff: Record<string, string> }) {
  const root = useRef<ComponentRef<typeof View>>(null);
  const [origin, setOrigin] = useState({ x: 0, y: 0 });
  // Start loading after the first frame, so the dashboard draws first.
  const [started, setStarted] = useState(false);
  useEffect(() => { const frame = requestAnimationFrame(() => setStarted(true)); return () => cancelAnimationFrame(frame); }, []);
  // Every pinned tab shares one geometry; until one has reported, use the screen.
  const { width, height } = useWindowDimensions();
  const fallback = Object.values(frames)[0] ?? { x: 0, y: 0, width, height };
  return <View ref={root} collapsable={false} pointerEvents="box-none" style={StyleSheet.absoluteFill}
    onLayout={() => root.current?.measureInWindow((x, y) => setOrigin((known) => known.x === x && known.y === y ? known : { x, y }))}>
    {started && Object.values(canvases).filter((canvas) => !handedOff[canvas.canvasId]).map((canvas) => <StagedPin key={canvas.canvasId} canvas={canvas}
      frame={frames[canvas.canvasId] ?? fallback} origin={origin} visible={front === canvas.canvasId} />)}
  </View>;
}

function StagedPin({ canvas, frame, origin, visible }: { canvas: PreparedCanvas; frame: StageFrame; origin: { x: number; y: number }; visible: boolean }) {
  const { prepared, claimStatusBar, releaseStatusBar } = useSession();
  const { colors } = useTheme();
  const headerHeight = useArtifactHeaderHeight();
  const [pageBackground, setPageBackground] = useState<string | null>(null);
  const owner = `pin:${canvas.canvasId}`;
  useEffect(() => {
    if (visible && pageBackground) claimStatusBar(owner, statusBarStyleFor(pageBackground));
    else releaseStatusBar(owner);
  }, [visible, pageBackground, owner, claimStatusBar, releaseStatusBar]);
  useEffect(() => () => releaseStatusBar(owner), [owner, releaseStatusBar]);
  const stage = useContext(PinStageContext);
  // A canvas with several artifacts opens its preferred site, as the browser
  // host would; its picker switches sites natively and hands a plain file,
  // which needs the browser inspector, to the browser renderer.
  const [selected, setSelected] = useState<string | null>(null);
  const chosen = canvas.artifacts?.find((artifact) => artifact.resourceId === selected && artifact.kind === 'site');
  const shown = useMemo(() => chosen ? { ...canvas, resourceId: chosen.resourceId, version: chosen.version } : canvas, [canvas, chosen]);
  const picker = (canvas.artifacts?.length ?? 0) > 1;
  const choose = useCallback((artifact: PreparedArtifact) => {
    if (artifact.kind === 'site') setSelected(artifact.resourceId === canvas.resourceId ? null : artifact.resourceId);
    else stage.browser(canvas.canvasId, artifact.resourceId);
  }, [canvas.canvasId, canvas.resourceId, stage]);
  const { access, failed, attempt, retry } = usePreparedSiteAccess(shown, prepared.sessions, prepared.open, ARTIFACT_DOMAIN);
  // A tap on a pin already drawn costs one frame; one still loading is timed
  // from the tap to its first presentation.
  const presented = useRef(false);
  const tappedAt = useRef<number | null>(null);
  useEffect(() => {
    if (!visible) return;
    const start = performance.now();
    if (!presented.current) { tappedAt.current = start; return; }
    const next = requestAnimationFrame(() => recordTiming('pin_tap_to_artifact', performance.now() - start));
    return () => cancelAnimationFrame(next);
  }, [visible]);
  const onPresented = useCallback(() => {
    presented.current = true;
    if (tappedAt.current === null) return;
    recordTiming('pin_tap_to_artifact', performance.now() - tappedAt.current);
    tappedAt.current = null;
  }, []);
  return <View collapsable={false} pointerEvents={visible ? 'auto' : 'none'}
    accessibilityElementsHidden={!visible} importantForAccessibility={visible ? 'auto' : 'no-hide-descendants'}
    style={{ position: 'absolute', left: frame.x - origin.x, top: frame.y - origin.y, width: frame.width, height: frame.height, opacity: visible ? 1 : 0, backgroundColor: colors.background }}>
    <View style={[StyleSheet.absoluteFill, picker && { top: headerHeight + ARTIFACT_PICKER_HEIGHT }]}>
      {access && <ArtifactView appUrl={APP_URL} key={`${access.resourceId}:${access.version}:${attempt}`} access={access} background={colors.background} topInset={picker ? 0 : headerHeight + 12} focused={visible} onRetry={retry} onPresented={onPresented} onBackground={setPageBackground} />}
      {(!access || failed) && visible && <Loading failed={failed} retry={retry} />}
    </View>
    {picker && <ArtifactPicker artifacts={canvas.artifacts!} selected={shown.resourceId} onSelect={choose} top={headerHeight} />}
  </View>;
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

function CanvasScreen({ route, navigation, canvasId: assignedCanvasId, artifactId, onContentReady }: NativeBottomTabScreenProps<ParamListBase> & { canvasId?: string; artifactId?: string; onContentReady?: () => void }) {
  const floatingHeader = useContext(FloatingHeaderContext);
  const { directory, updateDirectory, controls, signIn, signOut, notifications, notificationOpened, receiveCrashEvent, prepared, setChatReturn, directoryOwner, homeStale, reportHomeBuild, shownDirectory, rememberedSite, rememberSite, claimStatusBar, releaseStatusBar } = useSession();
  const { colors } = useTheme();
  const canvasId = assignedCanvasId ?? route.name;
  const routeCanvases = useContext(CanvasRoutesContext);
  const tabs = navigation;
  const { openChat, closeChat, chatReturn } = useChatNavigation(navigation, route.name);
  const home = canvasId === 'Home';
  const focused = useIsFocused();
  useLayoutEffect(() => { if (focused) directoryOwner.current = canvasId; }, [focused, canvasId, directoryOwner]);
  const network = useNetworkState();
  const headerHeight = useArtifactHeaderHeight();
  const tabBarHeight = useBottomTabBarHeight();
  const verticalBarEdge = useVerticalBarEdgeIOS();
  // Callstack tab scenes extend behind the iPhone bar. Reserve its measured
  // height, including the home indicator, once. Duo rails use native side insets.
  const bottomTabInset = Platform.OS === 'ios' && !Platform.isPad && !Platform.isTV
    && verticalBarEdge === null && shownDirectory && !chatReturn ? tabBarHeight : 0;
  const web = useRef<CanvasWebViewHandle>(null);
  const [url, setUrl] = useState(() => {
    if (home) return HOME_URL;
    if (!shownDirectory) return START_URL;
    const initial = new URL(mobileUrl(APP_URL, shownDirectory.workspacePath));
    initial.hash = `/canvases/${encodeURIComponent(canvasId)}?tab=1${artifactId ? `&artifact=${encodeURIComponent(artifactId)}` : ''}`;
    return initial.href;
  });
  const [snapshot, setSnapshot] = useState<MobileSnapshot | null>(null);
  const [artifacts, setArtifacts] = useState<Record<string, NativeArtifact>>({});
  // A canvas opened from the dashboard on a remembered cookie, shown before Home
  // has navigated to it; Home's own view takes over once it reports one.
  const [optimistic, setOptimistic] = useState<string | null>(null);
  const renewing = useRef(new Set<string>());
  const [ready, setReady] = useState(false);
  const [contentReady, setContentReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [sidebar, setSidebar] = useState(false);
  const keyboardVisible = useKeyboardVisible();
  const scope = useRef<string | null>(null);
  const snapshotSeen = useRef(false);
  // Commands wait until the page answers with a snapshot: `ready` comes from
  // the bridge before the signed-in page installs its command listener, and a
  // terminated page answers nothing until it reloads.
  const queued = useRef<MobileCommand[]>([]);
  const [answering, setAnswering] = useState(false);
  const [opening, setOpening] = useState<string | null>(null);
  const sendHome = useCallback((command: MobileCommand) => {
    if (answering) web.current?.send(command);
    else queued.current.push(command);
  }, [answering]);
  useEffect(() => {
    if (!answering || queued.current.length === 0) return;
    for (const command of queued.current.splice(0)) web.current?.send(command);
  }, [answering]);
  const open = useCallback((id: string) => {
    if (chatReturn) closeChat();
    // The tab bar draws the saved pins before Home answers; so does this.
    if (shownDirectory?.pins.slice(0, VISIBLE_PIN_COUNT).includes(id)) {
      const destination = Object.keys(routeCanvases).find((name) => routeCanvases[name] === id);
      if (destination) tabs.navigate(destination);
    }
    else {
      tabs?.navigate('Home');
      controls.current.get('Home')?.send({ type: 'open', id, pinned: false });
    }
  }, [controls, shownDirectory?.pins, routeCanvases, tabs, chatReturn, closeChat]);
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
    if (home && event.type === 'ready') reportHomeBuild(event.build);
    setReady(true); setFailed(false);
    if (mobileContentReady(event)) setContentReady(true);
    if (event.type === 'open-canvas') {
      if (event.id === canvasId) web.current?.send({ type: 'open', id: event.id, pinned: true });
      else open(event.id);
    }
    if (event.type === 'artifact') {
      if (!trustedArtifact(event.artifact, ARTIFACT_DOMAIN)) { setFailed(true); return; }
      const fresh = event.artifact;
      const renewal = renewing.current.delete(fresh.canvasId);
      setArtifacts((current) => ({ ...current, [fresh.canvasId]: acceptFreshAccess(current[fresh.canvasId], fresh, renewal) }));
    }
    if (event.type === 'artifact-unavailable') setArtifacts((current) => {
      if (current[event.canvasId]?.resourceId !== event.resourceId) return current;
      const next = { ...current }; delete next[event.canvasId]; return next;
    });
    if (event.type === 'snapshot') {
      snapshotSeen.current = true;
      setAnswering(true);
      if (event.snapshot.view !== 'home') { setOpening(null); setOptimistic(null); }
      const nextScope = `${event.snapshot.userId}:${event.snapshot.workspaceId}`;
      if (scope.current !== nextScope) { scope.current = nextScope; setArtifacts({}); setOptimistic(null); }
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
  }, [directoryOwner, home, url, reportHomeBuild, tabs, open, canvasId, signIn, signOut, updateDirectory, notifications.receive, notificationOpened, receiveCrashEvent, prepared.receive, onContentReady]);
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
  const shownArtifact = (access: NativeArtifact) => optimistic === access.canvasId
    || (snapshot?.view === 'artifact' && snapshot.canvasId === access.canvasId && snapshot.artifactId === access.resourceId);
  const frontArtifact = Object.values(artifacts).find(shownArtifact);
  const hosted = frontArtifact !== undefined;
  const [pageBackgrounds, setPageBackgrounds] = useState<Record<string, string>>({});
  // Header items are native views: rebuild them only when what they show changes.
  const view = snapshot?.view;
  const viewCanvas = snapshot?.canvasId;
  const viewTitle = snapshot?.title ?? '';
  useEffect(() => {
    if (!home || !focused || chatReturn || view !== 'settings') return;
    const back = BackHandler.addEventListener('hardwareBackPress', () => { sendHome({ type: 'home' }); rootNavigation.navigate('Settings'); return true; });
    return () => back.remove();
  }, [home, focused, chatReturn, view, sendHome]);
  const signedIn = Boolean(directory);
  // Home's dashboard is native: shown from the saved directory before the page
  // answers, and whenever the page is on its own dashboard. The page stays
  // mounted behind it for the socket, chat, create and canvases it opens.
  const showDashboard = dashboardVisible({ home, chatOpen: Boolean(chatReturn), opening: opening !== null || optimistic !== null, snapshot, hasDirectory: Boolean(shownDirectory) });
  useEffect(() => home ? navigation.addListener('tabPress', () => { setOpening(null); setOptimistic(null); }) : undefined, [home, navigation]);
  // The dashboard is native, so launch is timed to its first draw with canvases.
  useEffect(() => {
    if (!showDashboard || !shownDirectory || dashboardTimed) return;
    const frame = requestAnimationFrame(() => {
      if (dashboardTimed) return;
      dashboardTimed = true;
      recordTiming('launch_to_dashboard', performance.now() - JS_STARTED);
    });
    return () => cancelAnimationFrame(frame);
  }, [showDashboard, shownDirectory]);
  // A stale Home reloads only where nobody sees its page: off screen, or under
  // the native dashboard, which keeps drawing from the directory meanwhile. An
  // open inline chat, create flow or canvas lives in the page and is never cut.
  useEffect(() => { if (home && homeStale && (!focused || showDashboard)) web.current?.reload(); }, [home, homeStale, focused, showDashboard]);
  const openFromDashboard = useCallback((id: string) => {
    if (shownDirectory?.pins.slice(0, VISIBLE_PIN_COUNT).includes(id)) { open(id); return; }
    setOpening(id);
    sendHome({ type: 'open', id, pinned: false });
    // Canonical-first: a canvas whose site this account has opened before shows
    // at once on its cookie, without waiting for Home to mint and redeem access.
    const known = rememberedSite(id);
    if (known && trustedArtifact(known, ARTIFACT_DOMAIN)) {
      setArtifacts((current) => ({ ...current, [id]: current[id]?.resourceId === known.resourceId ? current[id]! : known }));
      setOptimistic(id);
    }
  }, [shownDirectory?.pins, open, sendHome, rememberedSite]);
  const createFromDashboard = useCallback(() => { setOpening('create'); sendHome({ type: 'create' }); }, [sendHome]);
  const marketplaceFromDashboard = useCallback(() => { setOpening('create'); sendHome({ type: 'create', marketplace: true }); }, [sendHome]);
  // Home switches Organization and opens it there, as for a notification's link.
  const openElsewhereFromDashboard = useCallback((canvas: SharedElsewhereSummary) => {
    setOpening(canvas.id);
    sendHome({ type: 'open-elsewhere', region: canvas.organization.region, workspaceId: canvas.organization.id, canvasId: canvas.id });
  }, [sendHome]);
  // The edge pull opens the sidebar wherever its header button does.
  const openSidebar = useCallback(() => setSidebar(true), []);
  const edgePull = useSidebarEdge(canvasId, focused && signedIn, openSidebar);
  useEffect(() => {
    if (!focused) return;
    const chat = view === 'artifact' && viewCanvas ? () => openChat(viewCanvas, viewTitle) : undefined;
    // A Settings page Home shows closes back to the native Settings list.
    const settingsPage = home && view === 'settings';
    const closeSettings = () => { sendHome({ type: 'home' }); rootNavigation.navigate('Settings'); };
    const close = home && chatReturn ? closeChat : settingsPage ? closeSettings : undefined;
    const closeLabel = settingsPage && !chatReturn ? 'Back to settings' : 'Close conversation';
    const menu = () => setSidebar(true);
    const create = showDashboard ? createFromDashboard : undefined;
    // A native artifact in front owns its pixels: the native header gives way to
    // the floating one, because iOS 26 fades content under a navigation bar in
    // the app's appearance (a white band over a dark site). The dashboard, chat
    // and pages the browser renders keep the native header.
    if (hosted && !close && frontArtifact) {
      const front = frontArtifact;
      navigation.getParent()?.setOptions({ headerShown: false });
      // The buttons need the live directory (see PreparedSiteScreen).
      if (!signedIn) { floatingHeader.hide(canvasId); return; }
      floatingHeader.show(canvasId, { menu, chat: () => openChat(front.canvasId, viewTitle) });
      return () => floatingHeader.hide(canvasId);
    }
    floatingHeader.hide(canvasId);
    navigation.getParent()?.setOptions({
      headerShown: true,
      headerTitle: settingsPage ? viewTitle : '',
      headerLeft: signedIn ? () => <HeaderButton kind="menu" label="Open sidebar" onPress={menu} /> : undefined,
      headerRight: close ? () => <HeaderButton kind="close" label={closeLabel} onPress={close} /> : create ? () => <HeaderButton kind="create" label="Create a canvas" onPress={create} /> : chat ? () => <HeaderButton kind="chat" label="Open conversation" onPress={chat} /> : undefined,
      unstable_headerLeftItems: () => signedIn ? [{ type: 'button', label: 'Open sidebar', icon: { type: 'sfSymbol', name: 'sidebar.left' }, onPress: menu }] : [],
      unstable_headerRightItems: () => close ? [{ type: 'button', label: closeLabel, icon: { type: 'sfSymbol', name: 'xmark' }, onPress: close }] : create ? [{ type: 'button', label: 'Create a canvas', icon: { type: 'sfSymbol', name: 'plus' }, onPress: create }] : chat ? [{ type: 'button', label: 'Open conversation', icon: { type: 'sfSymbol', name: 'bubble.left' }, onPress: chat }] : [],
    });
  }, [signedIn, focused, navigation, view, viewCanvas, viewTitle, home, chatReturn, closeChat, openChat, showDashboard, createFromDashboard, hosted, frontArtifact, floatingHeader, canvasId, sendHome]);
  // The status bar reads over the artifact in front, as the floating header does.
  const statusOwner = `screen:${canvasId}`;
  const frontBackground = frontArtifact ? pageBackgrounds[frontArtifact.canvasId] : undefined;
  useEffect(() => {
    if (focused && hosted && !(home && chatReturn) && frontBackground) claimStatusBar(statusOwner, statusBarStyleFor(frontBackground));
    else releaseStatusBar(statusOwner);
  }, [focused, hosted, home, chatReturn, frontBackground, statusOwner, claimStatusBar, releaseStatusBar]);
  useEffect(() => () => releaseStatusBar(statusOwner), [statusOwner, releaseStatusBar]);
  // Native safe areas follow the system rail (including its side in Split View).
  // Content extends behind the transparent header; the initial inset scrolls away.
  return <SafeAreaView edges={{ left: true, right: true, bottom: bottomTabInset === 0 }} style={{ backgroundColor: colors.background }}>
    <KeyboardAvoidingView enabled={keyboardVisible} style={[styles.fill, { marginBottom: bottomTabInset }]} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View collapsable={false} style={styles.fill} accessibilityElementsHidden={hosted || showDashboard || !focused} importantForAccessibility={hosted || showDashboard || !focused ? 'no-hide-descendants' : 'auto'}>
        <CanvasWebView ref={web} url={url} appUrl={APP_URL} background={colors.background} topInset={headerHeight + 12} onEvent={receive}
          focused={focused && !hosted} recoveryId={`web:${canvasId}`}
          onTerminated={() => setAnswering(false)}
          onLoading={() => {
            // Loading Home must not close other tabs and discard their drafts.
            // Authentication snapshots and signed-out events own the directory.
            if (home) { prepared.reset(); setChatReturn(null); }
            // A native artifact in front outlives its page's reload (a crash
            // recovery, a stale build): keep it there, not the dashboard.
            if (frontArtifact) setOptimistic(frontArtifact.canvasId);
            setReady(false); setAnswering(false); setContentReady(false); setFailed(false); setSnapshot(null); setSidebar(false);
          }} onError={() => {
            // A tap waiting on this page will not be answered: drop it, so the
            // failure and its retry show instead of an endless spinner.
            if (home) prepared.fail();
            queued.current = []; setOpening(null); setOptimistic(null); setAnswering(false); setFailed(true);
          }} />
      </View>
      {Object.values(artifacts).map((access) => {
        const visible = shownArtifact(access);
        return <View key={access.canvasId} collapsable={false} accessibilityElementsHidden={!visible || !focused} importantForAccessibility={visible && focused ? 'auto' : 'no-hide-descendants'} pointerEvents={visible ? 'auto' : 'none'} style={[StyleSheet.absoluteFill, { top: snapshot?.artifactPicker ? headerHeight + 60 : 0, opacity: visible ? 1 : 0 }]}>
          <ArtifactView key={access.version} appUrl={APP_URL} topInset={snapshot?.artifactPicker ? 0 : headerHeight + 12} access={access} background={colors.background} focused={focused && visible}
            onPresented={() => rememberSite(access)}
            onBackground={(color) => setPageBackgrounds((known) => known[access.canvasId] === color ? known : { ...known, [access.canvasId]: color })}
            onRetry={() => {
              // The page may be waiting behind this artifact's own recovery:
              // wake it, and hold the renewal until it answers.
              renewing.current.add(access.canvasId);
              recovery.wake(`web:${canvasId}`);
              sendHome({ type: 'reopen-artifact', canvasId: access.canvasId, resourceId: access.resourceId });
            }} />
        </View>;
      })}
      {showDashboard && <View style={StyleSheet.absoluteFill}>
        {/* The page reports a directory it could not load (a socket refusal or an
            update it needs) as directoryError; the dashboard covers the page's
            own recovery, so it offers that retry itself. */}
        <Dashboard canvases={shownDirectory?.canvases ?? []} sharedElsewhere={shownDirectory?.sharedElsewhere ?? []} loading={!shownDirectory} failed={failed || Boolean(snapshot?.directoryError)} topInset={headerHeight + 12} bottomInset={0}
          open={openFromDashboard} openElsewhere={openElsewhereFromDashboard} create={createFromDashboard} marketplace={marketplaceFromDashboard} retry={() => { if (failed) { setFailed(false); web.current?.reload(); } else sendHome({ type: 'refresh' }); }} />
      </View>}
      {!showDashboard && !optimistic && (opening !== null || !contentReady || failed) && <Loading failed={failed && opening === null} retry={() => { setFailed(false); web.current?.reload(); }} />}
    </KeyboardAvoidingView>
    {directory && <Sidebar visible={sidebar} snapshot={{ ...directory, ...snapshot, ...{ canvases: directory.canvases, pins: directory.pins, pinBusy: directory.pinBusy, pinError: directory.pinError }, tabId: home ? null : canvasId }} close={() => setSidebar(false)} send={send} openSettings={() => rootNavigation.navigate('Settings')} ref={edgePull.ref} pull={edgePull.pull} />}
  </SafeAreaView>;
}

function PinnedCanvasRoute(props: NativeBottomTabScreenProps<ParamListBase> & { canvasId?: string }) {
  const { prepared } = useSession();
  const canvas = prepared.canvases[props.canvasId ?? props.route.name];
  // Late descriptors may replace the bootstrap spinner, but never a browser
  // artifact or conversation the person has already started using.
  const [browserShown, setBrowserShown] = useState(false);
  const keepBrowser = useCallback(() => setBrowserShown(true), []);
  const handedOff = useContext(PinStageContext).browserPins[props.canvasId ?? props.route.name];
  return !browserShown && !handedOff && canvas ? <PreparedSiteScreen {...props} canvas={canvas} />
    : <CanvasScreen {...props} artifactId={handedOff} onContentReady={keepBrowser} />;
}

/** A hosted pin uses Home's existing API/socket session and opens its actual URL.
 * Other artifact types retain the shared browser renderer. */
function PreparedSiteScreen({ canvas, navigation, route }: NativeBottomTabScreenProps<ParamListBase> & { canvas: PreparedCanvas }) {
  const { directory, controls, receiveCrashEvent, directoryOwner } = useSession();
  const { colors } = useTheme();
  const { openChat } = useChatNavigation(navigation, route.name);
  const focused = useIsFocused();
  useLayoutEffect(() => { if (focused) directoryOwner.current = 'Home'; }, [focused, directoryOwner]);
  const routeCanvases = useContext(CanvasRoutesContext);
  const network = useNetworkState();
  const keyboardVisible = useKeyboardVisible();
  const tabBarHeight = useBottomTabBarHeight();
  const verticalBarEdge = useVerticalBarEdgeIOS();
  const bottomTabInset = Platform.OS === 'ios' && !Platform.isPad && !Platform.isTV && verticalBarEdge === null ? tabBarHeight : 0;
  const [sidebar, setSidebar] = useState(false);
  // The artifact lives in the PinStage layer, loaded since launch; this screen
  // is only the frame it is shown in. Report where that frame is, and whether
  // this tab is the one in front.
  const stage = useContext(PinStageContext);
  const frame = useRef<ComponentRef<typeof View>>(null);
  const measure = useCallback(() => frame.current?.measureInWindow((x, y, width, height) => {
    if (width > 0 && height > 0) stage.frame(canvas.canvasId, { x, y, width, height });
  }), [stage, canvas.canvasId]);
  useEffect(() => { stage.front(canvas.canvasId, focused); if (focused) measure(); }, [stage, canvas.canvasId, focused, measure]);
  useEffect(() => () => stage.front(canvas.canvasId, false), [stage, canvas.canvasId]);
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
  // A pinned site is always an artifact: the native header gives way to the
  // floating one, so iOS draws no fade over the site's own pixels.
  const floatingHeader = useContext(FloatingHeaderContext);
  const openSidebar = useCallback(() => setSidebar(true), []);
  const edgePull = useSidebarEdge(canvas.canvasId, focused && Boolean(directory), openSidebar);
  useEffect(() => {
    if (!focused) return;
    navigation.getParent()?.setOptions({ headerShown: false });
    // Both buttons need the live directory: the sidebar mounts with it and the
    // chat opens through it. A saved copy alone shows the site without them.
    if (!directory) { floatingHeader.hide(canvas.canvasId); return; }
    floatingHeader.show(canvas.canvasId, { menu: () => setSidebar(true), chat: () => openChat(canvas.canvasId, canvas.title) });
    return () => floatingHeader.hide(canvas.canvasId);
  }, [focused, canvas.canvasId, canvas.title, navigation, openChat, floatingHeader, directory]);
  return <SafeAreaView edges={{ left: true, right: true, bottom: bottomTabInset === 0 }} style={{ backgroundColor: colors.background }}>
    <KeyboardAvoidingView enabled={keyboardVisible} style={[styles.fill, { marginBottom: bottomTabInset }]} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View ref={frame} collapsable={false} style={styles.fill} onLayout={measure} />
    </KeyboardAvoidingView>
    {directory && <Sidebar visible={sidebar} snapshot={{ ...directory, canvasId: canvas.canvasId, tabId: canvas.canvasId, view: 'artifact', artifactId: canvas.resourceId, title: canvas.title, artifactPicker: false }} close={() => setSidebar(false)} send={send} openSettings={() => rootNavigation.navigate('Settings')} ref={edgePull.ref} pull={edgePull.pull} />}
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
