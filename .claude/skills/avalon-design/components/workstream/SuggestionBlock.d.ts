export interface SuggestionBlockProps {
  label?: string;
  title: string;
  reason?: string;
  actions?: React.ReactNode;
  resolved?: boolean;
  resolution?: string;
  className?: string;
}
export declare function SuggestionBlock(props: SuggestionBlockProps): JSX.Element;
