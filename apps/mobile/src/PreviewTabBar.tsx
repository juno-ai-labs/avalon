import { useState } from 'react';
import { CanvasIcon } from './CanvasIcon';
import { Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { House } from 'lucide-react-native';
import { Glass } from './Glass';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { EXPANDED_LAYOUT_WIDTH, FLOATING_HEADER_INSET } from './layout';
import { VISIBLE_PIN_COUNT, type MobileCommand, type MobileSnapshot } from './protocol';
import { useTheme } from './theme';

// Reference proportions on a 390-point handset: 338 × 60, with 24-point icons.
export const TAB_BAR_HEIGHT = 60;
export const TAB_BAR_SPACE = TAB_BAR_HEIGHT + 16;
export const TAB_RAIL_SPACE = TAB_BAR_HEIGHT + 32;

/** One custom floating bar on both platforms. Only its surface material adapts. */
export function TabBar({ snapshot, bottomInset, send }: {
  snapshot: MobileSnapshot;
  bottomInset: number;
  send: (command: MobileCommand) => void;
}) {
  const { colors } = useTheme();
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const usableWidth = width - insets.left - insets.right;
  const expanded = usableWidth >= EXPANDED_LAYOUT_WIDTH;
  const [label, setLabel] = useState<string | null>(null);
  const tabs = [
    { id: null, title: 'Home' },
    ...snapshot.pins.slice(0, VISIBLE_PIN_COUNT).map((id) => ({
      id, title: snapshot.canvases.find((canvas) => canvas.id === id)?.title ?? 'Canvas',
    })),
  ];
  const barLength = Math.min(expanded ? height - insets.top - insets.bottom - FLOATING_HEADER_INSET - 32 : usableWidth - 52, tabs.length * 68 + 8);
  return <View pointerEvents="box-none" style={expanded
    ? [styles.rail, { left: insets.left + 16, top: insets.top + FLOATING_HEADER_INSET, bottom: bottomInset + 16 }]
    : [styles.dock, { left: insets.left, right: insets.right, bottom: bottomInset + 8 }]}>
    {label && <View pointerEvents="none" style={[styles.tooltip, expanded ? { left: TAB_BAR_HEIGHT + 8, width: 220 } : { bottom: TAB_BAR_HEIGHT + 8, maxWidth: '90%' }, { backgroundColor: colors.surface, borderColor: colors.line }]}><Text style={{ color: colors.text }}>{label}</Text></View>}
    <Glass style={[styles.surface, expanded ? { width: TAB_BAR_HEIGHT, height: barLength, flexDirection: 'column' } : { width: barLength }]}>
      {tabs.map((tab) => {
        const selected = snapshot.tabId === tab.id;
        const canvas = snapshot.canvases.find((item) => item.id === tab.id);
        return <Pressable key={tab.id ?? 'home'} accessibilityRole="tab" accessibilityLabel={tab.title}
          accessibilityState={{ selected }} aria-selected={selected}
          onLongPress={() => setLabel(tab.title)} onPressOut={() => setLabel(null)}
          onPress={() => send(tab.id ? { type: 'open', id: tab.id, pinned: true } : { type: 'home' })}
          style={({ pressed }) => [styles.tab, { borderColor: selected ? colors.line : 'transparent', backgroundColor: selected ? colors.selected : pressed ? colors.tonal : 'transparent' }]}>
          {tab.id ? <CanvasIcon canvas={canvas} size={24} shaded={false} /> : <House size={24} strokeWidth={1.9} color={selected ? colors.text : colors.muted} />}
        </Pressable>;
      })}
    </Glass>
  </View>;
}
const styles = StyleSheet.create({
  tooltip: { position: 'absolute', paddingHorizontal: 14, paddingVertical: 10, borderRadius: 12, borderWidth: 1 },
  rail: { position: 'absolute', width: TAB_BAR_HEIGHT, justifyContent: 'center' },
  dock: { position: 'absolute', left: 0, right: 0, alignItems: 'center' },
  surface: { height: TAB_BAR_HEIGHT, flexDirection: 'row', gap: 0, padding: 4, borderRadius: TAB_BAR_HEIGHT / 2, overflow: 'hidden', boxShadow: '0 4px 18px rgba(0, 0, 0, 0.08)' },
  tab: { flex: 1, minHeight: 48, minWidth: 48, alignItems: 'center', justifyContent: 'center', borderRadius: 26, borderWidth: 1, paddingHorizontal: 5 },
});
