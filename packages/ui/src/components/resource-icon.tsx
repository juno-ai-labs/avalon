import { classifyAttachmentKind } from '@rally/contracts';
import { File, FileText, Image as ImageIcon, Link2, Volume2 } from 'lucide-react';
import { IconRosetteAsterisk } from '@tabler/icons-react';
type ResourceKindInput = { resourceType: string; mimeType?: string | null; title: string };
export const FILE_PROVENANCE_TYPES = new Set(['generated_file', 'uploaded_file']);
/**
 * The one name a resource is drawn under.
 *
 * A provenance type says who made the resource, not what it is, so it is
 * replaced by the attachment kind its MIME and filename classify to. That is
 * the only place the translation happens, and it is why `ResourceIcon` takes a
 * resource rather than a string: a caller holding a raw `resourceType` cannot
 * tell that a `generated_file` carrying the site manifest is a live site, and
 * the two rails proved it by both passing the raw type and both drawing a
 * `.docx` sheet over a page somebody opens.
 */
export function resourceIconType(resource: ResourceKindInput): string {
  if (FILE_PROVENANCE_TYPES.has(resource.resourceType)) {
    return classifyAttachmentKind({ mimeType: resource.mimeType, fileName: resource.title });
  }
  return resource.resourceType;
}

/**
 * A published site, under both names it arrives with: `generated_site` is the
 * resource type on the wire, `site` the attachment kind a file-provenance
 * resource classifies to. Matched whole rather than by substring, so a
 * `website` or `web_page` type keeps the link mark below.
 */
const SITE_TYPES = new Set(['generated_site', 'site']);

/** The kind of thing a resource is, at a glance. Shared with both rails' lists. */
export function ResourceIcon({ resource }: { resource: ResourceKindInput }): React.JSX.Element {
  const normalized = resourceIconType(resource).toLowerCase();
  // Ahead of the substring chain, which has no branch a site reaches: it would
  // fall through to the generic file mark, and a site is a page somebody opens
  // rather than a file they download.
  if (SITE_TYPES.has(normalized)) return <IconRosetteAsterisk size={15} />;
  if (normalized.includes('audio')) return <Volume2 size={15} />;
  if (normalized.includes('image')) return <ImageIcon size={15} />;
  if (normalized.includes('doc') || normalized.includes('text')) return <FileText size={15} />;
  if (normalized.includes('url') || normalized.includes('web')) return <Link2 size={15} />;
  return <File size={15} />;
}
