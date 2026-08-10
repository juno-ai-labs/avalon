export interface FeatureCardProps {
  /** e.g. "01 · Work streams" */
  label: string;
  title: React.ReactNode;
  children?: React.ReactNode;
  /** Absolutely-positioned visual pinned to the bottom of the card. */
  visual?: React.ReactNode;
  wide?: boolean;
  className?: string;
}
/**
 * @startingPoint section="Avalon site" subtitle="Marketing feature tile with hover lift" viewport="700x380"
 */
export declare function FeatureCard(props: FeatureCardProps): JSX.Element;
