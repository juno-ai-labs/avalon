import { describe, expect, it } from "vitest";

import {
  ATTACHMENT_KIND_ENTRIES,
  ATTACHMENT_LIST_RESOURCES_DESCRIPTION,
  ATTACHMENT_TOOL_ARGUMENT_SCHEMAS,
  AttachmentKindSchema,
  WorkstreamReadResourceOutputSchema,
  classifyAttachmentKind,
} from "./attachment-contracts";

const RESOURCE_ID = "019ff769-f7a4-70c8-87a7-16722ff2ce43";

describe("attachment contracts", () => {
  it("keeps every natural-language kind in one registry, schema, and list description", () => {
    const kinds = [
      "image",
      "markdown",
      "pdf",
      "document",
      "spreadsheet",
      "presentation",
      "text",
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

  it("classifies verified MIME first and uses extensions only for generic MIME", () => {
    expect(classifyAttachmentKind({ mimeType: "image/png", fileName: "wrong.docx" })).toBe("image");
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
    expect(view.safeParse({ resourceIds: [RESOURCE_ID, RESOURCE_ID] }).success).toBe(false);
    expect(view.safeParse({ resourceIds: [] }).success).toBe(false);

    const summarize = ATTACHMENT_TOOL_ARGUMENT_SCHEMAS.summarizeResource;
    expect(summarize.safeParse({ resourceId: RESOURCE_ID, prompt: "Focus on risks" }).success).toBe(true);
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
