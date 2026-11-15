import { Pressable, StyleSheet, View } from 'react-native';
import { MessageCircle, PanelLeft } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Glass } from './Glass';
import { useTheme } from './theme';

export type FloatingHeaderActions = { menu: () => void; chat: () => void };

/** The sidebar and chat buttons, drawn over an artifact in place of the native
 * header. iOS 26 fades content under a native navigation bar in the app's own
 * appearance, a white band over a dark site; without a bar there is no fade. */
export function FloatingHeader({ actions, tone }: { actions: FloatingHeaderActions; tone?: 'light' | 'dark' }) {
  const { colors } = useTheme();
  // Over the artifact, the buttons take the status bar's tone: light glyphs on
  // dark glass over a dark page, dark on light over a light one.
  const scheme = tone === 'light' ? 'dark' : tone === 'dark' ? 'light' : undefined;
  const ink = tone === 'light' ? '#ffffff' : tone === 'dark' ? '#111111' : colors.text;
  const insets = useSafeAreaInsets();
  return <View pointerEvents="box-none" style={[styles.bar, { top: insets.top, left: insets.left + 16, right: insets.right + 16 }]}>
    <Pressable accessibilityRole="button" accessibilityLabel="Open sidebar" onPress={actions.menu} hitSlop={6}>
      <Glass scheme={scheme} style={styles.button}><PanelLeft size={22} color={ink} /></Glass>
    </Pressable>
    <Pressable accessibilityRole="button" accessibilityLabel="Open conversation" onPress={actions.chat} hitSlop={6}>
      <Glass scheme={scheme} style={styles.button}><MessageCircle size={22} color={ink} /></Glass>
    </Pressable>
  </View>;
}

const styles = StyleSheet.create({
  bar: { position: 'absolute', height: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  button: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
});
