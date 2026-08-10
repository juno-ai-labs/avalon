export interface IconProps {
  /** Lucide icon name in kebab-case, e.g. "chevron-down". */
  name: string;
  /** Pixel size of the square glyph. Product uses 13–17. */
  size?: number;
  className?: string;
  style?: React.CSSProperties;
  /** Accessible label. Omit for decorative glyphs. */
  title?: string;
}
export declare function Icon(props: IconProps): JSX.Element;
