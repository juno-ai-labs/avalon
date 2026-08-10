export interface RailCardProps {
  title: string;
  meta?: string;
  icon?: string;
  trailing?: React.ReactNode;
  /** Adds the "watch for changes" toggle row. */
  watchable?: boolean;
  watched?: boolean;
  onWatchChange?: React.ChangeEventHandler<HTMLInputElement>;
  className?: string;
}
export declare function RailCard(props: RailCardProps): JSX.Element;
