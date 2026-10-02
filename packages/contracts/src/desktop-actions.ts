import { z } from "zod";

/**
 * Desktop actions: a typed request an API agent loop makes of the person's
 * live Rally desktop, and the result the desktop sends back.
 *
 * The loop never holds a `WebContents` or reaches the desktop by any other
 * path. A tool records an action, the conversation's room publishes it as
 * `desktop_action_requested`, the desktop that owns the work executes it
 * through its main-process browser command path, and answers with
 * `answer_desktop_action`. `docs/desktop-actions.md` owns the protocol.
 */

/**
 * Bytes or a JSON value page script left with the desktop. The model and the
 * conversation see only this description; the content stays on the desktop
 * until something the desktop runs (a finish action) reads it by handle.
 */
export const StoredRefSchema = z.strictObject({
  handle: z.string().min(1),
  kind: z.enum(["file", "json"]),
  name: z.string(),
  mimeType: z.string(),
  size: z.number().int().nonnegative(),
});
export type StoredRef = z.infer<typeof StoredRefSchema>;

const coordinate = z.number().finite();

export const SESSION_IMPORT_FAILURE_REASONS = [
  "sign_in_required",
  "not_a_conversation",
  "page_unavailable",
] as const;
export const SessionImportFailureReasonSchema = z.enum(SESSION_IMPORT_FAILURE_REASONS);
export type SessionImportFailureReason = z.infer<typeof SessionImportFailureReasonSchema>;

export const DesktopActionSchema = z.discriminatedUnion("kind", [
  /** An async function body run in the page, with the `rally` helper in scope. */
  z.strictObject({ kind: z.literal("browser.evaluate"), script: z.string().min(1) }),
  z.strictObject({ kind: z.literal("browser.snapshot") }),
  z.strictObject({ kind: z.literal("browser.screenshot") }),
  z.strictObject({ kind: z.literal("browser.click"), x: coordinate, y: coordinate }),
  z.strictObject({
    kind: z.literal("browser.scroll"), x: coordinate, y: coordinate, deltaX: coordinate, deltaY: coordinate,
  }),
  z.strictObject({ kind: z.literal("browser.type"), text: z.string() }),
  z.strictObject({ kind: z.literal("browser.key"), key: z.string().min(1) }),
  z.strictObject({ kind: z.literal("browser.navigate"), url: z.string().min(1) }),
  /**
   * A file on an origin the page's own script may not read, loaded through the
   * tab's network stack with its session, and kept as a stored file.
   */
  z.strictObject({
    kind: z.literal("browser.load"),
    url: z.string().min(1),
    name: z.string().min(1).optional(),
    mimeType: z.string().min(1).optional(),
  }),
  /**
   * The responses the tab's page has received since it last navigated, as the
   * browser recorded them. `urlContains` and `resourceType` narrow the list.
   */
  z.strictObject({
    kind: z.literal("browser.network_list"),
    urlContains: z.string().min(1).optional(),
    resourceType: z.string().min(1).optional(),
  }),
  /**
   * One recorded response's body: placed in the page as
   * `window.__rallyNetwork[requestId]` (parsed when it is JSON) for page
   * script to work on, and, when `length` is given, that many characters of
   * its text from `offset` returned directly.
   */
  z.strictObject({
    kind: z.literal("browser.network_read"),
    requestId: z.string().min(1),
    offset: z.number().int().nonnegative().optional(),
    length: z.number().int().positive().optional(),
  }),
  /** Hand the conversation the agent assembled to the desktop that started the import. */
  z.strictObject({ kind: z.literal("session_import.finish"), title: z.string().min(1), messages: z.string().min(1) }),
  z.strictObject({ kind: z.literal("session_import.fail"), reason: SessionImportFailureReasonSchema }),
]);
export type DesktopAction = z.infer<typeof DesktopActionSchema>;
export type DesktopActionKind = DesktopAction["kind"];

const PageSchema = z.strictObject({ url: z.string(), title: z.string() });

