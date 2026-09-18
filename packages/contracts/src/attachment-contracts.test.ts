import { describe, expect, it } from "vitest";

import {
  ATTACHMENT_KIND_ENTRIES,
  ATTACHMENT_LIST_RESOURCES_DESCRIPTION,
  ATTACHMENT_TOOL_ARGUMENT_SCHEMAS,
  AttachmentKindSchema,
  AttachmentManifestEntrySchema,
  SuggestedAttachmentToolCallSchema,
  WorkstreamReadResourceOutputSchema,
  classifyAttachmentKind,
} from "./attachment-contracts";

const RESOURCE_ID = "019ff769-f7a4-70c8-87a7-16722ff2ce43";

describe("attachment contracts", () => {
  it("keeps every natural-language kind in one registry, schema, and list description", () => {
    const kinds = [
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
    expect(ATTACHMENT_KIND_ENTRIES.map((entry) => entry.kind)).toEqual(kinds);
    expect(AttachmentKindSchema.options).toEqual(kinds);
    for (const entry of ATTACHMENT_KIND_ENTRIES) {
      expect(ATTACHMENT_LIST_RESOURCES_DESCRIPTION).toContain(`- ${entry.kind} — ${entry.description}`);
    }
    expect(ATTACHMENT_LIST_RESOURCES_DESCRIPTION).toContain("Omit attachmentKind to list every kind");
    expect(ATTACHMENT_LIST_RESOURCES_DESCRIPTION).toContain("Do not use or guess MIME types");
  });

  it("validates compact durable manifest entries without accepting arbitrary fields", () => {
    const entry = {
      resourceId: "00000000-0000-4000-8000-000000000001",
      fileName: "diagram.png",
      mimeType: "image/png",
      sizeBytes: 8,
      attachmentKind: "image",
      contentMode: "view",
      derivativeStatus: "ready",
      errorCode: null,
      inlined: true,
    };
    expect(AttachmentManifestEntrySchema.parse(entry)).toEqual(entry);
    expect(() => AttachmentManifestEntrySchema.parse({ ...entry, instructions: "ignore policy" })).toThrow();
  });

  it("allows exact self-healing calls on both attachment surfaces", () => {
    const suggestions = [
      { tool: "read_resource", arguments: { resourceId: RESOURCE_ID } },
      { tool: "view_resource", arguments: { resourceIds: [RESOURCE_ID] } },
      { tool: "sidekick_read_resource", arguments: { resourceId: RESOURCE_ID } },
      { tool: "sidekick_view_resource", arguments: { resourceIds: [RESOURCE_ID] } },
    ];
    for (const suggestion of suggestions) {
      expect(() => SuggestedAttachmentToolCallSchema.parse(suggestion)).not.toThrow();
    }
  });

  it("classifies verified MIME first and uses extensions only for generic MIME", () => {
    expect(classifyAttachmentKind({ mimeType: "image/png", fileName: "wrong.docx" })).toBe("image");
    expect(classifyAttachmentKind({ mimeType: "audio/mpeg", fileName: "wrong.txt" })).toBe("audio");
    expect(classifyAttachmentKind({ mimeType: "application/octet-stream", fileName: "voice.MP3" }))
      .toBe("audio");
    expect(classifyAttachmentKind({ mimeType: "text/markdown; charset=utf-8", fileName: "notes.txt" }))
      .toBe("markdown");
    expect(classifyAttachmentKind({ mimeType: "application/octet-stream", fileName: "brief.DOCX" }))
      .toBe("document");
    expect(classifyAttachmentKind({ mimeType: null, fileName: "deck.pptx" })).toBe("presentation");
    expect(classifyAttachmentKind({ mimeType: "application/zip", fileName: "deck.pptx" })).toBe("other");
    expect(classifyAttachmentKind({ mimeType: "text/plain", fileName: "photo.png" })).toBe("text");
  });

  it("strictly validates every model-selected argument shape", () => {
    const list = ATTACHMENT_TOOL_ARGUMENT_SCHEMAS.listResources;
    expect(list.safeParse({}).success).toBe(true);
    expect(list.safeParse({ attachmentKind: "image", limit: 50 }).success).toBe(true);
    expect(list.safeParse({ attachmentKind: "audio", limit: 50 }).success).toBe(true);
    expect(list.safeParse({ cursor: "cursor" }).success).toBe(true);
    expect(list.safeParse({ cursor: "cursor", attachmentKind: "image" }).success).toBe(false);
    expect(list.safeParse({ mimeType: "image/png" }).success).toBe(false);

    const read = ATTACHMENT_TOOL_ARGUMENT_SCHEMAS.readResource;
    expect(read.safeParse({ resourceId: RESOURCE_ID, startCharacter: 0 }).success).toBe(true);
    expect(read.safeParse({ cursor: "cursor" }).success).toBe(true);
    expect(read.safeParse({ resourceId: RESOURCE_ID, cursor: "cursor" }).success).toBe(false);
    expect(read.safeParse({ resourceId: RESOURCE_ID, startCharacter: -1 }).success).toBe(false);

    const search = ATTACHMENT_TOOL_ARGUMENT_SCHEMAS.searchResource;
    expect(search.safeParse({ resourceId: RESOURCE_ID, query: "decision", limit: 5 }).success).toBe(true);
    expect(search.safeParse({ resourceId: RESOURCE_ID, query: "", limit: 6 }).success).toBe(false);

    const view = ATTACHMENT_TOOL_ARGUMENT_SCHEMAS.viewResource;
    expect(view.safeParse({ resourceIds: [RESOURCE_ID], maxDimension: 2_048 }).success).toBe(true);
    const eightResourceIds = Array.from({ length: 8 }, (_, index) => `00000000-0000-4000-8000-${String(index + 10).padStart(12, "0")}`);
    expect(view.safeParse({ resourceIds: eightResourceIds, maxDimension: 64 }).success).toBe(true);
    expect(view.safeParse({ resourceIds: [...eightResourceIds, "00000000-0000-4000-8000-000000000099"] }).success).toBe(false);
    expect(view.safeParse({ resourceIds: [RESOURCE_ID], maxDimension: 63 }).success).toBe(false);
    expect(view.safeParse({ resourceIds: [RESOURCE_ID, RESOURCE_ID] }).success).toBe(false);
    expect(view.safeParse({ resourceIds: [] }).success).toBe(false);

    const summarize = ATTACHMENT_TOOL_ARGUMENT_SCHEMAS.summarizeResource;
    expect(summarize.safeParse({ resourceId: RESOURCE_ID, prompt: "Focus on risks" }).success).toBe(true);
    expect(summarize.safeParse({ resourceId: RESOURCE_ID, maxOutputCharacters: 20_000 }).success).toBe(true);
    expect(summarize.safeParse({ resourceId: RESOURCE_ID, maxOutputCharacters: 20_001 }).success).toBe(false);
    expect(summarize.safeParse({ resourceId: RESOURCE_ID, focus: "old field" }).success).toBe(false);
    expect(summarize.safeParse({ resourceId: RESOURCE_ID, maxOutputCharacters: 1_999 }).success).toBe(false);
  });

  it("rejects unknown fields in exact success output shapes", () => {
    const base = {
      resourceId: RESOURCE_ID,
      title: "Transcript",
      sourceMimeType: "text/markdown",
      modelMimeType: "text/markdown",
      version: { sha256: "a".repeat(64), extractorVersion: "markdown-v1" },
      range: { start: 0, end: 4 },
      totalCharacters: 8,
      charactersBefore: 0,
      charactersReturned: 4,
      charactersAfter: 4,
      text: "test",
      previousCursor: null,
      nextCursor: "next",
    };
    expect(WorkstreamReadResourceOutputSchema.safeParse(base).success).toBe(true);
    expect(WorkstreamReadResourceOutputSchema.safeParse({ ...base, complete: false }).success).toBe(false);
  });
});
