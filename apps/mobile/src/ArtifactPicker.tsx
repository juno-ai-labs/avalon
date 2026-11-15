import { useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Check, ChevronsUpDown } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { PreparedArtifact } from './protocol';
import { useTheme } from './theme';

/** A pin's artifact picker: the row under the header, and the sheet it opens.
 * Mirrors the browser host's `mobile-artifact-picker`. */
export function ArtifactPicker({ artifacts, selected, onSelect, top }: { artifacts: PreparedArtifact[]; selected: string; onSelect: (artifact: PreparedArtifact) => void; top: number }) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const [open, setOpen] = useState(false);
  const current = artifacts.find((artifact) => artifact.resourceId === selected);
  return <>
    <View style={[styles.row, { top, backgroundColor: colors.background, borderBottomColor: colors.line }]}>
      <Text style={{ color: colors.muted, fontSize: 12 }}>Artifact</Text>
      <Pressable accessibilityRole="button" accessibilityLabel={`Choose artifact, ${current?.title ?? ''}`} onPress={() => setOpen(true)}
        style={({ pressed }) => [styles.choice, { backgroundColor: colors.tonal, opacity: pressed ? 0.7 : 1 }]}>
        <Text numberOfLines={1} style={{ color: colors.text, fontSize: 14, flexShrink: 1 }}>{current?.title || 'Untitled artifact'}</Text>
        <ChevronsUpDown size={16} color={colors.muted} />
      </Pressable>
    </View>
    <Modal transparent visible={open} animationType="fade" onRequestClose={() => setOpen(false)}>
      <Pressable accessibilityLabel="Close artifact list" style={[styles.scrim, { backgroundColor: colors.scrim }]} onPress={() => setOpen(false)} />
      <View style={[styles.sheet, { backgroundColor: colors.surface, paddingBottom: insets.bottom + 12 }]}>
        <Text accessibilityRole="header" style={[styles.heading, { color: colors.text }]}>Choose artifact</Text>
        <ScrollView>
          {artifacts.map((artifact) => <Pressable key={artifact.resourceId} accessibilityRole="button" accessibilityState={{ selected: artifact.resourceId === selected }}
            onPress={() => { setOpen(false); onSelect(artifact); }} style={({ pressed }) => [styles.option, { opacity: pressed ? 0.6 : 1 }]}>
            <Text numberOfLines={1} style={{ color: colors.text, fontSize: 16, flex: 1 }}>{artifact.title || 'Untitled artifact'}</Text>
            {artifact.resourceId === selected && <Check size={18} color={colors.text} />}
          </Pressable>)}
        </ScrollView>
      </View>
    </Modal>
  </>;
}

export const ARTIFACT_PICKER_HEIGHT = 48;

const styles = StyleSheet.create({
  row: { position: 'absolute', left: 0, right: 0, height: ARTIFACT_PICKER_HEIGHT, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, gap: 12, borderBottomWidth: StyleSheet.hairlineWidth },
  choice: { flexDirection: 'row', alignItems: 'center', gap: 6, maxWidth: '75%', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 7 },
  scrim: { flex: 1 },
  sheet: { position: 'absolute', left: 0, right: 0, bottom: 0, maxHeight: '60%', borderTopLeftRadius: 18, borderTopRightRadius: 18, paddingTop: 18 },
  heading: { fontSize: 17, fontWeight: '600', paddingHorizontal: 20, paddingBottom: 8 },
  option: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 20, paddingVertical: 14 },
});
