import { MESSAGE_MAX_CHARACTERS } from './message-limits';
import { z } from 'zod';
import { classifyAttachmentKind } from './attachment-contracts';
export { renderAnnotations } from "./prompts/artifact-annotations";

const offset = z.number().int().nonnegative();
const span = { start: offset, end: offset };
const fraction = z.number().min(0).max(1);
const boxShape = { x: fraction, y: fraction, w: fraction, h: fraction };
const box = z.strictObject(boxShape)
  .refine((v) => v.x + v.w <= 1.000001 && v.y + v.h <= 1.000001, 'annotation_box_outside_image');
/**
 * One absolute path on the site, as the picker reads `location.pathname +
 * location.search`: never protocol-relative, so the skill's recipe, which
 * resolves it against the local server, cannot be sent to another host. The
 * URL parser reads a backslash as a slash and drops tabs and newlines, so
 * those are refused too rather than relied on to stay where they are.
 */
export const PagePathSchema = z.string().regex(/^\/(?![/\\])[^\\\t\n\r]*$/u);
/**
 * The window a person saw an element in when they pinned it: enough for the
 * agent to rebuild that view in its own browser when no screenshot travels
 * with the pin. CSS pixels, scroll offsets of the page, the device scale, and
 * the color scheme the page was rendered under.
 */
const viewportShape = {
  width: z.number().finite().positive(),
  height: z.number().finite().positive(),
  scrollX: z.number().finite().nonnegative(),
  scrollY: z.number().finite().nonnegative(),
  devicePixelRatio: z.number().finite().positive(),
  colorScheme: z.enum(['light', 'dark']),
};
export const AnnotationViewportSchema = z.strictObject(viewportShape);
export type AnnotationViewport = z.infer<typeof AnnotationViewportSchema>;

/**
 * One shape per locator kind, built twice: strict for admission, where an
 * unknown key from Rally's own client is a bug to reject, and stripping for
 * every read of a stored turn, where an unknown key is a field a newer client
 * added and an older reader must ignore rather than hide the message's
 * annotations over. `box` and `viewport` are the nested objects that differ.
 */
const markdown = { type: z.literal('markdown'), ...span, headingPath: z.array(z.string()) };
const text = { type: z.literal('text'), ...span, lines: z.tuple([z.number().int().positive(), z.number().int().positive()]) };
const pdfText = { type: z.literal('pdf-text'), ...span, page: z.number().int().positive() };
const documentText = { type: z.literal('document-text'), ...span, headingPath: z.array(z.string()) };
const cells = { type: z.literal('cells'), sheet: z.string(), range: z.string().regex(/^[A-Z]+[1-9]\d*(?::[A-Z]+[1-9]\d*)?$/u) };
const slideText = { type: z.literal('slide-text'), ...span, slide: z.number().int().positive() };
const region = { type: z.literal('region'), ...boxShape };
const element = <Box extends z.ZodType, Viewport extends z.ZodType>(boxSchema: Box, viewportSchema: Viewport) =>
  ({ type: z.literal('element'), pagePath: PagePathSchema.optional(), css: z.string().min(1), box: boxSchema, visibleText: z.string(), viewport: viewportSchema.optional() });
const file = { type: z.literal('file') };
export const AnnotationLocatorSchema = z.discriminatedUnion('type', [
  z.strictObject(markdown),
  z.strictObject(text),
  z.strictObject(pdfText),
  z.strictObject(documentText),
  z.strictObject(cells),
  z.strictObject(slideText),
  z.strictObject(region),
  z.strictObject(element(box, AnnotationViewportSchema)),
  z.strictObject(file),
]).superRefine((v, ctx) => {
  if ('start' in v && v.end < v.start) ctx.addIssue({ code: 'custom', path: ['end'], message: 'annotation_range_reversed' });
  if (v.type === 'region' && (v.x + v.w > 1.000001 || v.y + v.h > 1.000001)) ctx.addIssue({ code: 'custom', path: ['w'], message: 'annotation_box_outside_image' });
});
const StoredAnnotationLocatorSchema = z.discriminatedUnion('type', [
  z.object(markdown),
  z.object(text),
  z.object(pdfText),
  z.object(documentText),
  z.object(cells),
  z.object(slideText),
  z.object(region),
  z.object(element(z.object(boxShape), z.object(viewportShape))),
  z.object(file),
]);

