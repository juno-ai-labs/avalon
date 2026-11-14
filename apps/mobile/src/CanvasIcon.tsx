import { View } from 'react-native';
import { PanelsTopLeft, type LucideIcon } from 'lucide-react-native';
import { APPEARANCE_ICON_COMPONENTS } from './appearance-icons';
import type { CanvasSummary } from './protocol';
import { useTheme } from './theme';

const icons: Readonly<Record<string, LucideIcon | undefined>> = APPEARANCE_ICON_COMPONENTS;

/** The saved Lucide glyph and Electron pastel pair; unchosen canvases use a sheet. */
export function CanvasIcon({ canvas, size, shaded = true }: { canvas: CanvasSummary | undefined; size: number; shaded?: boolean }) {
  const { colors } = useTheme();
  const { ink, tint, bare } = colors.canvasColors(canvas?.id, canvas?.color);
  const Icon = (canvas?.icon ? icons[canvas.icon] : undefined) ?? PanelsTopLeft;
  return <View accessible={false} style={{ width: size + 12, height: size + 12, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: shaded ? tint : 'transparent' }}>
    <Icon size={size} color={shaded ? ink : bare} strokeWidth={1.9} />
  </View>;
}
