export interface AvalonMarkProps {
  size?: number;
  /** Any CSS color. The mark is a single-colour alpha mask. */
  color?: string;
  /** Path to avalon-mark.png relative to the page. */
  src?: string;
  className?: string;
  style?: React.CSSProperties;
}
export declare function AvalonMark(props: AvalonMarkProps): JSX.Element;
