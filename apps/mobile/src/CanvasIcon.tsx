import { View } from 'react-native';
import { PanelsTopLeft, type LucideIcon } from 'lucide-react-native';
import { APPEARANCE_ICON_COMPONENTS } from './appearance-icons';
import type { CanvasSummary } from './protocol';
import { useTheme } from './theme';

const icons: Readonly<Record<string, LucideIcon | undefined>> = APPEARANCE_ICON_COMPONENTS;

/** A Canvas's chosen glyph, else the unchosen one (desktop's `canvasMark`). */
export function canvasGlyph(canvas: Pick<CanvasSummary, 'icon'> | undefined): LucideIcon {
  return (canvas?.icon ? icons[canvas.icon] : undefined) ?? PanelsTopLeft;
}

/** The saved Lucide glyph and Electron pastel pair; unchosen canvases use a sheet. */
export function CanvasIcon({ canvas, size, shaded = true }: { canvas: CanvasSummary | undefined; size: number; shaded?: boolean }) {
  const { colors } = useTheme();
  const { ink, tint, bare } = colors.canvasColors(canvas?.id, canvas?.color);
  const Icon = canvasGlyph(canvas);
  return <View accessible={false} style={{ width: size + 12, height: size + 12, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: shaded ? tint : 'transparent' }}>
    <Icon size={size} color={shaded ? ink : bare} strokeWidth={1.9} />
  </View>;
}