// LIMIT UNSET: team-owned defensive guards, inert until finite values are chosen.
// Bounds: selected characters, and serialized annotation characters per send.
// Without them: large selections consume model context and request memory.
// Trips: keep head/tail and mark truncation; reject payload with annotations_too_large.
// Derive: selection budget = context budget / pins minus 400 surrounding characters;
// payload budget = request budget minus ordinary message and attachment metadata.
// The team chooses those budgets and expected pins. No new cap is guessed here.
export const ANNOTATION_EXACT_MAX_CHARACTERS = Number.POSITIVE_INFINITY;
export const ANNOTATIONS_MAX_CHARACTERS = Number.POSITIVE_INFINITY;
export { ANNOTATION_CONTEXT_CHARACTERS } from './annotation-context';
const contentShape = { exact: z.string(), source: z.enum(['exact', 'converted', 'rendered']), before: z.string(), after: z.string(), truncated: z.boolean(), imageAttachmentId: z.string().uuid().optional() };
export const AnnotationSchema = z.strictObject({
  target: z.strictObject({ resourceId: z.string().uuid(), version: z.number().int().positive(), locator: AnnotationLocatorSchema }),
  content: z.strictObject(contentShape),
  comment: z.string().max(MESSAGE_MAX_CHARACTERS, 'message_too_long'),
});
export type Annotation = z.infer<typeof AnnotationSchema>;
export type AnnotationLocator = Annotation['target']['locator'];
export function buildAnnotation(input: Annotation): Annotation {
  const value = AnnotationSchema.parse(input);
  if (value.content.exact.length <= ANNOTATION_EXACT_MAX_CHARACTERS) return value;
  const head = Math.ceil(ANNOTATION_EXACT_MAX_CHARACTERS / 2);
  const tail = Math.floor(ANNOTATION_EXACT_MAX_CHARACTERS / 2);
  return { ...value, content: { ...value.content, exact: value.content.exact.slice(0, head) + (tail ? value.content.exact.slice(-tail) : ''), truncated: true } };
}
export const AnnotationsSchema = z.array(AnnotationSchema.transform(buildAnnotation)).refine(
  (v) => ANNOTATIONS_MAX_CHARACTERS === Number.POSITIVE_INFINITY || JSON.stringify(v).length <= ANNOTATIONS_MAX_CHARACTERS, 'annotations_too_large',
);
// Stored turns must not be truncated or rejected when admission budgets or
// shapes change: a key this build does not know is stripped, not refused.
const StoredAnnotationSchema = z.object({
  target: z.object({ resourceId: z.string().uuid(), version: z.number().int().positive(), locator: StoredAnnotationLocatorSchema }),
  content: z.object(contentShape),
  comment: z.string(),
});
export const AnnotatedMessageContentSchema = z.object({ kind: z.literal('artifact_annotations'), annotations: z.array(StoredAnnotationSchema),
  names: z.record(z.string(), z.string()).optional() });
export function messageAnnotations(content: unknown): Annotation[] {
  const parsed = AnnotatedMessageContentSchema.safeParse(content);
  return parsed.success ? parsed.data.annotations : [];
}
export function validateAnnotationAttachments(value: { annotations?: Annotation[] | undefined; attachmentIds: string[] }, ctx: z.RefinementCtx): void {
  for (const [index, annotation] of (value.annotations ?? []).entries()) {
    if (annotation.content.imageAttachmentId && !value.attachmentIds.includes(annotation.content.imageAttachmentId)) {
      ctx.addIssue({ code: 'custom', path: ['annotations', index, 'content', 'imageAttachmentId'], message: 'annotation_image_attachment_required' });
    }
  }
}
export function isHtmlResource(resource: {fileName:string;mimeType?:string|null|undefined}): boolean {
  const mime = resource.mimeType?.split(';',1)[0]?.trim().toLowerCase();
  return mime === 'text/html' || ((!mime || mime === 'application/octet-stream') && /\.html?$/iu.test(resource.fileName));
}
export function annotationCommentText(text:string, annotations?: readonly Annotation[]):string {
  return [text,...(annotations ?? []).map((a)=>a.comment)].filter((part)=>part.trim()).join('\n\n');
}
export function annotationAllowedForResource(annotation: Annotation, resource: { fileName: string; mimeType: string | null }): boolean {
  const kind = classifyAttachmentKind(resource);
  const locator = annotation.target.locator.type;
  if (locator === 'file') return kind === 'other';
  if (locator === 'element') return annotation.content.source === 'rendered' && ( kind === 'site' || isHtmlResource(resource));
  const allowed: Record<string, string[]> = { markdown: ['markdown'], text: ['text'], pdf: ['pdf-text'], document: ['document-text'], spreadsheet: ['cells'], presentation: ['slide-text'], image: ['region'] };
  const expectedSource = ['pdf-text', 'document-text', 'cells', 'slide-text'].includes(locator) ? 'converted' : 'exact';
  return Boolean(allowed[kind]?.includes(locator)) && annotation.content.source === expectedSource;
}
export const ArtifactPickerPinSchema = z.strictObject({ css: z.string().min(1), box, visibleText: z.string(), before: z.string().optional(), after: z.string().optional(), html: z.string(), pagePath: z.string(), replace: z.boolean(), point: z.strictObject({x:z.number().finite().nonnegative(),y:z.number().finite().nonnegative()}).optional(), rect: z.strictObject({x:z.number().finite(),y:z.number().finite(),width:z.number().finite().nonnegative(),height:z.number().finite().nonnegative()}).optional(), viewport: AnnotationViewportSchema.optional(), screenshot: z.string().optional() });
export type ArtifactPickerPin = z.infer<typeof ArtifactPickerPinSchema>;

export const AnnotationCommentPinsSchema = z.array(z.strictObject({id:z.string(),annotation:AnnotationSchema}));
/** The selection a host wants highlighted: a pin being edited, or a saved spot being viewed. */
export const AnnotationSelectionSchema = z.strictObject({ css: z.string().min(1), pagePath: z.string().optional(), exact: z.string().optional() });
export type AnnotationSelection = z.infer<typeof AnnotationSelectionSchema>;
export type AnnotationCommentPins = z.infer<typeof AnnotationCommentPinsSchema>;
export const AnnotationCommentActionSchema = z.strictObject({id:z.string(),action:z.enum(['edit','remove']),point:z.strictObject({x:z.number().finite(),y:z.number().finite()}).optional()});
export type AnnotationCommentAction = z.infer<typeof AnnotationCommentActionSchema>;
