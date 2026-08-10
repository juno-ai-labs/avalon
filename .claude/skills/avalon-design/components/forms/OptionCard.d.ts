export interface OptionCardProps {
  title: string;
  description?: string;
  icon?: React.ReactNode;
  selected?: boolean;
  onSelect?: () => void;
  /** Keyboard shortcut hint shown on the right. */
  shortcut?: string;
  control?: 'check' | 'none';
  className?: string;
}
export declare function OptionCard(props: OptionCardProps): JSX.Element;
