import { useMemo, useState } from 'react';
import { FlatList, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { ArrowUpRight, FileText, Plus, Search, Sparkles } from 'lucide-react-native';
import type { CanvasSummary } from './protocol';
import { useTheme } from './theme';

/** Card tints, matching the browser host's mobile dashboard (apps/browser/src/mobile.css). */
const CARD = {
  light: { ink: '#283d2d', tints: ['#e3ebdb', '#e8e3d7', '#dfe9dc', '#e1e5eb'], hero: '#5f8268' },
  dark: { ink: '#edf3e8', tints: ['#304332', '#443d30', '#2d4033', '#303b46'], hero: '#3d5541' },
};

type Props = {
  canvases: CanvasSummary[];
  /** No directory yet: neither a saved copy nor Home's first snapshot. */
  loading: boolean;
  /** Home could not load; the saved list still shows, with a retry. */
  failed: boolean;
  topInset: number;
  bottomInset: number;
  open: (id: string) => void;
  create: () => void;
  retry: () => void;
};

/** The Home dashboard, drawn natively from the directory so it shows on the first
 * frame from the saved copy, without waiting for Home's web page to boot. */
export function Dashboard({ canvases, loading, failed, topInset, bottomInset, open, create, retry }: Props) {
  const { colors, isDark } = useTheme();
  const card = isDark ? CARD.dark : CARD.light;
  const [query, setQuery] = useState('');
  const filtered = useMemo(() => {
    const needle = query.toLocaleLowerCase();
    return needle ? canvases.filter((canvas) => canvas.title.toLocaleLowerCase().includes(needle)) : canvases;
  }, [canvases, query]);
  const [hero, ...rest] = filtered;
  // A two-column list stretches a lone last card across the row; pad it as the web grid does.
  const cells: (CanvasSummary | null)[] = rest.length % 2 === 1 ? [...rest, null] : rest;
  const header = <View>
    <Text style={[styles.eyebrow, { color: colors.muted }]}>A LITTLE SPACE FOR EVERYTHING</Text>
    <Text accessibilityRole="header" style={[styles.title, { color: colors.text }]}>Your canvases</Text>
    <View style={[styles.search, { backgroundColor: colors.tonal }]}>
      <Search size={19} color={colors.muted} />
      <TextInput accessibilityLabel="Find a canvas" placeholder="Find a canvas" placeholderTextColor={colors.muted} value={query} onChangeText={setQuery}
        autoCorrect={false} returnKeyType="search" style={[styles.searchInput, { color: colors.text }]} />
    </View>
    {failed && <View style={[styles.notice, { backgroundColor: colors.tonal }]}>
      <Text style={{ color: colors.muted, flex: 1 }}>Rally couldn’t refresh. Showing your saved canvases.</Text>
      <Pressable accessibilityRole="button" onPress={retry} hitSlop={8}><Text style={{ color: colors.text, fontWeight: '600' }}>Try again</Text></Pressable>
    </View>}
    {loading ? <View style={[styles.skeleton, { backgroundColor: colors.tonal }]}><Text style={{ color: colors.muted }}>Loading your canvases…</Text></View>
      : filtered.length > 0 && <>
        <View style={styles.sectionHeading}>
          <Text style={[styles.sectionTitle, { color: colors.text }]}>{query ? 'Search results' : 'Pick up where you left off'}</Text>
          <Text style={{ color: colors.muted, fontSize: 11 }}>{filtered.length} {filtered.length === 1 ? 'canvas' : 'canvases'}</Text>
        </View>
        {hero && <CanvasCard canvas={hero} hero background={card.hero} ink="#ffffff" open={open} />}
      </>}
  </View>;
  const empty = loading ? null : <View style={styles.empty}>
    <Sparkles size={32} color={colors.text} />
    <Text style={[styles.emptyTitle, { color: colors.text }]}>{query ? 'No canvases found' : 'Make room for an idea.'}</Text>
    <Text style={[styles.emptyBody, { color: colors.muted }]}>{query ? 'Try another name.' : 'Create a plan, a little tool, or something just for you.'}</Text>
    {!query && <Pressable accessibilityRole="button" onPress={create} style={[styles.primary, { backgroundColor: colors.text }]}>
      <Plus size={18} color={colors.onAccent} /><Text style={{ color: colors.onAccent, fontSize: 14 }}>Create a canvas</Text>
    </Pressable>}
  </View>;
  return <FlatList
    data={cells}
    keyExtractor={(canvas) => canvas?.id ?? 'spacer'}
    numColumns={2}
    columnWrapperStyle={styles.row}
    ListHeaderComponent={header}
    ListEmptyComponent={filtered.length === 0 && empty ? empty : undefined}
    renderItem={({ item, index }) => item ? <CanvasCard canvas={item} background={card.tints[(index + 1) % card.tints.length]!} ink={card.ink} open={open} /> : <View style={styles.cell} />}
    keyboardShouldPersistTaps="handled"
    keyboardDismissMode="on-drag"
    contentInsetAdjustmentBehavior="never"
    contentContainerStyle={{ paddingTop: topInset + 25, paddingBottom: bottomInset + 36, paddingHorizontal: 24 }}
    style={{ backgroundColor: colors.background }}
    initialNumToRender={8}
  />;
}

function CanvasCard({ canvas, hero = false, background, ink, open }: { canvas: CanvasSummary; hero?: boolean; background: string; ink: string; open: (id: string) => void }) {
  const title = canvas.title || 'Untitled canvas';
  return <Pressable accessibilityRole="button" accessibilityLabel={`Open ${title}`} onPress={() => open(canvas.id)}
    style={({ pressed }) => [styles.card, hero ? styles.hero : styles.cell, { backgroundColor: background, opacity: pressed ? 0.8 : 1 }]}>
    <View style={[styles.art, hero && styles.heroArt]}><FileText size={hero ? 50 : 32} strokeWidth={1} color={ink} /></View>
    <Text numberOfLines={hero ? 3 : 4} style={[hero ? styles.heroTitle : styles.cardTitle, { color: ink }]}>{title}</Text>
    <View style={styles.cardFooter}><Text style={[styles.cardHint, { color: ink }]}>Open canvas</Text><ArrowUpRight size={14} color={ink} style={{ opacity: 0.75 }} /></View>
  </Pressable>;
}

const styles = StyleSheet.create({
  eyebrow: { fontSize: 10, letterSpacing: 1.7, marginBottom: 12 },
  title: { fontSize: 34, fontWeight: '600', letterSpacing: -1.4, marginBottom: 23 },
  search: { flexDirection: 'row', alignItems: 'center', gap: 10, borderRadius: 15, paddingHorizontal: 15, paddingVertical: 11, marginBottom: 28 },
  searchInput: { flex: 1, fontSize: 15, paddingVertical: 2 },
  notice: { flexDirection: 'row', alignItems: 'center', gap: 12, borderRadius: 15, padding: 14, marginBottom: 20 },
  skeleton: { borderRadius: 20, paddingVertical: 60, paddingHorizontal: 25 },
  sectionHeading: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 15, gap: 12 },
  sectionTitle: { fontSize: 12, fontWeight: '600' },
  row: { gap: 13, marginBottom: 13 },
  card: { borderRadius: 20, padding: 18, overflow: 'hidden' },
  cell: { flex: 1, minHeight: 176 },
  hero: { minHeight: 220, marginBottom: 13 },
  art: { height: 76, alignItems: 'center', justifyContent: 'center', opacity: 0.55 },
  heroArt: { height: 107 },
  cardTitle: { fontSize: 16, fontWeight: '500', lineHeight: 21, marginTop: 12, marginBottom: 8, flexGrow: 1 },
  heroTitle: { fontSize: 29, lineHeight: 33, letterSpacing: -0.7, fontFamily: Platform.select({ ios: 'Georgia', default: 'serif' }), marginTop: 12, marginBottom: 8 },
  cardFooter: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  cardHint: { fontSize: 11, opacity: 0.75 },
  empty: { alignItems: 'center', justifyContent: 'center', paddingVertical: 60, paddingHorizontal: 35, gap: 14 },
  emptyTitle: { fontSize: 22, lineHeight: 29, fontWeight: '600', textAlign: 'center' },
  emptyBody: { fontSize: 14, lineHeight: 22, textAlign: 'center' },
  primary: { flexDirection: 'row', alignItems: 'center', gap: 9, borderRadius: 24, minHeight: 48, paddingVertical: 12, paddingHorizontal: 23 },
});
