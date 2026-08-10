export interface MessageBlockProps {
  author?: string;
  time?: string;
  children?: React.ReactNode;
  /** Renders as Avalon: mark instead of avatar. */
  agent?: boolean;
  streaming?: boolean;
  /** Per-person accent colour for the author name. */
  accent?: string;
  markSrc?: string;
  className?: string;
}
export declare function MessageBlock(props: MessageBlockProps): JSX.Element;
