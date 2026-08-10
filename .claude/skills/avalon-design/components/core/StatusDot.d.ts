export type RunStatus = 'idle' | 'scheduled' | 'running' | 'needs_input' | 'completed' | 'failed';
export interface StatusDotProps {
  status?: RunStatus;
  /** Dot only, no text. */
  compact?: boolean;
  label?: string;
  className?: string;
}
export declare function StatusDot(props: StatusDotProps): JSX.Element;
