import { z } from "zod";
import { ResourceDirectionSchema, ResourceRelationshipTypeSchema } from "./resource-relationships";

export const ATTACHMENT_KIND_ENTRIES = [
  { kind: "image", description: "an image the agent can view" },
  { kind: "markdown", description: "a Markdown file" },
  { kind: "pdf", description: "a PDF document" },
  { kind: "document", description: "a word-processing document such as DOCX" },
  { kind: "spreadsheet", description: "a spreadsheet or workbook such as XLSX" },
  { kind: "presentation", description: "a slide presentation such as PPTX" },
  { kind: "text", description: "another readable text, source-code, or structured-data file" },
  { kind: "other", description: "a resource outside the readable or viewable kinds above" },
] as const;

const ATTACHMENT_KINDS = ATTACHMENT_KIND_ENTRIES.map((entry) => entry.kind) as [
  "image",
  "markdown",
  "pdf",
  "document",
  "spreadsheet",
  "presentation",
  "text",
  "other",
];

export const AttachmentKindSchema = z.enum(ATTACHMENT_KINDS);
export type AttachmentKind = z.infer<typeof AttachmentKindSchema>;

export const ATTACHMENT_LIST_RESOURCES_DESCRIPTION = [
  "List resources visible in this work stream. Filter with attachmentKind using exactly one of these values:",
  ...ATTACHMENT_KIND_ENTRIES.map((entry) => `- ${entry.kind} — ${entry.description}`),
  "Omit attachmentKind to list every kind. Do not use or guess MIME types.",
  "Use nextCursor by itself to continue until it is null when complete coverage is required.",
].join("\n");

const GENERIC_MIME_TYPES = new Set([
  "",
  "application/octet-stream",
  "binary/octet-stream",
]);

const EXTENSION_KINDS: Readonly<Record<string, AttachmentKind>> = {
  apng: "image",
  avif: "image",
  gif: "image",
  heic: "image",
  heif: "image",
  jpeg: "image",
  jpg: "image",
  png: "image",
  tif: "image",
  tiff: "image",
  webp: "image",
  markdown: "markdown",
  mdown: "markdown",
  md: "markdown",
  pdf: "pdf",
  doc: "document",
  docx: "document",
  odt: "document",
  pages: "document",
  rtf: "document",
  csv: "spreadsheet",
  numbers: "spreadsheet",
  ods: "spreadsheet",
  xls: "spreadsheet",
  xlsm: "spreadsheet",
  xlsx: "spreadsheet",
  key: "presentation",
  odp: "presentation",
  ppt: "presentation",
  pptx: "presentation",
  c: "text",
  cc: "text",
  cpp: "text",
  css: "text",
  go: "text",
  h: "text",
  html: "text",
  java: "text",
  js: "text",
  json: "text",
  jsx: "text",
  log: "text",
  py: "text",
  rb: "text",
  rs: "text",
  sh: "text",
  sql: "text",
  toml: "text",
  ts: "text",
  tsx: "text",
  txt: "text",
  xml: "text",
  yaml: "text",
  yml: "text",
};

