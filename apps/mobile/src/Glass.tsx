import { useEffect, useState, type PropsWithChildren } from 'react';
import { AccessibilityInfo, Platform, View, type StyleProp, type ViewStyle } from 'react-native';
import { GlassView, isLiquidGlassAvailable } from 'expo-glass-effect';
import { themeColors, useTheme } from './theme';

/** Keep glass in the native controls; reading surfaces stay opaque. */
export function Glass({ children, style, scheme }: PropsWithChildren<{ style?: StyleProp<ViewStyle>; scheme?: 'light' | 'dark' }>) {
  const theme = useTheme();
  const isDark = scheme ? scheme === 'dark' : theme.isDark;
  // The opaque fallback (Android, older iOS, Reduce Transparency) follows the
  // requested scheme too, or light glyphs land on a light surface.
  const colors = scheme ? themeColors(scheme) : theme.colors;
  const [reduceTransparency, setReduceTransparency] = useState(true);
  useEffect(() => {
    if (Platform.OS !== 'ios') return;
    void AccessibilityInfo.isReduceTransparencyEnabled().then(setReduceTransparency);
    const listener = AccessibilityInfo.addEventListener('reduceTransparencyChanged', setReduceTransparency);
    return () => listener.remove();
  }, []);
  if (Platform.OS === 'ios' && !reduceTransparency && isLiquidGlassAvailable()) {
    return <GlassView glassEffectStyle="regular" colorScheme={isDark ? 'dark' : 'light'} style={style}>{children}</GlassView>;
  }
  return <View style={[{ backgroundColor: colors.surface, borderColor: colors.line, borderWidth: 1 }, style]}>{children}</View>;
}
