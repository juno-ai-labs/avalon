export interface KickerProps {
  children?: React.ReactNode;
  /** Numeric prefix such as "01" for hero eyebrows. */
  index?: string;
  tone?: 'kicker' | 'eyebrow';
  className?: string;
}
export declare function Kicker(props: KickerProps): JSX.Element;
