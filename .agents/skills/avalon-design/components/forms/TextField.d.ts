export interface TextFieldProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'prefix'> {
  label?: string;
  hint?: string;
  prefix?: React.ReactNode;
}
export declare function TextField(props: TextFieldProps): JSX.Element;
