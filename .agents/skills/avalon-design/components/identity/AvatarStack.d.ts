export interface StackMember { id?: string; name?: string; avatarUrl?: string }
export interface AvatarStackProps {
  members?: StackMember[];
  limit?: number;
  className?: string;
}
export declare function AvatarStack(props: AvatarStackProps): JSX.Element;
