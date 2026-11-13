import { CanvasIcon } from './CanvasIcon';
import { useEffect, useMemo, useRef, useState } from 'react';
import { AccessibilityInfo, Modal, PanResponder, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { movePin, VISIBLE_PIN_COUNT, type MobileCommand, type MobileSnapshot } from './protocol';
import { useTheme } from './theme';

type IconName = React.ComponentProps<typeof Ionicons>['name'];
interface Props {
  diagnostics?: () => void;
  visible: boolean;
  snapshot: MobileSnapshot;
  close: () => void;
  send: (command: MobileCommand) => void;
}

interface DragState { id: string; from: number; to: number; dy: number }
function ReorderHandle({ id, title, ids, onReorder, onDrag }: { id: string; title: string; ids: string[]; onReorder: (ids: string[]) => void; onDrag: (state: DragState | null) => void }) {
  const { colors } = useTheme();
  const latest = useRef({ id, ids, onReorder, onDrag });
  latest.current = { id, ids, onReorder, onDrag };
  const [dragging, setDragging] = useState(false);
  const responder = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderGrant: () => {
      setDragging(true);
      const current = latest.current;
      const from = current.ids.indexOf(current.id);
      current.onDrag({ id: current.id, from, to: from, dy: 0 });
    },
    onPanResponderTerminationRequest: () => false,
    onPanResponderMove: (_, gesture) => {
      const current = latest.current;
      const from = current.ids.indexOf(current.id);
      const dy = Math.max(-from * ROW_HEIGHT, Math.min((current.ids.length - from - 1) * ROW_HEIGHT, gesture.dy));
      current.onDrag({ id: current.id, from, to: from + Math.round(dy / ROW_HEIGHT), dy });
    },
    onPanResponderRelease: (_, gesture) => {
      setDragging(false);
      latest.current.onDrag(null);
      const current = latest.current;
      const from = current.ids.indexOf(current.id);
      const to = Math.max(0, Math.min(current.ids.length - 1, from + Math.round(gesture.dy / ROW_HEIGHT)));
      if (from !== to) current.onReorder(movePin(current.ids, from, to));
    },
    onPanResponderTerminate: () => { setDragging(false); latest.current.onDrag(null); },
  }), []);
  return <View {...responder.panHandlers} accessible accessibilityRole="adjustable"
    accessibilityLabel={`Reorder ${title}`} accessibilityValue={{ min: 1, max: ids.length, now: ids.indexOf(id) + 1, text: `Pinned tab ${ids.indexOf(id) + 1} of ${ids.length}` }} accessibilityHint="Drag up or down, or use the move actions"
    accessibilityActions={[{ name: 'increment', label: 'Move later' }, { name: 'decrement', label: 'Move earlier' }]}
    onAccessibilityAction={(event) => {
      const from = ids.indexOf(id);
      const to = from + (event.nativeEvent.actionName === 'increment' ? 1 : -1);
      if (to >= 0 && to < ids.length) {
        onReorder(movePin(ids, from, to));
        AccessibilityInfo.announceForAccessibility(`Moved to tab ${to + 2}`);
      }
    }} style={[styles.control, { backgroundColor: dragging ? colors.selected : 'transparent', borderRadius: 12 }]}>
    <Ionicons name="reorder-two" size={22} color={colors.muted} />
  </View>;
}

