import { z } from "zod";
import { SITE_MANIFEST_MIME_TYPE } from "./artifacts";
import { ResourceDirectionSchema, ResourceRelationshipTypeSchema } from "./resource-relationships";

/**
 * How long a derivative conversion may hold its claim before it is abandoned.
 *
 * The preview route answers `resource_processing` while a claim is live and
 * fresh; once a claim is older than this, the next caller stops waiting and
 * converts the document itself. So this is the server's own definition of "that
 * conversion is not coming back".
 *
 * It is shared rather than server-private because a client that waits out a
 * `resource_processing` answer derives how long that wait can still be worth
 * making from this number and the one below. The pair is the arithmetic, and
 * splitting them across packages is how the client ends up giving up early,
 * silently, the day either is changed here.
 */
export const ATTACHMENT_PROCESSING_LEASE_MS = 5 * 60_000;

/**
 * How long one conversion attempt may run inside its request.
 *
 * Past it the attempt records `conversion_timeout` as a terminal state, which
 * is cached against the extractor version — the next caller is told the
 * conversion failed rather than being asked to wait again.
 *
 * Shared for the same reason as the lease: the longest a `resource_processing`
 * answer can precede a *ready* one is another caller's whole lease running out
 * without publishing, then this caller taking the claim and spending this
 * timeout converting. A client that waits out `processing` needs both halves of
 * that sum.
 */
export const ATTACHMENT_CONVERTER_TIMEOUT_MS = 30_000;

export const ATTACHMENT_KIND_ENTRIES = [
  { kind: "image", description: "an image the agent can view" },
  { kind: "audio", description: "an audio file the user can play" },
  { kind: "markdown", description: "a Markdown file" },
  { kind: "pdf", description: "a PDF document" },
  { kind: "document", description: "a word-processing document such as DOCX" },
  { kind: "spreadsheet", description: "a spreadsheet or workbook such as XLSX" },
  { kind: "presentation", description: "a slide presentation such as PPTX" },
  { kind: "text", description: "another readable text, source-code, or structured-data file" },
  { kind: "site", description: "a live web page or small web app published as a site" },
  { kind: "other", description: "a resource outside the readable or viewable kinds above" },
] as const;

const ATTACHMENT_KINDS = ATTACHMENT_KIND_ENTRIES.map((entry) => entry.kind) as [
  "image",
  "audio",
  "markdown",
  "pdf",
  "document",
  "spreadsheet",
  "presentation",
  "text",
  "site",
  "other",
];

export const AttachmentKindSchema = z.enum(ATTACHMENT_KINDS);
export type AttachmentKind = z.infer<typeof AttachmentKindSchema>;

