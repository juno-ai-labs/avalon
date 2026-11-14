import { useEffect, useRef, useState } from 'react';
import { Platform, View, type ImageSourcePropType } from 'react-native';
import { File, Paths } from 'expo-file-system';
import { CryptoDigestAlgorithm, digestStringAsync } from 'expo-crypto';
import Svg, { G, Rect } from 'react-native-svg';
import { House, PanelsTopLeft, type LucideIcon } from 'lucide-react-native';
import { APPEARANCE_ICON_COMPONENTS } from './appearance-icons';
import type { CanvasSummary } from './protocol';
import { useTheme } from './theme';

const icons: Readonly<Record<string, LucideIcon | undefined>> = APPEARANCE_ICON_COMPONENTS;

async function imageUri(data: string): Promise<string> {
  if (Platform.OS !== 'android') return `data:image/png;base64,${data}`;
  // Android's native tab image loader accepts local files, not PNG data URIs.
  const digest = await digestStringAsync(CryptoDigestAlgorithm.SHA256, data);
  const file = new File(Paths.cache, `rally-tab-${digest}.png`);
  await file.write(data, { encoding: 'base64' });
  return file.uri;
}

/** Native tab items require images. Rasterize the same Lucide SVG and palette
 * used in the pin manager, retaining original colors on both platforms. */
export function NativeTabIcon({ canvas, onImage }: { canvas?: CanvasSummary; onImage: (image: ImageSourcePropType) => void }) {
  const { colors } = useTheme();
  const svg = useRef<Svg>(null);
  const [laidOut, setLaidOut] = useState(false);
  const ink = canvas ? colors.canvasColors(canvas.id, canvas.color).bare : colors.text;
  const Icon = canvas ? icons[canvas.icon ?? ''] ?? PanelsTopLeft : House;
  useEffect(() => {
    if (!laidOut) return;
    let active = true;
    const frame = requestAnimationFrame(() => svg.current?.toDataURL((data) => {
      void imageUri(data).then((uri) => {
        if (active) onImage({ uri, width: 28, height: 28 });
      }).catch((error: unknown) => console.warn('Native tab icon could not be cached', error));
    }));
    return () => { active = false; cancelAnimationFrame(frame); };
  }, [Icon, ink, onImage, laidOut]);
  return <View collapsable={false} pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ position: 'absolute', opacity: 0, width: 28, height: 28 }}>
    <Svg onLayout={() => setLaidOut(true)} ref={svg} width={28} height={28} viewBox="0 0 28 28">
      {/* Keep native SVG layout bounds for rasterization without painting a tile. */}
      <Rect width={28} height={28} fill="transparent" />
      {/* Lucide forwards SVG props to its shapes; position the whole glyph instead. */}
      <G transform="translate(3 3)">
        <Icon size={22} color={ink} strokeWidth={1.9} />
      </G>
    </Svg>
  </View>;
}
