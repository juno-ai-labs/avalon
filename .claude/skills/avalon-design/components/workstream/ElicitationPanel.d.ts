export interface ElicitationOption { value?: string; title: string; description?: string }
export interface ElicitationPanelProps {
  question: string;
  options?: ElicitationOption[];
  selected?: string | number;
  onSelect?: (value: string | number) => void;
  onSkip?: () => void;
  onSubmit?: () => void;
  className?: string;
}
export declare function ElicitationPanel(props: ElicitationPanelProps): JSX.Element;
