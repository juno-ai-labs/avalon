import { Children, Fragment, isValidElement, type ReactNode } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { ChevronRight, type LucideIcon } from 'lucide-react-native';
import { useTheme } from './theme';

/**
 * An inset grouped list, the shape of the platform's own Settings: rows on
 * rounded cards, a small heading above each card and a note below it. Settings
 * and Diagnostics are built from these two pieces and nothing else.
 */
export function SettingsGroup({ title, footer, children }: { title?: string; footer?: string; children: ReactNode }) {
  const { colors } = useTheme();
  const rows = Children.toArray(children).filter(Boolean);
  if (rows.length === 0) return null;
  // Separators start where the text does, past any row's icon.
  const inset = rows.some((row) => isValidElement<RowProps>(row) && row.props.icon) ? ICON_INSET : 16;
  return <View style={styles.group}>
    {title && <Text accessibilityRole="header" style={[styles.heading, { color: colors.muted }]}>{title}</Text>}
    {/* The web Settings pages' cards: the subtle surface on the canvas. */}
    <View style={[styles.card, { backgroundColor: colors.tonal }]}>
      {rows.map((row, index) => <Fragment key={index}>
        {index > 0 && <View style={[styles.separator, { marginLeft: inset, backgroundColor: colors.line }]} />}
        {row}
      </Fragment>)}
    </View>
    {footer && <Text style={[styles.footer, { color: colors.muted }]}>{footer}</Text>}
  </View>;
}

type RowProps = {
  label: string;
  icon?: LucideIcon;
  /** The current state, drawn at the row's end, as "Allowed" or "1.4.0". */
  value?: string;
  /** A second line under the label. */
  detail?: string;
  onPress?: () => void;
  /** Opens another page, so the row ends in a chevron. */
  navigates?: boolean;
  destructive?: boolean;
  disabled?: boolean;
};

export function SettingsRow({ label, icon: Icon, value, detail, onPress, navigates = false, destructive = false, disabled = false }: RowProps) {
  const { colors } = useTheme();
  const ink = destructive ? colors.error : colors.text;
  const content = <>
    {Icon && <View style={styles.icon}><Icon size={20} color={ink} strokeWidth={1.8} /></View>}
    <View style={styles.copy}>
      <Text style={[styles.label, { color: ink }, destructive && !Icon && styles.centered]}>{label}</Text>
      {detail && <Text style={[styles.detail, { color: colors.muted }]}>{detail}</Text>}
    </View>
    {value && <Text numberOfLines={1} style={[styles.value, { color: colors.muted }]}>{value}</Text>}
    {navigates && <ChevronRight size={18} color={colors.muted} />}
  </>;
  if (!onPress) return <View accessible accessibilityLabel={value ? `${label}, ${value}` : label} style={styles.row}>{content}</View>;
  return <Pressable accessibilityRole="button" accessibilityLabel={value ? `${label}, ${value}` : label}
    accessibilityState={{ disabled }} disabled={disabled} onPress={onPress}
    android_ripple={{ color: colors.selected }}
    style={({ pressed }) => [styles.row, { opacity: disabled ? 0.45 : 1, backgroundColor: pressed && Platform.OS === 'ios' ? colors.selected : 'transparent' }]}>
    {content}
  </Pressable>;
}

const ICON_SIZE = 24;
const ICON_INSET = 16 + ICON_SIZE + 12;
const styles = StyleSheet.create({
  group: { marginBottom: 28 },
  heading: { fontSize: 13, fontWeight: '500', textTransform: 'uppercase', letterSpacing: 0.4, marginLeft: 16, marginBottom: 7 },
  card: { borderRadius: 14, overflow: 'hidden' },
  separator: { height: StyleSheet.hairlineWidth },
  footer: { fontSize: 13, lineHeight: 18, marginHorizontal: 16, marginTop: 7 },
  row: { minHeight: 50, flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 10 },
  icon: { width: ICON_SIZE, alignItems: 'center' },
  copy: { flex: 1, minWidth: 0 },
  label: { fontSize: 17 },
  centered: { textAlign: 'center' },
  detail: { fontSize: 13, lineHeight: 18, marginTop: 2 },
  value: { fontSize: 17, maxWidth: '45%' },
});
