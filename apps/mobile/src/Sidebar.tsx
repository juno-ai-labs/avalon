import { CanvasIcon } from './CanvasIcon';
import { useEffect, useRef, useState, type ComponentRef } from 'react';
import { AccessibilityInfo, Modal, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { movePin, VISIBLE_PIN_COUNT, type MobileCommand, type MobileSnapshot } from './protocol';
import { useTheme } from './theme';
import { SidebarDragRow } from './SidebarDragRow';
import { sidebarDropCommand, type SidebarDrop } from './sidebar-drop';

type IconName = React.ComponentProps<typeof Ionicons>['name'];
interface Props {
  diagnostics?: () => void;
  visible: boolean;
  snapshot: MobileSnapshot;
  close: () => void;
  send: (command: MobileCommand) => void;
}

interface DragState { id: string; x: number; y: number; target: SidebarDrop | null }
interface Bounds { x: number; y: number; width: number; height: number }

const ROW_HEIGHT = 52;
export function Sidebar({ visible, snapshot, close, send, diagnostics }: Props) {
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
  const updateDrag = (value: DragState | null) => { dragRef.current = value; setDrag(value); };
  const dragging = drag !== null;
  const pinKey = JSON.stringify(snapshot.pins);
  useEffect(() => { dragRef.current = null; setDrag(null); }, [visible, snapshot.userId, snapshot.workspaceId, pinKey]);
  useEffect(() => { if (!visible) { setEditing(false); setNotice(null); } }, [visible]);
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
      const next = Math.max(0, Math.min(Math.max(0, contentHeight.current - bounds.height), scrollY.current + direction * ROW_HEIGHT * 8 * elapsed));
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
  return <Modal transparent visible={visible} animationType="fade" onRequestClose={close}>
    <View style={[styles.overlay, { backgroundColor: colors.scrim }]}>
      <Pressable style={StyleSheet.absoluteFill} accessibilityLabel="Close sidebar" accessibilityRole="button" onPress={close} />
      <View accessibilityViewIsModal style={[styles.drawer, { width: Math.min(width - insets.right - 44, 336 + insets.left), paddingLeft: 14 + insets.left, paddingTop: insets.top + 12, paddingBottom: insets.bottom + 12, backgroundColor: colors.sidebar }]}>
        <View style={styles.heading}><Text style={[styles.brand, { color: colors.text }]}>Rally</Text>{iconButton('menu-outline', 'Close sidebar', close)}</View>
        <View ref={viewport} style={{ flex: 1 }} onLayout={() => viewport.current?.measureInWindow((x, y, width, height) => { viewportBounds.current = { x, y, width, height }; })}>
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
                style={[styles.row, { opacity: drag?.id === id ? 0.35 : 1, backgroundColor: snapshot.tabId === id ? colors.selected : 'transparent' }]}
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
          <View onLayout={({ nativeEvent: { layout } }) => { canvasBounds.current = { y: layout.y, height: layout.height }; }} style={{ backgroundColor: drag?.target?.section === 'canvases' ? colors.selected : 'transparent', borderRadius: 13, minHeight: ROW_HEIGHT * 2 }}>
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
      </View>
      {drag && <View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={[styles.row, { position: 'absolute', left: viewportBounds.current.x, top: drag.y - ROW_HEIGHT / 2, width: viewportBounds.current.width, paddingHorizontal: 12, gap: 12, backgroundColor: colors.surface, boxShadow: '0 5px 18px rgba(0, 0, 0, 0.18)' }]}>
        <CanvasIcon canvas={snapshot.canvases.find((canvas) => canvas.id === drag.id)} size={21} /><Text numberOfLines={1} style={[styles.title, { color: colors.text }]}>{titleFor(drag.id)}</Text>
      </View>}
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
