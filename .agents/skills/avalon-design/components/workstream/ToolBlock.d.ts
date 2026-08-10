export interface ToolBlockProps {
  name: string;
  detail?: string;
  state?: 'started' | 'completed' | 'failed';
  duration?: string;
  icon?: string;
  children?: React.ReactNode;
  defaultOpen?: boolean;
  className?: string;
}
export declare function ToolBlock(props: ToolBlockProps): JSX.Element;
