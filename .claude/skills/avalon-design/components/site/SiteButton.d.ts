export interface SiteButtonProps {
  variant?: 'primary' | 'quiet';
  href?: string;
  icon?: React.ReactNode;
  children?: React.ReactNode;
  /** Trailing glyph: ↘ for download, → for in-page. Pass "" to remove. */
  arrow?: string;
  className?: string;
}
export declare function SiteButton(props: SiteButtonProps): JSX.Element;
