export interface BadgeProps {
  children?: React.ReactNode;
  tone?: 'default' | 'brand' | 'blue';
  className?: string;
  style?: React.CSSProperties;
}
export declare function Badge(props: BadgeProps): JSX.Element;
