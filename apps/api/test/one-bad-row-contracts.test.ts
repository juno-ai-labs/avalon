import { MessageAttachmentSchema, ResourceSchema, WorkstreamSchema } from "@rally/contracts";
import { describe, expect, it } from "vitest";

import { StartedWorkOpportunityResponseSchema } from "../src/routes/work-opportunities";

/**
 * The failure the contracts were added to remove, checked against the contracts
 * themselves.
 *
 * Parsing a list response means one row that does not fit its schema fails the
 * whole list rather than one field — which is the original incident, reached by
 * a different route. Every column a contract bounds but no `CHECK` constrains is
 * therefore truncated at the read; these cases pin that, plus the one response
 * schema that demanded a shape its route could not always produce.
 */
const AT = "2026-08-10T16:10:55.531Z";

function workstream(overrides: Record<string, unknown> = {}) {
  return {
    id: "00000000-0000-7000-8000-000000000001",
    workspaceId: "00000000-0000-7000-8000-000000000002",
    title: "Avalon UX",
    titleStatus: "settled",
    objective: "",
    emailAddress: null,
    originType: "automation",
    originLabel: "Weekly digest",
    createdByUserId: "00000000-0000-7000-8000-000000000003",
    automationSubscriptionId: null,
    automationRunId: null,
    plannedFor: null,
    harnessStatus: "completed",
    latestAttentionSequenceNumber: 0,
    readThroughSequenceNumber: 0,
    manualUnreadFromSequenceNumber: null,
    manualUnreadGeneration: 0,
    hasUnread: false,
    youAreMentioned: false,
    firstUnreadSequenceNumber: null,
    lastActivityAt: AT,
    createdAt: AT,
    updatedAt: AT,
    archivedAt: null,
    scope: "workspace",
    systemKind: null,
    modelOverride: null,
    nextPendingWakeup: null,
    pinPosition: null,
    ...overrides,
  };
}

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

describe("starting a work opportunity", () => {
  it("accepts the work stream its fresh-start path actually returns", () => {
    // `WorkOpportunityService.start` has two exits: a replay reloads the detail,
    // a fresh start returns what `workstreams.create` built. Requiring the
    // detail schema here 500s the fresh start after the work stream, its email
    // route and its harness run have all committed — and the retry is refused
    // as already claimed, so the user loses work that did happen.
    const started = {
      workstream: WorkstreamSchema.parse(workstream()),
      messageId: "00000000-0000-7000-8000-000000000004",
      harnessRunId: null,
    };

    expect(() => StartedWorkOpportunityResponseSchema.parse(started)).not.toThrow();
  });
});