const ROW_HEIGHT = 52;
export function Sidebar({ visible, snapshot, close, send, diagnostics }: Props) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const [editing, setEditing] = useState(false);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => { if (!visible) { setEditing(false); setNotice(null); setDrag(null); } }, [visible]);
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
        <ScrollView scrollEnabled={drag === null} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled" style={{ flex: 1 }}>
          <View style={styles.section}><Text style={[styles.label, { color: colors.muted }]}>TABS</Text><Pressable accessibilityRole="button" accessibilityLabel={editing ? 'Done editing tabs' : 'Edit tabs'} onPress={() => setEditing(!editing)} style={styles.edit}><Text style={{ color: colors.accent }}>{editing ? 'Done' : 'Edit'}</Text></Pressable></View>
          <View style={[styles.row, { backgroundColor: snapshot.view === 'home' ? colors.selected : 'transparent' }]}>
            <Pressable style={styles.destination} accessibilityRole="button" accessibilityLabel="Home" onPress={() => action({ type: 'home' }, true)}><Ionicons name="home-outline" size={21} color={colors.text} /><Text style={[styles.title, { color: colors.text }]}>Home</Text></Pressable>
            {editing && <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={styles.control}><Ionicons name="lock-closed-outline" size={14} color={colors.muted} /></View>}
          </View>
          {snapshot.pins.map((id, index) => <View key={id} style={[styles.row, {
            backgroundColor: drag?.id === id ? colors.surface : snapshot.tabId === id ? colors.selected : 'transparent',
            zIndex: drag?.id === id ? 1 : 0,
            transform: [{ translateY: drag?.id === id ? drag.dy : drag && index > drag.from && index <= drag.to ? -ROW_HEIGHT : drag && index < drag.from && index >= drag.to ? ROW_HEIGHT : 0 }],
            boxShadow: drag?.id === id ? '0 5px 18px rgba(0, 0, 0, 0.12)' : 'none',
          }]}>
            <Pressable style={styles.destination} accessibilityRole="button" onPress={() => action({ type: 'open', id, pinned: true }, true)}><CanvasIcon canvas={snapshot.canvases.find((canvas) => canvas.id === id)} size={21} /><Text numberOfLines={1} style={[styles.title, { color: colors.text }]}>{titleFor(id)}</Text></Pressable>
            {editing && <>{iconButton('remove', `Unpin ${titleFor(id)}`, () => action({ type: 'pin', id, pinned: false }), snapshot.pinBusy)}{!snapshot.pinBusy && <ReorderHandle id={id} title={titleFor(id)} ids={snapshot.pins} onDrag={setDrag} onReorder={(ids) => action({ type: 'reorder', ids })} />}</>}
          </View>)}
          {editing && <Text style={[styles.hint, { color: colors.muted }]}>Drag the handles to change tab order. Home always stays first.</Text>}
          {snapshot.pins.length > VISIBLE_PIN_COUNT && <Text style={[styles.hint, { color: colors.muted }]}>Your first four pins appear in the bottom bar. All pins remain here.</Text>}
          {(notice || snapshot.pinError) && <Text accessibilityRole="alert" style={[styles.hint, { color: colors.error }]}>{notice ?? snapshot.pinError}</Text>}
          <View style={[styles.divider, { backgroundColor: colors.line }]} />
          <View style={styles.section}><Text style={[styles.label, { color: colors.muted }]}>CANVASES</Text>{editing && <Text style={[styles.count, { color: colors.muted }]}>{snapshot.pins.length} pinned</Text>}</View>
          {snapshot.canvases.map((canvas) => <View key={canvas.id} style={[styles.row, snapshot.canvasId === canvas.id && { backgroundColor: colors.selected }]}>
            <Pressable style={styles.destination} accessibilityRole="button" onPress={() => action({ type: 'open', id: canvas.id, pinned: snapshot.pins.includes(canvas.id) }, true)}><CanvasIcon canvas={canvas} size={21} /><Text numberOfLines={1} style={[styles.title, { color: colors.text }]}>{canvas.title}</Text></Pressable>
            {snapshot.pins.includes(canvas.id) ? <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={styles.control}><Ionicons name="pin-outline" size={14} color={colors.muted} /></View> : editing ? iconButton('add', `Pin ${canvas.title}`, () => pin(canvas.id), snapshot.pinBusy) : null}
          </View>)}
          {snapshot.directoryError && <View><Text accessibilityRole="alert" style={[styles.hint, { color: colors.error }]}>Your canvases couldn’t refresh.</Text><Pressable style={styles.destination} accessibilityRole="button" onPress={() => action({ type: 'refresh' })}><Text style={{ color: colors.text }}>Try again</Text></Pressable></View>}
          {!snapshot.loading && !snapshot.directoryError && snapshot.canvases.length === 0 && <Text style={[styles.hint, { color: colors.muted }]}>Your first canvas starts with an idea.</Text>}
          {snapshot.loading && <Text style={[styles.hint, { color: colors.muted }]}>Loading canvases…</Text>}
          {snapshot.hasMore && <Pressable style={styles.destination} accessibilityRole="button" onPress={() => action({ type: 'load-more' })}><Text style={{ color: colors.accent }}>Load more canvases</Text></Pressable>}
          <Pressable style={styles.destination} accessibilityRole="button" accessibilityLabel="Create a canvas" onPress={() => action({ type: 'create' }, true)}><Ionicons name="add-circle-outline" size={21} color={colors.accent} /><Text style={[styles.title, { color: colors.accent }]}>Create a canvas</Text></Pressable>
        </ScrollView>
        <View style={[styles.footer, { borderTopColor: colors.line }]}>
          <View style={[styles.avatar, { backgroundColor: colors.tonal }]}><Text style={{ color: colors.text }}>{snapshot.userName.slice(0, 1).toUpperCase()}</Text></View>
          <Pressable accessibilityRole="button" accessibilityLabel="Switch organization" onPress={() => action({ type: 'switch-workspace' }, true)} style={{ flex: 1, minHeight: 48, justifyContent: 'center' }}><Text numberOfLines={1} style={{ color: colors.text, fontWeight: '600' }}>{snapshot.userName}</Text><Text numberOfLines={1} style={{ color: colors.muted, fontSize: 11, marginTop: 3 }}>{snapshot.workspaceName} · Switch</Text></Pressable>
          {diagnostics && iconButton('settings-outline', 'Settings and diagnostics', () => { close(); diagnostics(); })}
          {iconButton('log-out-outline', 'Sign out', () => action({ type: 'sign-out' }, true))}
        </View>
      </View>
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
