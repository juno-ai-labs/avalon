export interface LoadingStateProps {
  label?: string;
  /** Use the pulsing Avalon mark instead of the spinner (boot and open states). */
  mark?: boolean;
  className?: string;
}
export declare function LoadingState(props: LoadingStateProps): JSX.Element;
