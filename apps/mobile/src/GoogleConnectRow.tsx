import { Ionicons } from '@expo/vector-icons';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Animated, AppState, Easing, Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { SvgXml } from 'react-native-svg';
import { GOOGLE_MARKS, type GoogleMark } from './google-marks';
import type { GoogleConnectProduct, MobileSnapshot } from './protocol';
import { useTheme } from './theme';

/**
 * What each offer rolls through, mark and name together, and what it does.
 * The same products, order and wording as the desktop rail tile
 * (`google-connect-rail-item.tsx`); the accessible name is the action, so it
 * contains whichever name is showing.
 */
const OFFERS: Record<GoogleConnectProduct, { marks: readonly { mark: GoogleMark; name: string }[]; action: string }> = {
  'google-mail-calendar': { marks: [{ mark: 'gmail', name: 'Gmail' }, { mark: 'google-calendar', name: 'Calendar' }], action: 'Connect Gmail and Calendar' },
  'google-drive': { marks: [{ mark: 'google-drive', name: 'Drive' }, { mark: 'google-sheets', name: 'Sheets' }, { mark: 'google-docs', name: 'Docs' }], action: 'Connect Drive, Sheets and Docs' },
};

/** The composer's count wheel: 280 ms to roll, every 2.4 s plus the roll. */
const ROLL_MS = 280;
const PERIOD_MS = 2400 + ROLL_MS;
const ICON = 21;
const LABEL = 20;

/**
 * The sidebar's Google row: Gmail, then Drive, as the page offers
 * (`googleConnect`). Its mark and name roll together; Reduce Motion holds the
 * first, and nothing steps while the app is not active.
 */
export function GoogleConnectRow({ offer, onPress, reduceMotion }: {
  offer: NonNullable<MobileSnapshot['googleConnect']>;
  onPress: () => void;
  reduceMotion: boolean;
}): React.JSX.Element {
  const { colors } = useTheme();
  // The name's line grows with Dynamic Type; a fixed wheel would clip it.
  const label = LABEL * useWindowDimensions().fontScale;
  const { marks, action } = OFFERS[offer.product];
  const [step, setStep] = useState({ index: 0, previous: null as number | null });
  const roll = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    setStep({ index: 0, previous: null });
    if (reduceMotion || marks.length < 2) return;
    const timer = setInterval(() => {
      if (AppState.currentState === 'active') setStep((current) => ({ index: (current.index + 1) % marks.length, previous: current.index }));
    }, PERIOD_MS);
    return () => clearInterval(timer);
  }, [offer.product, reduceMotion, marks.length]);
  useEffect(() => {
    if (step.previous === null) return;
    roll.setValue(0);
    Animated.timing(roll, { toValue: 1, duration: ROLL_MS, easing: Easing.out(Easing.ease), useNativeDriver: true }).start();
  }, [step, roll]);
  // Sidebar keys the row by product; this only guards the render before a reset.
  const shown = marks[step.index % marks.length]!;
  const before = step.previous === null ? null : marks[step.previous % marks.length]!;
  const mark = (name: GoogleMark) => <SvgXml xml={GOOGLE_MARKS[name]} width={ICON} height={ICON} color={colors.text} />;
  const name = (text: string) => <Text numberOfLines={1} style={[styles.title, { color: colors.text }]}>{text}</Text>;
  return <Pressable accessibilityRole="button" accessibilityLabel={action} accessibilityState={{ disabled: offer.busy, busy: offer.busy }}
    disabled={offer.busy} onPress={onPress} style={({ pressed }) => [styles.row, { opacity: offer.busy ? 0.5 : pressed ? 0.6 : 1 }]}>
    <View style={styles.icon}>
      <Wheel height={ICON} roll={roll} before={before && mark(before.mark)}>{mark(shown.mark)}</Wheel>
      <View style={[styles.plus, { backgroundColor: colors.text, borderColor: colors.sidebar }]}><Ionicons name="add" size={10} color={colors.sidebar} /></View>
    </View>
    <View style={{ flex: 1 }}><Wheel height={label} roll={roll} before={before && name(before.name)} align="flex-start">{name(shown.name)}</Wheel></View>
  </Pressable>;
}

/** One rolling place: `before` leaves upward as `children` arrives from below, tipped 55° in an 80 pt perspective. */
function Wheel({ align = 'center', before, children, height, roll }: {
  align?: 'center' | 'flex-start';
  before: ReactNode;
  children: ReactNode;
  height: number;
  roll: Animated.Value;
}): React.JSX.Element {
  const layer = (from: number, to: number, fromTilt: string, toTilt: string, opacity: [number, number]) => ({
    opacity: roll.interpolate({ inputRange: [0, 1], outputRange: opacity }),
    transform: [{ perspective: 80 }, { translateY: roll.interpolate({ inputRange: [0, 1], outputRange: [from, to] }) },
      { rotateX: roll.interpolate({ inputRange: [0, 1], outputRange: [fromTilt, toTilt] }) }],
  });
  return <View style={{ height, overflow: 'hidden', justifyContent: 'center', alignItems: align }}>
    {before ? <>
      <Animated.View style={[StyleSheet.absoluteFill, { justifyContent: 'center', alignItems: align }, layer(0, -height, '0deg', '55deg', [1, 0])]}>{before}</Animated.View>
      <Animated.View style={[StyleSheet.absoluteFill, { justifyContent: 'center', alignItems: align }, layer(height, 0, '-55deg', '0deg', [0, 1])]}>{children}</Animated.View>
    </> : children}
  </View>;
}

const styles = StyleSheet.create({
  row: { minHeight: 52, flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 12, borderRadius: 13 },
  icon: { width: ICON, height: ICON },
  plus: { position: 'absolute', right: -6, bottom: -5, width: 14, height: 14, borderRadius: 7, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
  title: { fontSize: 14.5, lineHeight: LABEL },
});
