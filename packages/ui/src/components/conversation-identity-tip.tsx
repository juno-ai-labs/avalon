import { Tip } from './primitives';

/**
 * A Channel or Breakout's identity tooltip.
 *
 * This is deliberately the richer identity card used by conversation
 * navigation, not the standard one-line tooltip used by generic controls.
 * Any compact surface that shows only a conversation mark can therefore name
 * that mark without inventing a second treatment.
 */
export function ConversationIdentityTip({ children, icon, name, side = 'right' }: {
  children: React.ReactNode;
  icon: React.ReactNode;
  name: string;
  side?: 'top' | 'right' | 'bottom' | 'left';
}): React.JSX.Element {
  return <Tip
    className="sidebar-workstream-preview-surface"
    collisionPadding={8}
    delayDuration={300}
    describesTrigger={false}
    label={<div className="sidebar-workstream-preview">
      <div className="sidebar-workstream-preview-header">
        <span className="sidebar-workstream-preview-identity">
          {icon}
          <span className="sidebar-workstream-preview-name">{name}</span>
        </span>
      </div>
    </div>}
    side={side}
    sideOffset={8}
  >
    {children}
  </Tip>;
}
