import { z } from 'zod';
import { AnnotationCommentActionSchema, AnnotationCommentPinsSchema, AnnotationLocatorSchema, ArtifactPickerPinSchema } from './artifact-annotations';

/**
 * The messages a host and a framed document exchange over the annotation
 * script's `postMessage` bridge. The script itself is in
 * `artifact-annotation-script.ts`; see `docs/artifact-annotations.md`.
 */
export * from './artifact-annotation-script';

/** An element's viewport rectangle, as the script reports it. */
export const ArtifactElementRectSchema = z.strictObject({ x: z.number().finite(), y: z.number().finite(), width: z.number().finite().nonnegative(), height: z.number().finite().nonnegative() });
export type ArtifactElementRect = z.infer<typeof ArtifactElementRectSchema>;

/** What a host sends a framed document. */
export const AnnotationHostMessageSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('rally-annotation-picking'), on: z.boolean() }),
  z.strictObject({ type: z.literal('rally-annotation-comments'), pins: AnnotationCommentPinsSchema, selected: z.string().nullable().optional() }),
  z.strictObject({ type: z.literal('rally-annotation-restore'), locator: AnnotationLocatorSchema, exact: z.string() }),
]);
export type AnnotationHostMessage = z.infer<typeof AnnotationHostMessageSchema>;

/**
 * What a framed document sends back. A host parses with this before reading
 * anything: the page's own scripts share the frame and may post too, and a pin
 * must never carry image bytes a host did not capture itself.
 */
export const AnnotationFrameMessageSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('rally-annotation-ready'), pagePath: z.string() }),
  z.strictObject({ type: z.literal('rally-artifact-pin'), pin: ArtifactPickerPinSchema.omit({ screenshot: true }).nullable() }),
  z.strictObject({ type: z.literal('rally-annotation-comment-action'), action: AnnotationCommentActionSchema }),
  z.strictObject({ type: z.literal('rally-annotation-restored'), resolved: z.boolean() }),
  z.strictObject({ type: z.literal('rally-annotation-anchor'), rect: ArtifactElementRectSchema }),
]);
export type AnnotationFrameMessage = z.infer<typeof AnnotationFrameMessageSchema>;
