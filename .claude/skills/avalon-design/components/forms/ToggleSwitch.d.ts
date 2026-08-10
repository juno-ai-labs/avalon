export interface ToggleSwitchProps {
  checked?: boolean;
  onChange?: React.ChangeEventHandler<HTMLInputElement>;
  label?: React.ReactNode;
  disabled?: boolean;
  className?: string;
}
export declare function ToggleSwitch(props: ToggleSwitchProps): JSX.Element;
