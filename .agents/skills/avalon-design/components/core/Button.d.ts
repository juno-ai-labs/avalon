export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'default' | 'primary' | 'secondary' | 'quiet' | 'danger';
  size?: 'small' | 'medium';
  /** Leading icon element, usually <Icon />. */
  icon?: React.ReactNode;
}
/**
 * @startingPoint section="Avalon core" subtitle="Buttons, icon buttons, badges and status dots" viewport="700x220"
 */
export declare function Button(props: ButtonProps): JSX.Element;
