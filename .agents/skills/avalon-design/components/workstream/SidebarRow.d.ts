export interface SidebarRowProps {
  title: string;
  hint?: string;
  /** Lucide icon name. */
  icon?: string;
  active?: boolean;
  unread?: boolean;
  /** Scope badge text, e.g. "You" or "Workspace". */
  scope?: string;
  onClick?: () => void;
  className?: string;
}
export declare function SidebarRow(props: SidebarRowProps): JSX.Element;
