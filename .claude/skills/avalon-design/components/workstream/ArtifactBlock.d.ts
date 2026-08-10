export interface ArtifactBlockProps {
  kind?: string;
  title: string;
  description?: string;
  icon?: string;
  onClick?: () => void;
  className?: string;
}
export declare function ArtifactBlock(props: ArtifactBlockProps): JSX.Element;
