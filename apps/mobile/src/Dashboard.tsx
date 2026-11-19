import { useMemo, useState } from 'react';
import { FlatList, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { ArrowUpRight, Plus, Search, Sparkles, Store } from 'lucide-react-native';
import { CANVAS_FILTERS, ELSEWHERE_CANVAS_FACTS, matchesCanvasFilter, type CanvasFilter } from '@rally/contracts/canvas-filters';
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg';
import { canvasGlyph } from './CanvasIcon';
import { mixOklab } from './color-mix';
import type { CanvasSummary, SharedElsewhereSummary } from './protocol';
import { useTheme } from './theme';

/** A dashboard card's Canvas: this Organization's, or one shared from another. */
type DashboardCanvas = CanvasSummary & { organization?: SharedElsewhereSummary['organization'] };

type Props = {
  canvases: CanvasSummary[];
  /** Shared with this person in their other Organizations; placed by date among `canvases`. */
  sharedElsewhere?: SharedElsewhereSummary[];
  /** No directory yet: neither a saved copy nor Home's first snapshot. */
  loading: boolean;
  /** Home could not load; the saved list still shows, with a retry. */
  failed: boolean;
  topInset: number;
  bottomInset: number;
  open: (id: string) => void;
  /** Opens a Canvas from another Organization in place, without switching to it. */
  openElsewhere: (canvas: SharedElsewhereSummary) => void;
  create: () => void;
  /** Opens the Marketplace, the create flow on its templates, in Home's page. */
  marketplace: () => void;
  retry: () => void;
};

/** The Home dashboard, drawn natively from the directory so it shows on the first
 * frame from the saved copy, without waiting for Home's web page to boot. */
export function Dashboard({ canvases, sharedElsewhere = [], loading, failed, topInset, bottomInset, open, openElsewhere, create, marketplace, retry }: Props) {
  const { colors } = useTheme();
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<CanvasFilter>('all');
  // A host older than the facts sends none: it gets no filters rather than empty
  // ones. Canvases from elsewhere carry fixed facts, so they alone still filter.
  const filterable = canvases.length + sharedElsewhere.length > 0 && canvases.every((canvas) => canvas.facts);
  const shownFilter = filterable ? filter : 'all';
  const filtered = useMemo(() => {
    // This Organization's list is already newest first; another's goes in by the same date.
    const all: DashboardCanvas[] = sharedElsewhere.length === 0 ? canvases
      : [...canvases, ...sharedElsewhere].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const needle = query.toLocaleLowerCase();
    return all.filter((canvas) => (!needle || canvas.title.toLocaleLowerCase().includes(needle))
      && (shownFilter === 'all' || matchesCanvasFilter(canvas.organization ? ELSEWHERE_CANVAS_FACTS : canvas.facts!, shownFilter)));
  }, [canvases, sharedElsewhere, query, shownFilter]);
  const narrowed = query !== '' || shownFilter !== 'all';
  const choose = (canvas: DashboardCanvas): void => {
    if (canvas.organization) openElsewhere({ ...canvas, organization: canvas.organization });
    else open(canvas.id);
  };
  const [hero, ...rest] = filtered;
  // A two-column list stretches a lone last card across the row; pad it as the web grid does.
  const cells: (DashboardCanvas | null)[] = rest.length % 2 === 1 ? [...rest, null] : rest;
  const header = <View>
    <View style={styles.heading}>
      <Text accessibilityRole="header" style={[styles.title, { color: colors.text }]}>Your canvases</Text>
      <Pressable accessibilityRole="button" onPress={marketplace} style={({ pressed }) => [styles.secondary, { backgroundColor: colors.tonal, opacity: pressed ? 0.7 : 1 }]}>
        <Store size={16} color={colors.text} /><Text style={{ color: colors.text, fontSize: 13 }}>Marketplace</Text>
      </Pressable>
    </View>
    <View style={[styles.search, { backgroundColor: colors.tonal }]}>
      <Search size={19} color={colors.muted} />
      <TextInput accessibilityLabel="Find a canvas" placeholder="Find a canvas" placeholderTextColor={colors.muted} value={query} onChangeText={setQuery}
        autoCorrect={false} returnKeyType="search" style={[styles.searchInput, { color: colors.text }]} />
    </View>
    {filterable && <ScrollView horizontal showsHorizontalScrollIndicator={false} accessibilityLabel="Canvas filter" style={styles.filters} contentContainerStyle={styles.filterRow} keyboardShouldPersistTaps="handled">
      {CANVAS_FILTERS.map(([value, label]) => {
        const selected = filter === value;
        return <Pressable key={value} accessibilityRole="button" accessibilityState={{ selected }} onPress={() => setFilter(value)}
          style={[styles.filter, { backgroundColor: selected ? colors.text : colors.tonal }]}>
          <Text style={{ color: selected ? colors.background : colors.muted, fontSize: 13 }}>{label}</Text>
        </Pressable>;
      })}
    </ScrollView>}
    {failed && <View style={[styles.notice, { backgroundColor: colors.tonal }]}>
      <Text style={{ color: colors.muted, flex: 1 }}>{canvases.length > 0 ? 'Rally couldn’t refresh. Showing your saved canvases.' : 'Your canvases couldn’t load.'}</Text>
      <Pressable accessibilityRole="button" onPress={retry} hitSlop={8}><Text style={{ color: colors.text, fontWeight: '600' }}>Try again</Text></Pressable>
    </View>}
    {loading ? <View style={[styles.skeleton, { backgroundColor: colors.tonal }]}><Text style={{ color: colors.muted }}>Loading your canvases…</Text></View>
      : filtered.length > 0 && <>
        <View style={styles.sectionHeading}>
          <Text style={[styles.sectionTitle, { color: colors.text }]}>{narrowed ? 'Search results' : 'Pick up where you left off'}</Text>
          <Text style={{ color: colors.muted, fontSize: 11 }}>{filtered.length} {filtered.length === 1 ? 'canvas' : 'canvases'}</Text>
        </View>
        {hero && <CanvasCard canvas={hero} hero open={choose} />}
      </>}
  </View>;
  const empty = loading ? null : <View style={styles.empty}>
    <Sparkles size={32} color={colors.text} />
    <Text style={[styles.emptyTitle, { color: colors.text }]}>{narrowed ? 'No canvases found' : 'Make room for an idea.'}</Text>
    <Text style={[styles.emptyBody, { color: colors.muted }]}>{narrowed ? 'Try another name or filter.' : 'Create a plan, a little tool, or something just for you.'}</Text>
    {!narrowed && <Pressable accessibilityRole="button" onPress={create} style={[styles.primary, { backgroundColor: colors.text }]}>
      <Plus size={18} color={colors.onAccent} /><Text style={{ color: colors.onAccent, fontSize: 14 }}>Create a canvas</Text>
    </Pressable>}
  </View>;
  return <FlatList
    data={cells}
    keyExtractor={(canvas) => canvas ? `${canvas.organization?.id ?? ''}:${canvas.id}` : 'spacer'}
    numColumns={2}
    columnWrapperStyle={styles.row}
    ListHeaderComponent={header}
    ListEmptyComponent={filtered.length === 0 && empty ? empty : undefined}
    renderItem={({ item }) => item ? <CanvasCard canvas={item} open={choose} /> : <View style={styles.cell} />}
    keyboardShouldPersistTaps="handled"
    keyboardDismissMode="on-drag"
    contentInsetAdjustmentBehavior="never"
    contentContainerStyle={{ paddingTop: topInset + 25, paddingBottom: bottomInset + 36, paddingHorizontal: 24 }}
    style={{ backgroundColor: colors.background }}
    initialNumToRender={8}
  />;
}

/** A card wears its Canvas's appearance, as the browser host's card does through
 * desktop's `canvasMark`: its glyph in the pastel ink on the pastel tint. The lead
 * card deepens toward 20% of the hue, the browser's
 * `color-mix(in oklab, hue 20%, tint)` at 145 degrees. */
function CanvasCard({ canvas, hero = false, open }: { canvas: DashboardCanvas; hero?: boolean; open: (canvas: DashboardCanvas) => void }) {
  const { colors } = useTheme();
  const from = canvas.organization ? `Shared from ${canvas.organization.name}` : null;
  const { tint, ink, hue } = colors.canvasColors(canvas.id, canvas.color);
  const Icon = canvasGlyph(canvas);
  const title = canvas.title || 'Untitled canvas';
  // iOS sizes a percentage SVG from its first layout, before the card has grown
  // to its text; draw the gradient at the card's measured size instead.
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  return <Pressable onLayout={hero ? (event) => { const { width, height } = event.nativeEvent.layout; setSize((known) => known?.width === width && known.height === height ? known : { width, height }); } : undefined} accessibilityRole="button" accessibilityLabel={from ? `Open ${title}, ${from}` : `Open ${title}`} onPress={() => open(canvas)}
    style={({ pressed }) => [styles.card, hero ? styles.hero : styles.cell, { backgroundColor: tint, opacity: pressed ? 0.8 : 1 }]}>
    {hero && size && <Svg style={StyleSheet.absoluteFill} width={size.width} height={size.height} pointerEvents="none">
      <Defs><LinearGradient id={`lead-${canvas.id}`} x1="0.21" y1="0.09" x2="0.79" y2="0.91">
        <Stop offset="0" stopColor={tint} /><Stop offset="1" stopColor={mixOklab(hue, tint, 0.2)} />
      </LinearGradient></Defs>
      <Rect width={size.width} height={size.height} fill={`url(#lead-${canvas.id})`} />
    </Svg>}
    {/* The Organization's initial, on the upper right, as the web card draws it.
        A touch screen has no hover, so its name is in the card's footer too. */}
    {canvas.organization && <View accessible={false} style={[styles.organization, { backgroundColor: colors.background, borderColor: colors.tonal }]}>
      <Text style={[styles.organizationInitial, { color: colors.text }]}>{canvas.organization.name.slice(0, 1).toLocaleUpperCase()}</Text>
    </View>}
    <View style={[styles.art, hero && styles.heroArt]}><Icon size={hero ? 50 : 32} strokeWidth={1.5} color={ink} /></View>
    <Text numberOfLines={hero ? 3 : 4} style={[hero ? styles.heroTitle : styles.cardTitle, { color: ink }]}>{title}</Text>
    <View style={[styles.cardFooter, { opacity: hero ? 1 : 0.75 }]}><Text numberOfLines={1} style={[styles.cardHint, { color: ink, flexShrink: 1 }]}>{from ?? 'Open canvas'}</Text><ArrowUpRight size={14} color={ink} /></View>
  </Pressable>;
}

const styles = StyleSheet.create({
  // The title keeps its line at phone width; Marketplace sits under it.
  heading: { alignItems: 'flex-start', gap: 12, marginBottom: 22 },
  title: { fontSize: 34, fontWeight: '600', letterSpacing: -1.4 },
  secondary: { flexDirection: 'row', alignItems: 'center', gap: 7, borderRadius: 20, minHeight: 40, paddingHorizontal: 15 },
  // Bleeds to the screen edges so the row scrolls sideways under the gutter.
  filters: { marginTop: -12, marginBottom: 24, marginHorizontal: -24 },
  filterRow: { gap: 8, paddingHorizontal: 24 },
  filter: { borderRadius: 18, minHeight: 36, paddingHorizontal: 14, justifyContent: 'center' },
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
  art: { height: 76, alignItems: 'center', justifyContent: 'center' },
  heroArt: { height: 107 },
  cardTitle: { fontSize: 16, fontWeight: '500', lineHeight: 21, marginTop: 12, marginBottom: 8, flexGrow: 1 },
  heroTitle: { fontSize: 29, lineHeight: 33, letterSpacing: -0.7, fontFamily: Platform.select({ ios: 'Georgia', default: 'serif' }), marginTop: 12, marginBottom: 8 },
  cardFooter: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  cardHint: { fontSize: 11 },
  organization: { position: 'absolute', top: 12, right: 12, width: 22, height: 22, borderRadius: 6, borderWidth: 1, alignItems: 'center', justifyContent: 'center', zIndex: 1 },
  organizationInitial: { fontSize: 11.5, fontWeight: '600' },
  empty: { alignItems: 'center', justifyContent: 'center', paddingVertical: 60, paddingHorizontal: 35, gap: 14 },
  emptyTitle: { fontSize: 22, lineHeight: 29, fontWeight: '600', textAlign: 'center' },
  emptyBody: { fontSize: 14, lineHeight: 22, textAlign: 'center' },
  primary: { flexDirection: 'row', alignItems: 'center', gap: 9, borderRadius: 24, minHeight: 48, paddingVertical: 12, paddingHorizontal: 23 },
});
