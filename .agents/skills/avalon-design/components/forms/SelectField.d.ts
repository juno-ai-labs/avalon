export interface SelectOption { value: string; label: string }
export interface SelectFieldProps {
  options?: SelectOption[];
  value?: string;
  onChange?: React.ChangeEventHandler<HTMLSelectElement>;
  /** primary = bordered control, secondary = text-only preference row. */
  variant?: 'primary' | 'secondary';
  ariaLabel?: string;
  className?: string;
}
export declare function SelectField(props: SelectFieldProps): JSX.Element;
