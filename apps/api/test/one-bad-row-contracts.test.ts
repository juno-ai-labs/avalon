import { MessageAttachmentSchema, ResourceSchema, WorkstreamSchema } from "@avalon/contracts";
import { describe, expect, it } from "vitest";

import { toWorkstream } from "../src/mappers/workstream";
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

function workstreamRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "00000000-0000-7000-8000-000000000001",
    workspace_id: "00000000-0000-7000-8000-000000000002",
    title: "Avalon UX",
    objective: "",
    origin_type: "automation",
    origin_label: "Weekly digest",
    created_by_user_id: "00000000-0000-7000-8000-000000000003",
    harness_status: "completed",
    title_status: "settled",
    scope: "workspace",
    system_kind: null,
    last_activity_at: AT,
    created_at: AT,
    updated_at: AT,
    next_pending_wakeup_at: null,
    next_pending_wakeup_prompt_prefix: null,
    ...overrides,
  };
}

describe("one over-long value degrades a field, not a list", () => {
  it("truncates an automation name the label contract does not allow", () => {
    // `automation_templates.name` allows 140 characters and `originLabel`
    // allows 120, so an automation named in that gap made every work stream it
    // created fail `GET /workstreams` — the sidebar — for the whole workspace.
    const row = workstreamRow({ origin_label: "N".repeat(140) });

    const workstream = WorkstreamSchema.parse(toWorkstream(row));

    expect(workstream.originLabel).toHaveLength(120);
  });

  it("truncates a title and objective past their contract bounds", () => {
    const row = workstreamRow({ title: "T".repeat(400), objective: "O".repeat(5_000) });

    const workstream = WorkstreamSchema.parse(toWorkstream(row));

    expect(workstream.title).toHaveLength(180);
    expect(workstream.objective).toHaveLength(4_000);
  });

  it("still fails, naming the column, when a row leaves the state its table allows", () => {
    // The bound is for columns with no constraint of their own. An enum that
    // mirrors a real CHECK stays strict: a value outside it is drift, not a
    // long string, and silently coercing it is what produced the anonymous 500.
    expect(() => toWorkstream(workstreamRow({ harness_status: "paused" })))
      .toThrow(/harness_status/u);
  });
});

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
      workstream: WorkstreamSchema.parse(toWorkstream(workstreamRow())),
      messageId: "00000000-0000-7000-8000-000000000004",
      harnessRunId: null,
    };

    expect(() => StartedWorkOpportunityResponseSchema.parse(started)).not.toThrow();
  });
});