/** One result shape per action kind; the server parses it against the kind it asked for. */
export const DesktopActionResultSchemas = {
  "browser.evaluate": PageSchema.extend({ value: z.unknown(), stored: z.array(StoredRefSchema) }),
  "browser.snapshot": PageSchema.extend({ outline: z.string() }),
  "browser.screenshot": PageSchema.extend({
    mimeType: z.literal("image/jpeg"),
    data: z.string().min(1),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  }),
  "browser.click": PageSchema,
  "browser.scroll": PageSchema,
  "browser.type": PageSchema,
  "browser.key": PageSchema,
  "browser.navigate": PageSchema,
  "browser.load": z.strictObject({ stored: StoredRefSchema }),
  "browser.network_list": z.strictObject({
    responses: z.array(z.strictObject({
      requestId: z.string(),
      url: z.string(),
      method: z.string(),
      status: z.number().int(),
      mimeType: z.string(),
      resourceType: z.string(),
      size: z.number().int().nonnegative().nullable(),
      cached: z.boolean(),
    })),
  }),
  "browser.network_read": z.strictObject({
    /** The page expression that now holds the body. */
    variable: z.string(),
    mimeType: z.string(),
    /** Characters of text, or bytes for a binary body. */
    size: z.number().int().nonnegative(),
    json: z.boolean(),
    /** A JSON object's top-level keys, or an array's length, to orient the next script. */
    keys: z.array(z.string()).optional(),
    length: z.number().int().nonnegative().optional(),
    /** The requested slice of the body's text. */
    text: z.string().optional(),
  }),
  "session_import.finish": z.strictObject({
    workstreamId: z.string().min(1),
    messages: z.number().int().nonnegative(),
  }),
  "session_import.fail": z.strictObject({}),
} as const satisfies Record<DesktopActionKind, z.ZodType>;
export type DesktopActionResult<K extends DesktopActionKind> = z.infer<(typeof DesktopActionResultSchemas)[K]>;

/**
 * Why the desktop could not do what was asked. Each is a code the model can
 * act on; `message` carries the detail (a page script's own error text, a
 * schema issue naming the field), never Rally state.
 */
export const DESKTOP_ACTION_FAILURE_CODES = [
  /** The action does not parse, or is not one this desktop executes. */
  "invalid_action",
  /** The tab the work is pinned to has closed. */
  "tab_closed",
  /** The tab is no longer on a page this work may drive. */
  "origin_not_allowed",
  /** Page script threw or rejected. */
  "script_error",
  /** The value page script returned is not JSON. */
  "value_not_serializable",
  /** A browser command failed: navigation, input, capture or a network load. */
  "browser_command_failed",
  /** A stored item is over the per-file byte cap. */
  "file_too_large",
  /** A handle names nothing the desktop holds. */
  "unknown_handle",
  /** What the agent assembled does not meet the import contract; `message` names the field. */
  "invalid_conversation",
  /** Rally refused the import; `message` names the API's error code. */
  "import_rejected",
  /**
   * The answer is larger than the conversation can record. Set by the room,
   * which keeps every answer durably, never by a desktop.
   */
  "result_too_large",
] as const;
export const DesktopActionFailureCodeSchema = z.enum(DESKTOP_ACTION_FAILURE_CODES);
export type DesktopActionFailureCode = z.infer<typeof DesktopActionFailureCodeSchema>;

export const DesktopActionOutcomeSchema = z.discriminatedUnion("ok", [
  z.strictObject({ ok: z.literal(true), result: z.unknown() }),
  z.strictObject({ ok: z.literal(false), code: DesktopActionFailureCodeSchema, message: z.string() }),
]);
export type DesktopActionOutcome = z.infer<typeof DesktopActionOutcomeSchema>;

export const DesktopActionRequestSchema = z.strictObject({
  id: z.string().min(1),
  action: DesktopActionSchema,
});
export type DesktopActionRequest = z.infer<typeof DesktopActionRequestSchema>;

/**
 * The messages page script assembles and stores as JSON for
 * `session_import.finish`. A file is a stored handle, or a named file the page
 * could not copy and why.
 */
export const BrowserImportFileSchema = z.union([
  z.strictObject({
    handle: z.string().min(1),
    name: z.string().min(1).optional(),
    mimeType: z.string().min(1).optional(),
    kind: z.enum(["attachment", "artifact"]).optional(),
  }),
  z.strictObject({
    unavailable: z.strictObject({ name: z.string().min(1), reason: z.string().min(1) }),
  }),
]);
export const BrowserImportMessagesSchema = z.array(z.strictObject({
  role: z.enum(["user", "assistant"]),
  text: z.string(),
  sourceMessageId: z.string().min(1),
  files: z.array(BrowserImportFileSchema).optional(),
})).min(1);
export type BrowserImportMessages = z.infer<typeof BrowserImportMessagesSchema>;
