export interface IconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** Required: also used as the tooltip text. */
  label: string;
  active?: boolean;
  size?: number;
}
export declare function IconButton(props: IconButtonProps): JSX.Element;
