import { MessageAttachmentSchema, ResourceSchema } from "@rally/contracts";
import { describe, expect, it } from "vitest";


/**
 * The failure the contracts were added to remove, checked against the contracts
 * themselves.
 *
 * Parsing a list response means one row that does not fit its schema fails the
 * whole list rather than one field — which is the original incident, reached by
 * a different route. Every column a contract bounds but no `CHECK` constrains is
 * therefore truncated at the read; these cases pin that.
 */
const AT = "2026-08-10T16:10:55.531Z";

describe("the contracts the read boundary has to satisfy", () => {
  it("bounds an upload title and mime type to what the response schema allows", () => {
    // `resources.title` and `resources.mime_type` carry no length constraint,
    // and both are written from a multipart field and a client-supplied header.
    // One over-long upload otherwise 500s `GET /resources` workspace-wide and
    // every transcript page carrying that attachment, permanently.
    expect(() => ResourceSchema.parse({
      id: "00000000-0000-7000-8000-000000000001",
      workspaceId: "00000000-0000-7000-8000-000000000002",
      connectionId: null,
      resourceType: "uploaded_file",
      provider: "avalon_upload",
      providerResourceId: null,
      title: "x".repeat(301),
      mimeType: "text/plain",
      canonicalUrl: null,
      watchEnabled: false,
      watchStatus: "unsupported",
      lastHydratedAt: null,
      createdAt: AT,
      updatedAt: AT,
    })).toThrow();

    expect(() => MessageAttachmentSchema.parse({
      id: "00000000-0000-7000-8000-000000000001",
      fileName: "x".repeat(301),
      mimeType: "text/plain",
      sizeBytes: 1,
      contentAvailable: true,
      createdAt: AT,
    })).toThrow();
  });
});
