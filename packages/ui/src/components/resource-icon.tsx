import { classifyAttachmentKind } from '@rally/contracts';
import { AppWindow, File, FileText, Image as ImageIcon, Link2, Volume2, type LucideIcon } from 'lucide-react';
import { IconAppWindow } from '@tabler/icons-react';
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

/**
 * The kind of thing a resource is, as a component a tile can draw at its own
 * size: an artifact's sidebar row is the same mark its card carries.
 */
export function resourceGlyph(resource: ResourceKindInput): LucideIcon {
  const normalized = resourceIconType(resource).toLowerCase();
  // Ahead of the substring chain, which has no branch a site reaches: it would
  // fall through to the generic file mark, and a site is a page somebody opens
  // rather than a file they download.
  if (SITE_TYPES.has(normalized)) return AppWindow;
  if (normalized.includes('audio')) return Volume2;
  if (normalized.includes('image')) return ImageIcon;
  if (normalized.includes('doc') || normalized.includes('text')) return FileText;
  if (normalized.includes('url') || normalized.includes('web')) return Link2;
  return File;
}

/** The kind of thing a resource is, at a glance. Shared with both rails' lists. */
export function ResourceIcon({ resource }: { resource: ResourceKindInput }): React.JSX.Element {
  // The site's mark is Tabler's here, as it was before `resourceGlyph`.
  if (SITE_TYPES.has(resourceIconType(resource).toLowerCase())) return <IconAppWindow size={15} />;
  const Glyph = resourceGlyph(resource);
  return <Glyph size={15} />;
}
