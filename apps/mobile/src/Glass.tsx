import { useEffect, useState, type PropsWithChildren } from 'react';
import { AccessibilityInfo, Platform, View, type StyleProp, type ViewStyle } from 'react-native';
import { GlassView, isLiquidGlassAvailable } from 'expo-glass-effect';
import { useTheme } from './theme';

/** Keep glass in the native controls; reading surfaces stay opaque. */
export function Glass({ children, style }: PropsWithChildren<{ style?: StyleProp<ViewStyle> }>) {
  const { colors, isDark } = useTheme();
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
