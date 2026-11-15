import { CanvasIcon } from './CanvasIcon';
import { useEffect, useImperativeHandle, useMemo, useRef, useState, type ComponentRef, type Ref } from 'react';
import { AccessibilityInfo, Animated, Easing, Modal, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { movePin, VISIBLE_PIN_COUNT, type MobileCommand, type MobileSnapshot } from './protocol';
import { useTheme } from './theme';
import { SidebarDragRow } from './SidebarDragRow';
import { sidebarDropCommand, type SidebarDrop } from './sidebar-drop';
import type { EdgePullTarget } from './EdgePull';
import { edgePullOpens } from './edge-swipe';

type IconName = React.ComponentProps<typeof Ionicons>['name'];
interface Props {
  diagnostics?: () => void;
  visible: boolean;
  snapshot: MobileSnapshot;
  close: () => void;
  send: (command: MobileCommand) => void;
  /** An edge pull's finger offset, and how the screen shows the sidebar once
   * a pull lets go open. `ref` receives the pull's begin and end. */
  pull?: { x: Animated.Value; open: () => void };
  ref?: Ref<EdgePullTarget>;
}

interface DragState { id: string; x: number; y: number; target: SidebarDrop | null }
interface Bounds { x: number; y: number; width: number; height: number }

const ROW_HEIGHT = 52;
const AUTO_SCROLL_ROWS_PER_SECOND = 8;
const OPEN_MS = 280;
const CLOSE_MS = 220;
export function Sidebar({ visible, snapshot, close, send, diagnostics, pull, ref }: Props) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const [editing, setEditing] = useState(false);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const scroll = useRef<ComponentRef<typeof ScrollView>>(null);
  const viewport = useRef<ComponentRef<typeof View>>(null);
  const viewportBounds = useRef<Bounds>({ x: 0, y: 0, width: 0, height: 0 });
  const pinBounds = useRef({ y: 0, height: 0, rowsY: 0 });
  const canvasBounds = useRef({ y: 0, height: 0 });
  const scrollY = useRef(0);
  const contentHeight = useRef(0);
  const dragRef = useRef<DragState | null>(null);
  const dragY = useRef(new Animated.Value(0)).current;
  const updateDrag = (value: DragState | null) => {
    const previous = dragRef.current;
    dragRef.current = value;
    if (value) dragY.setValue(value.y - ROW_HEIGHT / 2);
    // Pointer motion moves only the ghost; rerender rows when the destination changes.
    if (previous?.id !== value?.id || previous?.target?.section !== value?.target?.section
      || (previous?.target?.section === 'pins' ? previous.target.index : null) !== (value?.target?.section === 'pins' ? value.target.index : null)) setDrag(value);
  };
  const dragging = drag !== null;
  const drawerWidth = Math.min(width - insets.right - 44, 336 + insets.left);
  // The Modal stays up while the drawer slides out, then goes. It presents
  // with no animation of its own; the drawer and scrim animate inside it.
  const [mounted, setMounted] = useState(visible);
  const mountedRef = useRef(mounted);
  mountedRef.current = mounted;
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const progress = useRef(new Animated.Value(0)).current;
  const [reduceMotion, setReduceMotion] = useState(false);
  useEffect(() => {
    void AccessibilityInfo.isReduceMotionEnabled().then(setReduceMotion);
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduceMotion);
    return () => subscription.remove();
  }, []);
  // Settling covers only the distance left, so a drawer let go halfway does
  // not slow down. A pull leaves `progress` where the finger let go.
  const settled = useRef(0);
  const settle = (toValue: 0 | 1, after?: () => void) => {
    const remaining = Math.abs(toValue - settled.current);
    settled.current = toValue;
    Animated.timing(progress, { toValue, duration: (toValue ? OPEN_MS : CLOSE_MS) * remaining, easing: toValue ? Easing.out(Easing.cubic) : Easing.in(Easing.cubic), useNativeDriver: true })
      .start(({ finished }) => { if (finished) after?.(); });
  };
  const animateOpen = () => settle(1);
  const unmountUnlessShown = () => { if (!visibleRef.current) setMounted(false); };
  useEffect(() => {
    // A first open waits for the Modal to present (onShow) before sliding in.
    if (visible) { if (mountedRef.current) animateOpen(); else setMounted(true); return; }
    if (!mountedRef.current) return;
    settle(0, unmountUnlessShown);
  }, [visible]);
  // While a finger pulls from the edge, the drawer follows it: `pull.x` moves
  // on the native side. On release that offset moves into `progress`, which
  // settles open or closed from there.
  const pulling = useRef(false);
  useImperativeHandle(ref, () => ({
    begin: () => {
      if (visibleRef.current || mountedRef.current) return;
      pulling.current = true;
      settled.current = 0;
      progress.setValue(0);
      setMounted(true);
    },
    end: (translationX, velocityX, canceled) => {
      if (!pulling.current || !pull) return;
      pulling.current = false;
      const fraction = Math.max(0, Math.min(1, translationX / drawerWidth));
      pull.x.setValue(0);
      progress.setValue(fraction);
      settled.current = fraction;
      if (!canceled && edgePullOpens(fraction, velocityX)) pull.open();
      else settle(0, unmountUnlessShown);
    },
  }), [pull, drawerWidth, progress]);
  const pullX = pull?.x;
  const position = useMemo(() => Animated.add(progress, pullX ? Animated.divide(pullX, drawerWidth) : 0)
    .interpolate({ inputRange: [0, 1], outputRange: [0, 1], extrapolate: 'clamp' }), [pullX, drawerWidth, progress]);
  // Reduce Motion fades the drawer in place instead of sliding it.
  const drawerMotion = reduceMotion ? { opacity: position } : { transform: [{ translateX: position.interpolate({ inputRange: [0, 1], outputRange: [-drawerWidth, 0] }) }] };
  const pinKey = JSON.stringify(snapshot.pins);
  useEffect(() => { dragRef.current = null; setDrag(null); }, [visible, snapshot.userId, snapshot.workspaceId, pinKey]);
  const resetScroll = () => {
    scrollY.current = 0;
    scroll.current?.scrollTo({ y: 0, animated: false });
  };
  const measureViewport = (after?: () => void) => viewport.current?.measure((_x, _y, width, height, x, y) => {
    viewportBounds.current = { x, y, width, height };
    after?.();
  });
  useEffect(() => { if (!visible) { resetScroll(); setEditing(false); setNotice(null); } }, [visible]);
  const move = (x: number, y: number) => {
    const current = dragRef.current;
    if (!current) return;
    const bounds = viewportBounds.current;
    const contentY = y - bounds.y + scrollY.current;
    let target: SidebarDrop | null = null;
    if (x >= bounds.x && x <= bounds.x + bounds.width && y >= bounds.y && y <= bounds.y + bounds.height) {
      const pins = pinBounds.current;
      const canvases = canvasBounds.current;
      if (contentY >= pins.y && contentY <= pins.y + pins.height) {
        target = { section: 'pins', index: Math.max(0, Math.min(snapshot.pins.length, Math.round((contentY - pins.y - pins.rowsY) / ROW_HEIGHT))) };
      } else if (contentY >= canvases.y && contentY <= canvases.y + canvases.height) target = { section: 'canvases' };
    }
    updateDrag({ ...current, x, y, target });
  };
  const moveRef = useRef(move);
  moveRef.current = move;
  useEffect(() => {
    if (!dragging) return;
    let frame = 0;
    let previous = 0;
    const tick = (now: number) => {
      const current = dragRef.current;
      if (!current) return;
      const bounds = viewportBounds.current;
      const localY = current.y - bounds.y;
      // One row at either edge is the scroll zone; speed rises toward the edge.
      const edge = Math.min(ROW_HEIGHT, bounds.height / 3);
      const direction = localY < edge ? -Math.min(1, (edge - localY) / edge) : localY > bounds.height - edge ? Math.min(1, (localY - bounds.height + edge) / edge) : 0;
      const elapsed = previous ? (now - previous) / 1000 : 0;
      previous = now;
      const next = Math.max(0, Math.min(Math.max(0, contentHeight.current - bounds.height), scrollY.current + direction * ROW_HEIGHT * AUTO_SCROLL_ROWS_PER_SECOND * elapsed));
      if (next !== scrollY.current) {
        scrollY.current = next;
        scroll.current?.scrollTo({ y: next, animated: false });
        moveRef.current(current.x, current.y);
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [dragging]);
  function startDrag(id: string, x: number, y: number) {
    if (snapshot.pinBusy) return;
    setNotice(null);
    updateDrag({ id, x, y, target: null });
    move(x, y);
    measureViewport(() => {
      const current = dragRef.current;
      if (current?.id === id) moveRef.current(current.x, current.y);
    });
  }
  function finishDrag() {
    const current = dragRef.current;
    updateDrag(null);
    if (!current || snapshot.pinBusy) return;
    const command = sidebarDropCommand(snapshot.pins, current.id, current.target);
    if (!command) return;
    if (command.type === 'pin' && command.pinned && snapshot.pins.length >= VISIBLE_PIN_COUNT) {
      setNotice('Unpin a canvas to make room for another tab.'); return;
    }
    action(command);
  }
  const unpinned = snapshot.canvases.filter((canvas) => !snapshot.pins.includes(canvas.id));
  const titleFor = (id: string) => snapshot.canvases.find((canvas) => canvas.id === id)?.title ?? 'Unavailable canvas';
  function action(command: MobileCommand, dismiss = false) {
    setNotice(null);
    send(command);
    if (dismiss) { setEditing(false); close(); }
  }
  function pin(id: string) {
    if (snapshot.pins.length >= VISIBLE_PIN_COUNT) { setNotice('Unpin a canvas to make room for another tab.'); return; }
    action({ type: 'pin', id, pinned: true });
  }
  const iconButton = (name: IconName, label: string, onPress: () => void, disabled = false) => <Pressable
    accessibilityRole="button" accessibilityLabel={label} onPress={onPress} disabled={disabled}
    style={({ pressed }) => [styles.control, { opacity: disabled ? 0.35 : pressed ? 0.6 : 1 }]}>
    <Ionicons name={name} size={20} color={colors.muted} />
  </Pressable>;
  return <Modal transparent visible={mounted} animationType="none" onRequestClose={close} onShow={() => { resetScroll(); measureViewport(); if (visibleRef.current) animateOpen(); }}>
    <View style={styles.overlay}>
      <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: colors.scrim, opacity: position }]}>
        <Pressable style={StyleSheet.absoluteFill} accessibilityLabel="Close sidebar" accessibilityRole="button" onPress={close} />
      </Animated.View>
      <Animated.View accessibilityViewIsModal style={[styles.drawer, drawerMotion, { width: drawerWidth, paddingLeft: 14 + insets.left, paddingTop: insets.top + 12, paddingBottom: insets.bottom + 12, backgroundColor: colors.sidebar }]}>
        <View style={styles.heading}><Text style={[styles.brand, { color: colors.text }]}>Rally</Text>{iconButton('menu-outline', 'Close sidebar', close)}</View>
        <View ref={viewport} style={{ flex: 1 }} onLayout={() => measureViewport()}>
        <ScrollView ref={scroll} scrollEnabled={!dragging} onScroll={({ nativeEvent }) => { scrollY.current = nativeEvent.contentOffset.y; }} scrollEventThrottle={16}
          onContentSizeChange={(_, height) => { contentHeight.current = height; }} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled" style={{ flex: 1 }}>
          <View style={[styles.row, { backgroundColor: snapshot.view === 'home' ? colors.selected : 'transparent' }]}>
            <Pressable style={styles.destination} accessibilityRole="button" accessibilityLabel="Home" onPress={() => action({ type: 'home' }, true)}><Ionicons name="home-outline" size={21} color={colors.text} /><Text style={[styles.title, { color: colors.text }]}>Home</Text></Pressable>
            {editing && <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={styles.control}><Ionicons name="lock-closed-outline" size={14} color={colors.muted} /></View>}
          </View>
          <View onLayout={({ nativeEvent: { layout } }) => { pinBounds.current = { ...pinBounds.current, y: layout.y, height: layout.height }; }}>
            <View style={styles.section}><Text style={[styles.label, { color: colors.muted }]}>PINNED</Text><Pressable accessibilityRole="button" accessibilityLabel={editing ? 'Done editing tabs' : 'Edit tabs'} onPress={() => setEditing(!editing)} style={styles.edit}><Text style={{ color: colors.accent }}>{editing ? 'Done' : 'Edit'}</Text></Pressable></View>
            <View onLayout={({ nativeEvent: { layout } }) => { pinBounds.current.rowsY = layout.y; }} style={{ minHeight: ROW_HEIGHT }}>
              {snapshot.pins.map((id, index) => <SidebarDragRow key={id} title={titleFor(id)} disabled={snapshot.pinBusy} handle={editing && !snapshot.pinBusy}
                order={{ index, count: snapshot.pins.length }}
                style={[styles.row, { opacity: drag?.id === id ? 0.35 : 1, backgroundColor: (snapshot.tabId === id || snapshot.canvasId === id) ? colors.selected : 'transparent' }]}
                destinationStyle={styles.destination} onOpen={() => action({ type: 'open', id, pinned: true }, true)}
                onStart={(x, y) => startDrag(id, x, y)} onMove={move} onEnd={finishDrag} onCancel={() => updateDrag(null)}
                onEarlier={index > 0 ? () => { action({ type: 'reorder', ids: movePin(snapshot.pins, index, index - 1) }); AccessibilityInfo.announceForAccessibility(`Moved to tab ${index + 1}`); } : undefined}
                onLater={index < snapshot.pins.length - 1 ? () => { action({ type: 'reorder', ids: movePin(snapshot.pins, index, index + 1) }); AccessibilityInfo.announceForAccessibility(`Moved to tab ${index + 3}`); } : undefined}
                controls={editing ? iconButton('remove', `Unpin ${titleFor(id)}`, () => action({ type: 'pin', id, pinned: false }), snapshot.pinBusy) : null}>
                <CanvasIcon canvas={snapshot.canvases.find((canvas) => canvas.id === id)} size={21} /><Text numberOfLines={1} style={[styles.title, { color: colors.text }]}>{titleFor(id)}</Text>
              </SidebarDragRow>)}
              {snapshot.pins.length === 0 && <Text style={[styles.hint, { color: colors.muted }]}>Hold a canvas and drag it here to pin it.</Text>}
              {drag?.target?.section === 'pins' && <View pointerEvents="none" style={{ position: 'absolute', top: drag.target.index * ROW_HEIGHT, left: 12, right: 12, height: 2, backgroundColor: colors.accent }} />}
            </View>
          </View>
          {editing && <Text style={[styles.hint, { color: colors.muted }]}>Drag a canvas into or out of Pinned, or use the buttons. Home always stays first.</Text>}
          {snapshot.pins.length > VISIBLE_PIN_COUNT && <Text style={[styles.hint, { color: colors.muted }]}>Your first four pins appear in the bottom bar. All pins remain here.</Text>}
          {(notice || snapshot.pinError) && <Text accessibilityRole="alert" style={[styles.hint, { color: colors.error }]}>{notice ?? snapshot.pinError}</Text>}
          <View style={[styles.divider, { backgroundColor: colors.line }]} />
          <View onLayout={({ nativeEvent: { layout } }) => { canvasBounds.current = { y: layout.y, height: layout.height }; }} style={{ backgroundColor: drag?.target?.section === 'canvases' && snapshot.pins.includes(drag.id) ? colors.selected : 'transparent', borderRadius: 13, minHeight: ROW_HEIGHT * 2 }}>
            <View style={styles.section}><Text style={[styles.label, { color: colors.muted }]}>CANVASES</Text>{editing && <Text style={[styles.count, { color: colors.muted }]}>{snapshot.pins.length} pinned</Text>}</View>
            {unpinned.map((canvas) => <SidebarDragRow key={canvas.id} title={canvas.title} disabled={snapshot.pinBusy} handle={false}
              style={[styles.row, { opacity: drag?.id === canvas.id ? 0.35 : 1 }, snapshot.canvasId === canvas.id && { backgroundColor: colors.selected }]}
              destinationStyle={styles.destination} onOpen={() => action({ type: 'open', id: canvas.id, pinned: false }, true)}
              onStart={(x, y) => startDrag(canvas.id, x, y)} onMove={move} onEnd={finishDrag} onCancel={() => updateDrag(null)}
              controls={editing ? iconButton('add', `Pin ${canvas.title}`, () => pin(canvas.id), snapshot.pinBusy) : null}>
              <CanvasIcon canvas={canvas} size={21} /><Text numberOfLines={1} style={[styles.title, { color: colors.text }]}>{canvas.title}</Text>
            </SidebarDragRow>)}
            {unpinned.length === 0 && snapshot.pins.length > 0 && <Text style={[styles.hint, { color: colors.muted }]}>Drag a pinned canvas here to unpin it.</Text>}
          </View>
          {snapshot.directoryError && <View><Text accessibilityRole="alert" style={[styles.hint, { color: colors.error }]}>Your canvases couldn’t refresh.</Text><Pressable style={styles.destination} accessibilityRole="button" onPress={() => action({ type: 'refresh' })}><Text style={{ color: colors.text }}>Try again</Text></Pressable></View>}
          {!snapshot.loading && !snapshot.directoryError && snapshot.canvases.length === 0 && <Text style={[styles.hint, { color: colors.muted }]}>Your first canvas starts with an idea.</Text>}
          {snapshot.loading && <Text style={[styles.hint, { color: colors.muted }]}>Loading canvases…</Text>}
          {snapshot.hasMore && <Pressable style={styles.destination} accessibilityRole="button" onPress={() => action({ type: 'load-more' })}><Text style={{ color: colors.accent }}>Load more canvases</Text></Pressable>}
          <Pressable style={styles.destination} accessibilityRole="button" accessibilityLabel="Create a canvas" onPress={() => action({ type: 'create' }, true)}><Ionicons name="add-circle-outline" size={21} color={colors.accent} /><Text style={[styles.title, { color: colors.accent }]}>Create a canvas</Text></Pressable>
        </ScrollView>
        </View>
        <View style={[styles.footer, { borderTopColor: colors.line }]}>
          <View style={[styles.avatar, { backgroundColor: colors.tonal }]}><Text style={{ color: colors.text }}>{snapshot.userName.slice(0, 1).toUpperCase()}</Text></View>
          <Pressable accessibilityRole="button" accessibilityLabel="Switch organization" onPress={() => action({ type: 'switch-workspace' }, true)} style={{ flex: 1, minHeight: 48, justifyContent: 'center' }}><Text numberOfLines={1} style={{ color: colors.text, fontWeight: '600' }}>{snapshot.userName}</Text><Text numberOfLines={1} style={{ color: colors.muted, fontSize: 11, marginTop: 3 }}>{snapshot.workspaceName} · Switch</Text></Pressable>
          {diagnostics && iconButton('settings-outline', 'Settings and diagnostics', () => { close(); diagnostics(); })}
          {iconButton('log-out-outline', 'Sign out', () => action({ type: 'sign-out' }, true))}
        </View>
      </Animated.View>
      {drag && <Animated.View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={[styles.row, { position: 'absolute', left: viewportBounds.current.x, top: 0, transform: [{ translateY: dragY }], width: viewportBounds.current.width, paddingHorizontal: 12, gap: 12, backgroundColor: colors.surface, boxShadow: '0 5px 18px rgba(0, 0, 0, 0.18)' }]}>
        <CanvasIcon canvas={snapshot.canvases.find((canvas) => canvas.id === drag.id)} size={21} /><Text numberOfLines={1} style={[styles.title, { color: colors.text }]}>{titleFor(drag.id)}</Text>
      </Animated.View>}
    </View>
  </Modal>;
}
const styles = StyleSheet.create({
  overlay: { flex: 1 }, drawer: { height: '100%', borderTopRightRadius: 24, borderBottomRightRadius: 24, paddingHorizontal: 14 },
  heading: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingLeft: 12, marginBottom: 12 },
  brand: { fontSize: 24, fontWeight: '600', letterSpacing: -0.8 }, section: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingLeft: 12, minHeight: 44, marginTop: 8 },
  label: { fontSize: 10, fontWeight: '500', letterSpacing: 1.3 }, edit: { padding: 12, minWidth: 48 },
  row: { height: ROW_HEIGHT, flexDirection: 'row', alignItems: 'center', borderRadius: 13 },
  destination: { flex: 1, minHeight: ROW_HEIGHT, flexDirection: 'row', gap: 12, alignItems: 'center', paddingHorizontal: 12 },
  title: { flex: 1, fontSize: 14.5 }, control: { width: 48, height: 48, justifyContent: 'center', alignItems: 'center' },
  count: { fontSize: 11, paddingRight: 12 },
  hint: { padding: 12, fontSize: 12, lineHeight: 19 }, divider: { height: 1, marginHorizontal: 12, marginTop: 22, marginBottom: 8 },
  footer: { borderTopWidth: 1, paddingTop: 12, marginTop: 12, flexDirection: 'row', alignItems: 'center', gap: 10 }, avatar: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
});