const DOCUMENT_MIME_TYPES = new Set([
  "application/msword",
  "application/rtf",
  "application/vnd.apple.pages",
  "application/vnd.oasis.opendocument.text",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);
const SPREADSHEET_MIME_TYPES = new Set([
  "application/vnd.apple.numbers",
  "application/vnd.ms-excel",
  "application/vnd.oasis.opendocument.spreadsheet",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "text/csv",
]);
const PRESENTATION_MIME_TYPES = new Set([
  "application/vnd.apple.keynote",
  "application/vnd.ms-powerpoint",
  "application/vnd.oasis.opendocument.presentation",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
]);
const STRUCTURED_TEXT_MIME_TYPES = new Set([
  "application/graphql",
  "application/javascript",
  "application/json",
  "application/sql",
  "application/toml",
  "application/x-httpd-php",
  "application/x-javascript",
  "application/x-ndjson",
  "application/x-sh",
  "application/xhtml+xml",
  "application/xml",
  "application/yaml",
]);

function normalizedMimeType(value: string | null | undefined): string {
  return (value ?? "").split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

function sanitizedExtension(fileName: string | null | undefined): string | null {
  const name = fileName?.trim();
  if (!name) return null;
  const dot = name.lastIndexOf(".");
  if (dot < 0 || dot === name.length - 1) return null;
  const extension = name.slice(dot + 1).toLowerCase();
  return /^[a-z0-9]{1,12}$/u.test(extension) ? extension : null;
}

export function classifyAttachmentKind(input: {
  mimeType: string | null | undefined;
  fileName?: string | null;
}): AttachmentKind {
  const mimeType = normalizedMimeType(input.mimeType);
  if (!GENERIC_MIME_TYPES.has(mimeType)) {
    if (mimeType.startsWith("image/")) return "image";
    if (mimeType === "text/markdown" || mimeType === "text/x-markdown") return "markdown";
    if (mimeType === "application/pdf") return "pdf";
    if (DOCUMENT_MIME_TYPES.has(mimeType)) return "document";
    if (SPREADSHEET_MIME_TYPES.has(mimeType)) return "spreadsheet";
    if (PRESENTATION_MIME_TYPES.has(mimeType)) return "presentation";
    if (mimeType.startsWith("text/") || STRUCTURED_TEXT_MIME_TYPES.has(mimeType) || mimeType.endsWith("+json") || mimeType.endsWith("+xml")) {
      return "text";
    }
    return "other";
  }
  const extension = sanitizedExtension(input.fileName);
  return extension ? (EXTENSION_KINDS[extension] ?? "other") : "other";
}

const CanonicalUuidSchema = z.string().uuid().refine((value) => value === value.toLowerCase(), {
  message: "UUIDs must use canonical lowercase form",
});
const CursorSchema = z.string().min(1).max(2_048);
const MimeTypeSchema = z.string().max(160).nullable();
const NonNegativeIntegerSchema = z.number().int().nonnegative();

export const ContentModeSchema = z.enum(["read", "view", "unsupported"]);
export type ContentMode = z.infer<typeof ContentModeSchema>;
export const DerivativeStatusSchema = z.enum([
  "pending",
  "processing",
  "ready",
  "failed",
  "unsupported",
]).nullable();
export type DerivativeStatus = z.infer<typeof DerivativeStatusSchema>;

export const AttachmentManifestEntrySchema = z.object({
  resourceId: CanonicalUuidSchema,
  fileName: z.string().max(300),
  mimeType: z.string().max(160),
  sizeBytes: NonNegativeIntegerSchema,
  attachmentKind: AttachmentKindSchema,
  contentMode: ContentModeSchema,
  derivativeStatus: DerivativeStatusSchema,
  errorCode: z.string().min(1).max(160).nullable(),
  inlined: z.boolean(),
}).strict();
export type AttachmentManifestEntry = z.infer<typeof AttachmentManifestEntrySchema>;

export const ResourceVersionSchema = z.object({
  sha256: z.string().min(1).max(128),
  extractorVersion: z.string().min(1).max(160),
}).strict();
export type ResourceVersion = z.infer<typeof ResourceVersionSchema>;

export const CharacterRangeSchema = z.object({
  start: NonNegativeIntegerSchema,
  end: NonNegativeIntegerSchema,
}).strict().refine((range) => range.end >= range.start, "Range end must not precede its start");
export type CharacterRange = z.infer<typeof CharacterRangeSchema>;

export const SuggestedAttachmentToolCallSchema = z.discriminatedUnion("tool", [
  z.object({
    tool: z.literal("workstream_read_resource"),
    arguments: z.object({ resourceId: CanonicalUuidSchema }).strict(),
  }).strict(),
  z.object({
    tool: z.literal("workstream_view_resource"),
    arguments: z.object({ resourceIds: z.tuple([CanonicalUuidSchema]) }).strict(),
  }).strict(),
  z.object({
    tool: z.literal("automation_read_resource"),
    arguments: z.object({ resourceId: CanonicalUuidSchema }).strict(),
  }).strict(),
  z.object({
    tool: z.literal("automation_view_resource"),
    arguments: z.object({ resourceIds: z.tuple([CanonicalUuidSchema]) }).strict(),
  }).strict(),
]);
export type SuggestedAttachmentToolCall = z.infer<typeof SuggestedAttachmentToolCallSchema>;

export const AttachmentListResourcesArgumentsSchema = z.union([
  z.object({
    limit: z.number().int().min(1).max(50).optional(),
    attachmentKind: AttachmentKindSchema.optional(),
  }).strict(),
  z.object({ cursor: CursorSchema }).strict(),
]);
export const AttachmentReadResourceArgumentsSchema = z.union([
  z.object({
    resourceId: CanonicalUuidSchema,
    startCharacter: NonNegativeIntegerSchema.optional(),
  }).strict(),
  z.object({ cursor: CursorSchema }).strict(),
]);
export const AttachmentSearchResourceArgumentsSchema = z.object({
  resourceId: CanonicalUuidSchema,
  query: z.string().min(1).max(1_000),
  limit: z.number().int().min(1).max(5).optional(),
  maxPassageCharacters: z.number().int().min(500).max(4_000).optional(),
}).strict();
export const AttachmentViewResourceArgumentsSchema = z.object({
  resourceIds: z.array(CanonicalUuidSchema).min(1).max(8),
  maxDimension: z.number().int().min(64).max(2_048).optional(),
}).strict().superRefine((value, context) => {
  if (new Set(value.resourceIds).size !== value.resourceIds.length) {
    context.addIssue({ code: "custom", message: "resourceIds must be unique", path: ["resourceIds"] });
  }
});
export const AttachmentSummarizeResourceArgumentsSchema = z.object({
  resourceId: CanonicalUuidSchema,
  prompt: z.string().min(1).max(2_000).optional(),
  maxOutputCharacters: z.number().int().min(2_000).max(20_000).optional(),
}).strict();

export const ATTACHMENT_TOOL_ARGUMENT_SCHEMAS = {
  listResources: AttachmentListResourcesArgumentsSchema,
  readResource: AttachmentReadResourceArgumentsSchema,
  searchResource: AttachmentSearchResourceArgumentsSchema,
  viewResource: AttachmentViewResourceArgumentsSchema,
  summarizeResource: AttachmentSummarizeResourceArgumentsSchema,
} as const;

const ResourceListItemSchema = z.object({
  resourceId: CanonicalUuidSchema,
  /**
   * The resource's short alias, cheaper for a model to read back and to write
   * into a citation than the UUID beside it. Null until one is allocated; the
   * UUID above is what every tool argument and internal reference uses.
   */
  slug: z.string().min(3).max(80).nullable(),
  title: z.string(),
  resourceType: z.string(),
  provider: z.string(),
  mimeType: MimeTypeSchema,
  sizeBytes: NonNegativeIntegerSchema,
  relationshipType: ResourceRelationshipTypeSchema,
  direction: ResourceDirectionSchema,
  attachedAt: z.string().datetime({ offset: true }),
  messageAttachment: z.boolean(),
  attachmentKind: AttachmentKindSchema,
  contentMode: ContentModeSchema,
  derivativeStatus: DerivativeStatusSchema,
}).strict();

export const WorkstreamListResourcesOutputSchema = z.object({
  workstreamId: CanonicalUuidSchema,
  asOf: z.string().datetime({ offset: true }),
  totalVisibleResources: NonNegativeIntegerSchema,
  totalMatchingResources: NonNegativeIntegerSchema,
  filters: z.object({ attachmentKind: AttachmentKindSchema.nullable() }).strict(),
  items: z.array(ResourceListItemSchema),
  nextCursor: CursorSchema.nullable(),
}).strict();

export const WorkstreamReadResourceOutputSchema = z.object({
  resourceId: CanonicalUuidSchema,
  title: z.string(),
  sourceMimeType: MimeTypeSchema,
  modelMimeType: z.string().min(1).max(160),
  version: ResourceVersionSchema,
  range: CharacterRangeSchema,
  totalCharacters: NonNegativeIntegerSchema,
  charactersBefore: NonNegativeIntegerSchema,
  charactersReturned: NonNegativeIntegerSchema,
  charactersAfter: NonNegativeIntegerSchema,
  text: z.string().max(24_000),
  previousCursor: CursorSchema.nullable(),
  nextCursor: CursorSchema.nullable(),
}).strict().superRefine((value, context) => {
  if (value.charactersBefore !== value.range.start
    || value.charactersReturned !== value.range.end - value.range.start
    || value.charactersAfter !== value.totalCharacters - value.range.end) {
    context.addIssue({ code: "custom", message: "Character coverage fields must match range and total" });
  }
});

export const WorkstreamSearchResourceOutputSchema = z.object({
  resourceId: CanonicalUuidSchema,
  title: z.string(),
  sourceMimeType: MimeTypeSchema,
  modelMimeType: z.string().min(1).max(160),
  version: ResourceVersionSchema,
  query: z.string().min(1).max(1_000),
  totalMatches: NonNegativeIntegerSchema,
  returnedMatches: NonNegativeIntegerSchema,
  passages: z.array(z.object({
    rank: z.number().int().positive(),
    sectionLabel: z.string().nullable(),
    range: CharacterRangeSchema,
    text: z.string().max(4_000),
    readCursor: CursorSchema,
  }).strict()).max(5),
  truncated: z.boolean(),
}).strict();

const ViewReasonCodeSchema = z.enum([
  "resource_not_found",
  "resource_processing",
  "resource_conversion_failed",
  "resource_format_unsupported",
  "resource_tool_mismatch",
]).nullable();

export const WorkstreamViewResourceOutputSchema = z.object({
  requested: z.number().int().min(1).max(8),
  returned: z.number().int().min(0).max(8),
  items: z.array(z.object({
    resourceId: CanonicalUuidSchema,
    title: z.string(),
    sourceMimeType: MimeTypeSchema,
    modelMimeType: z.enum(["image/jpeg", "image/png", "image/gif", "image/webp"]).nullable(),
    version: ResourceVersionSchema.nullable(),
    sourceBytes: NonNegativeIntegerSchema,
    derivativeBytes: NonNegativeIntegerSchema.nullable(),
    width: NonNegativeIntegerSchema.nullable(),
    height: NonNegativeIntegerSchema.nullable(),
    status: z.enum(["included", "skipped"]),
    reasonCode: ViewReasonCodeSchema,
    reason: z.string().max(1_000).nullable(),
    suggestedCall: SuggestedAttachmentToolCallSchema.nullable(),
    visualPartIndex: NonNegativeIntegerSchema.nullable(),
  }).strict()).min(1).max(8),
}).strict();

export const WorkstreamSummarizeResourceOutputSchema = z.object({
  resourceId: CanonicalUuidSchema,
  title: z.string(),
  sourceMimeType: MimeTypeSchema,
  modelMimeType: z.string().min(1).max(160),
  version: ResourceVersionSchema,
  prompt: z.string().max(2_000).nullable(),
  outline: z.array(z.object({ heading: z.string(), range: CharacterRangeSchema }).strict()).max(50),
  summary: z.string(),
  citations: z.array(z.object({
    label: z.string(),
    range: CharacterRangeSchema,
    readCursor: CursorSchema,
  }).strict()).max(50),
  coverage: z.object({
    status: z.enum(["complete", "partial"]),
    totalCharacters: NonNegativeIntegerSchema,
    consideredCharacters: NonNegativeIntegerSchema,
    limitations: z.array(z.string()).max(20),
  }).strict(),
}).strict();

export type AttachmentListResourcesArguments = z.infer<typeof AttachmentListResourcesArgumentsSchema>;
export type AttachmentReadResourceArguments = z.infer<typeof AttachmentReadResourceArgumentsSchema>;
export type AttachmentSearchResourceArguments = z.infer<typeof AttachmentSearchResourceArgumentsSchema>;
export type AttachmentViewResourceArguments = z.infer<typeof AttachmentViewResourceArgumentsSchema>;
export type AttachmentSummarizeResourceArguments = z.infer<typeof AttachmentSummarizeResourceArgumentsSchema>;
export type WorkstreamListResourcesOutput = z.infer<typeof WorkstreamListResourcesOutputSchema>;
export type WorkstreamReadResourceOutput = z.infer<typeof WorkstreamReadResourceOutputSchema>;
export type WorkstreamSearchResourceOutput = z.infer<typeof WorkstreamSearchResourceOutputSchema>;
export type WorkstreamViewResourceOutput = z.infer<typeof WorkstreamViewResourceOutputSchema>;
export type WorkstreamSummarizeResourceOutput = z.infer<typeof WorkstreamSummarizeResourceOutputSchema>;
