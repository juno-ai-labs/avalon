export interface ComposerProps {
  value?: string;
  onChange?: React.ChangeEventHandler<HTMLTextAreaElement>;
  onSend?: () => void;
  placeholder?: string;
  hint?: string;
  /** Swaps send for stop while the agent is streaming. */
  busy?: boolean;
  className?: string;
}
/**
 * @startingPoint section="Avalon workspace" subtitle="Bottom composer with tools and send" viewport="700x300"
 */
export declare function Composer(props: ComposerProps): JSX.Element;