export const ATTACHMENT_LIST_RESOURCES_DESCRIPTION = [
  "List resources visible in this thread. Filter with attachmentKind using exactly one of these values:",
  ...ATTACHMENT_KIND_ENTRIES.map((entry) => `- ${entry.kind} — ${entry.description}`),
  "Omit attachmentKind to list every kind. Do not use or guess MIME types.",
  "Use list_resources_next with pageId copied from nextPageId to continue. Stop when nextPageId is null.",
  // Two identifiers arrive per item and only one is an argument. Without this
  // the model is left to choose, and the wrong choice is rejected by every
  // other resource tool's schema — a wasted turn each time.
  "Each item carries resourceId and slug. Pass resourceId to every tool; slug is a short alias for"
    + " writing about the resource, and is sometimes null.",
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
  aac: "audio",
  flac: "audio",
  m4a: "audio",
  mp3: "audio",
  ogg: "audio",
  opus: "audio",
  wav: "audio",
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
    if (mimeType.startsWith("audio/")) return "audio";
    if (mimeType === "text/markdown" || mimeType === "text/x-markdown") return "markdown";
    if (mimeType === "application/pdf") return "pdf";
    if (DOCUMENT_MIME_TYPES.has(mimeType)) return "document";
    if (SPREADSHEET_MIME_TYPES.has(mimeType)) return "spreadsheet";
    if (PRESENTATION_MIME_TYPES.has(mimeType)) return "presentation";
    // Before the `+json` branch, which would otherwise claim it: a site
    // manifest is JSON-shaped and is emphatically not a readable text
    // resource. Its content tools redirect to the Terminal import instead.
    if (mimeType === SITE_MANIFEST_MIME_TYPE) return "site";
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

export const AttachmentManifestEntrySchema = z.strictObject({
  resourceId: CanonicalUuidSchema,
  fileName: z.string().max(300),
  mimeType: z.string().max(160),
  sizeBytes: NonNegativeIntegerSchema,
  attachmentKind: AttachmentKindSchema,
  contentMode: ContentModeSchema,
  derivativeStatus: DerivativeStatusSchema,
  errorCode: z.string().min(1).max(160).nullable(),
  inlined: z.boolean(),
});
export type AttachmentManifestEntry = z.infer<typeof AttachmentManifestEntrySchema>;

export const ResourceVersionSchema = z.strictObject({
  sha256: z.string().min(1).max(128),
  extractorVersion: z.string().min(1).max(160),
});
export type ResourceVersion = z.infer<typeof ResourceVersionSchema>;

export const CharacterRangeSchema = z.strictObject({
  start: NonNegativeIntegerSchema,
  end: NonNegativeIntegerSchema,
}).refine((range) => range.end >= range.start, "Range end must not precede its start");
export type CharacterRange = z.infer<typeof CharacterRangeSchema>;

export const SuggestedAttachmentToolCallSchema = z.discriminatedUnion("tool", [
  // `startCharacter` is no longer suggested, but receipts written while it was
  // carry it in their stored `errorJson`, and an invalid field discards the
  // whole failure detail on reprojection, `resourceId` included.
  z.strictObject({
    tool: z.literal("read_resource"),
    arguments: z.strictObject({ resourceId: CanonicalUuidSchema, startCharacter: NonNegativeIntegerSchema.optional() }),
  }),
  z.strictObject({
    tool: z.literal("view_resource"),
    arguments: z.strictObject({ resourceIds: z.tuple([CanonicalUuidSchema]) }),
  }),
  z.strictObject({
    tool: z.literal("sidekick_read_resource"),
    arguments: z.strictObject({ resourceId: CanonicalUuidSchema, startCharacter: NonNegativeIntegerSchema.optional() }),
  }),
  z.strictObject({
    tool: z.literal("sidekick_view_resource"),
    arguments: z.strictObject({ resourceIds: z.tuple([CanonicalUuidSchema]) }),
  }),
  /**
   * The one member that is not a content read, and the one that needed an
   * argument shape decided rather than copied.
   *
   * A site's source is not readable through the content tools — there is no
   * single body to return — so the remediation for a read on one redirects to
   * the Terminal import that materializes its directory. That widens what a
   * suggestion may name: every other member here is a read a model can make
   * blind, and an import writes a tree to the sandbox filesystem.
   *
   * What keeps it safe is that only the create-only form is expressible.
   * `import_resource` also accepts `destinationPath` and `overwrite`,
   * and neither appears here, so a suggested import lands on the deterministic
   * path and refuses a non-empty destination with `destination_exists` rather
   * than replacing anything. The object is strict, so a producer that tried to
   * suggest `overwrite: true` is rejected by the sanitizer instead of
   * forwarded to the model.
   */
  z.strictObject({
    tool: z.literal("import_resource"),
    arguments: z.strictObject({ resourceId: CanonicalUuidSchema }),
  }),
]);
export type SuggestedAttachmentToolCall = z.infer<typeof SuggestedAttachmentToolCallSchema>;

/**
 * The names these three tools were suggested under before their plugins dropped
 * their wire prefixes.
 *
 * A suggestion is not only produced and forwarded in one turn: it is written
 * into a tool receipt's stored `errorJson` and re-parsed whenever that failure
 * is reprojected. A row written before the rename carries the retired spelling,
 * and the sanitizer that re-reads it drops the *whole* detail object when any
 * one field fails — so without this the resource id and attachment kind beside
 * it would be lost too, leaving a bare error code and no recovery.
 */
const RETIRED_SUGGESTED_TOOL_NAMES: Readonly<Record<string, string>> = {
  workstream_read_resource: "read_resource",
  workstream_view_resource: "view_resource",
  terminal_import_resource: "import_resource",
};

/**
 * Parse a suggestion that may have been stored under a retired wire name,
 * normalizing it to the name this run advertises. Producers are unaffected:
 * they build the current names through `SuggestedAttachmentToolCallSchema`
 * directly, and only this read path accepts the old ones.
 */
export function parseStoredSuggestedAttachmentToolCall(
  value: unknown,
): { success: true; data: SuggestedAttachmentToolCall } | { success: false } {
  const parsed = SuggestedAttachmentToolCallSchema.safeParse(value);
  if (parsed.success) return { success: true, data: parsed.data };
  const tool = typeof value === "object" && value !== null && "tool" in value
    ? (value as { tool?: unknown }).tool
    : undefined;
  const current = typeof tool === "string" ? RETIRED_SUGGESTED_TOOL_NAMES[tool] : undefined;
  if (!current) return { success: false };
  const retry = SuggestedAttachmentToolCallSchema.safeParse({ ...(value as object), tool: current });
  return retry.success ? { success: true, data: retry.data } : { success: false };
}

/**
 * These two are flat objects with a refinement rather than the union the choice
 * they express would suggest, and that is a provider constraint rather than a
 * preference.
 *
 * `z.union` emits a root `anyOf`, and Azure OpenAI rejects **any** root-level
 * combinator on a tool's `parameters` — measured against the live `gpt-5.6-sol`
 * deployment, which answers `invalid_function_parameters` and fails the whole
 * request, every tool, not just the offending one. Adding `type: "object"`
 * beside the `anyOf` does not help; the second error names
 * `oneOf`/`anyOf`/`allOf`/`enum`/`const`/`not` at the top level as the thing it
 * will not take. `gpt-5.6-sol` is fenced to Azure with no fallback candidate,
 * so a work stream pinned to it from the model picker died outright on
 * 2026-09-02 with a bare `harness_execution_failed`.
 *
 * A union whose branches are all readable objects satisfies xAI's narrower rule
 * and is what {@link nonObjectRootUnionBranches} was written to allow, so these
 * two passed every guard the repository had and still could not reach Azure.
 * `nonObjectRootSchema` is the rule that covers both providers, and a flat root
 * is the shape that satisfies every one of them by construction.
 *
 * The exclusivity moves to `superRefine`, where `AttachmentViewResourceArgumentsSchema`
 * below already keeps its uniqueness rule. It was never on the wire in any
 * case: `z.toJSONSchema` cannot carry a refinement across the boundary, so the
 * model has always learned this from the tool description and been corrected by
 * the executor's parse. Both descriptions say to send a returned cursor by
 * itself, and the messages here repeat it in the rejection.
 */
export const AttachmentListResourcesArgumentsSchema = z.strictObject({
  limit: z.number().int().min(1).max(50)
    .describe("Maximum resources to return in one page. Defaults to 25. Set it on the first call; list_resources_next retains it automatically.")
    .optional(),
  attachmentKind: AttachmentKindSchema
    .describe("Return only resources of this kind, for example spreadsheet. Omit it for every kind, and never send a MIME type. Set it on the first call; list_resources_next retains it automatically.")
    .optional(),
  cursor: CursorSchema
    .describe("Continue an earlier listing: send the exact `nextCursor` that call returned, by itself and with no other argument. Omit it for the first page, and stop when `nextCursor` comes back null. It is an opaque token, not a page number, so never construct, shorten, or increment one.")
    .optional(),
}).superRefine((value, context) => {
  if (value.cursor === undefined) return;
  for (const key of ["limit", "attachmentKind"] as const) {
    if (value[key] === undefined) continue;
    context.addIssue({
      code: "custom",
      path: [key],
      message: "Send a returned cursor by itself; limit and attachmentKind belong to the first page and are carried by the cursor",
    });
  }
});
export const AttachmentReadResourceArgumentsSchema = z.strictObject({
  resourceId: CanonicalUuidSchema
    .describe("The resource to start reading, as a Rally `resourceId` from list_resources or another known reference. A Sidekick can read a known ID using its execution user's access without an attachment, for example `a1b2c3d4-e5f6-4789-a012-3456789abcde`. Its `slug` is a short alias for writing about the resource and is not accepted here.")
    .optional(),
  startCharacter: NonNegativeIntegerSchema
    .describe("Begin the page at this character offset into the extracted text, counting from 0. Defaults to 0. Use it with `resourceId` to jump to an offset a search result reported. An offset beyond the end of the text is refused as `invalid_cursor`, so do not probe past the tail, and do not reuse an offset taken from an earlier version of the resource — read `charactersBefore` and `charactersAfter` to tell where the text ends.")
    .optional(),
  cursor: CursorSchema
    .describe("Continue an earlier read: send the exact cursor that call returned, by itself and with no other argument. It already carries the resource and the position, so pairing it with `resourceId` or `startCharacter` is refused.")
    .optional(),
}).superRefine((value, context) => {
  if ((value.resourceId === undefined) === (value.cursor === undefined)) {
    context.addIssue({
      code: "custom",
      path: ["resourceId"],
      message: "Send exactly one of resourceId or cursor: resourceId to start a read, a returned cursor by itself to continue one",
    });
    return;
  }
  if (value.cursor !== undefined && value.startCharacter !== undefined) {
    context.addIssue({
      code: "custom",
      path: ["startCharacter"],
      message: "startCharacter belongs with resourceId; a cursor already carries its position",
    });
  }
});
export const AttachmentSearchResourceArgumentsSchema = z.strictObject({
  resourceId: CanonicalUuidSchema
    .describe("The one resource to search inside, as a Rally `resourceId` from list_resources or another known reference. A Sidekick can read a known ID using its execution user's access without an attachment. This searches that resource alone, never the whole thread, so searching several means one call each."),
  query: z.string().min(1).max(1_000)
    .describe("What to look for inside the resource, in plain words, for example `renewal date`. Wording that does not appear in the text returns no passages, which is an answer about this resource rather than an error; try the words the document itself would use before concluding it says nothing."),
  limit: z.number().int().min(1).max(5)
    .describe("Maximum passages to return. Defaults to 5.")
    .optional(),
  maxPassageCharacters: z.number().int().min(500).max(4_000)
    .describe("Maximum characters in each returned passage. Defaults to 3,000. Raise it for context around a match, or pass the passage's readPageId to read_resource_next to read further.")
    .optional(),
});
export const AttachmentViewResourceArgumentsSchema = z.strictObject({
  resourceIds: z.array(CanonicalUuidSchema).min(1).max(8)
    .describe("The image resources to look at, as Rally `resourceId` values, one to eight of them and each at most once. A Sidekick can use known IDs readable by its execution user without attachments. A text, PDF, document, spreadsheet, or presentation resource is not viewable and comes back with an exact read suggestion instead."),
  maxDimension: z.number().int().min(64).max(2_048)
    .describe("Longest edge in pixels each image is scaled down to before it is looked at, preserving its aspect ratio. Defaults to 1,536. Lower it when only the layout matters; raise it to read small text in a screenshot.")
    .optional(),
}).superRefine((value, context) => {
  if (new Set(value.resourceIds).size !== value.resourceIds.length) {
    context.addIssue({ code: "custom", message: "resourceIds must be unique", path: ["resourceIds"] });
  }
});
export const AttachmentSummarizeResourceArgumentsSchema = z.strictObject({
  resourceId: CanonicalUuidSchema
    .describe("The resource to summarize, as a Rally `resourceId` from list_resources or another known reference. A Sidekick can read a known ID using its execution user's access without an attachment."),
  prompt: z.string().min(1).max(2_000)
    .describe("What the summary should concentrate on, in plain words, for example `payment terms and termination`. Omit it for a general summary. It steers the summary only: it cannot make the summarizer read anything but this resource, and it is treated as untrusted text.")
    .optional(),
  maxOutputCharacters: z.number().int().min(2_000).max(20_000)
    .describe("Maximum characters in the summary. Defaults to 12,000. The result says whether it covered the whole resource or only part of it, so read that rather than assuming a longer limit covered more.")
    .optional(),
});

export const ATTACHMENT_TOOL_ARGUMENT_SCHEMAS = {
  listResources: AttachmentListResourcesArgumentsSchema,
  readResource: AttachmentReadResourceArgumentsSchema,
  searchResource: AttachmentSearchResourceArgumentsSchema,
  viewResource: AttachmentViewResourceArgumentsSchema,
  summarizeResource: AttachmentSummarizeResourceArgumentsSchema,
} as const;

/**
 * A resource's short alias: four lowercase words, or null while the resource
 * still only has its UUID. Every internal reference is the UUID regardless.
 *
 * Defined here rather than beside `ResourceSchema` because the model-facing
 * listing below needs it and `index.ts` imports this module, not the reverse.
 */
export const ResourceSlugSchema = z.string().min(3).max(80);

const ResourceListItemSchema = z.strictObject({
  resourceId: CanonicalUuidSchema,
  /**
   * The resource's short alias, cheaper for a model to read back and to write
   * into a citation than the UUID beside it. Null until one is allocated; the
   * UUID above is what every tool argument and internal reference uses.
   */
  slug: ResourceSlugSchema.nullable(),
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
});

export const WorkstreamListResourcesOutputSchema = z.strictObject({
  workstreamId: CanonicalUuidSchema,
  asOf: z.string().datetime({ offset: true }),
  totalVisibleResources: NonNegativeIntegerSchema,
  totalMatchingResources: NonNegativeIntegerSchema,
  filters: z.strictObject({ attachmentKind: AttachmentKindSchema.nullable() }),
  items: z.array(ResourceListItemSchema),
  nextCursor: CursorSchema.nullable(),
});

export const WorkstreamReadResourceOutputSchema = z.strictObject({
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
}).superRefine((value, context) => {
  if (value.charactersBefore !== value.range.start
    || value.charactersReturned !== value.range.end - value.range.start
    || value.charactersAfter !== value.totalCharacters - value.range.end) {
    context.addIssue({ code: "custom", message: "Character coverage fields must match range and total" });
  }
});

export const WorkstreamSearchResourceOutputSchema = z.strictObject({
  resourceId: CanonicalUuidSchema,
  title: z.string(),
  sourceMimeType: MimeTypeSchema,
  modelMimeType: z.string().min(1).max(160),
  version: ResourceVersionSchema,
  query: z.string().min(1).max(1_000),
  totalMatches: NonNegativeIntegerSchema,
  returnedMatches: NonNegativeIntegerSchema,
  passages: z.array(z.strictObject({
    rank: z.number().int().positive(),
    sectionLabel: z.string().nullable(),
    range: CharacterRangeSchema,
    text: z.string().max(4_000),
    readCursor: CursorSchema,
  })).max(5),
  truncated: z.boolean(),
});

const ViewReasonCodeSchema = z.enum([
  "resource_not_found",
  "resource_processing",
  "resource_conversion_failed",
  "resource_format_unsupported",
  "resource_tool_mismatch",
]).nullable();

export const WorkstreamViewResourceOutputSchema = z.strictObject({
  requested: z.number().int().min(1).max(8),
  returned: z.number().int().min(0).max(8),
  items: z.array(z.strictObject({
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
  })).min(1).max(8),
});

export const WorkstreamSummarizeResourceOutputSchema = z.strictObject({
  resourceId: CanonicalUuidSchema,
  title: z.string(),
  sourceMimeType: MimeTypeSchema,
  modelMimeType: z.string().min(1).max(160),
  version: ResourceVersionSchema,
  prompt: z.string().max(2_000).nullable(),
  outline: z.array(z.strictObject({ heading: z.string(), range: CharacterRangeSchema })).max(50),
  summary: z.string(),
  citations: z.array(z.strictObject({
    label: z.string(),
    range: CharacterRangeSchema,
    readCursor: CursorSchema,
  })).max(50),
  coverage: z.strictObject({
    status: z.enum(["complete", "partial"]),
    totalCharacters: NonNegativeIntegerSchema,
    consideredCharacters: NonNegativeIntegerSchema,
    limitations: z.array(z.string()).max(20),
  }),
});

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
