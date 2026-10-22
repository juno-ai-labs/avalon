import { describe, expect, it } from "vitest";
import { asWorkspaceId } from "@rally/contracts";
import { authorizedConnection, createGoogleConnector, type ConnectorTextPages, type ConnectorToolContext } from "./index";
import { readConnectorTextPage } from "./text-pages";

const workspaceId = asWorkspaceId("11111111-1111-4111-8111-111111111111");
const snapshotId = "22222222-2222-4222-8222-222222222222";
function context(): ConnectorToolContext {
  let snapshot = new Uint8Array();
  // The host storage collaborator is exercised on real R2 in connector-text-pages.test.ts.
  const textPages: ConnectorTextPages = {
    maxSourceBytes: 8 * 1024 * 1024,
    async write(bytes) { snapshot = bytes.slice(); return snapshotId; },
    async read(_id, offset, length) { return { bytes: snapshot.slice(offset, offset + length), totalBytes: snapshot.byteLength }; },
  };
  return { signal: new AbortController().signal, textPages, principal: { type: "workspace", workspaceId },
    connection: authorizedConnection({ id: "connection", workspaceId, scope: "workspace", ownerUserId: null,
      grantedScopes: ["drive.read", "docs.read", "sheets.read"], credentials: { accessToken: "test" }, cursor: {}, config: {} }) };
}
function connector(fetcher: typeof fetch) {
  return createGoogleConnector({ clientId: "test", clientSecret: "test", redirectUri: "https://example.test/oauth", fetch: fetcher });
}
const metadata = (mimeType = "application/vnd.google-apps.document") => Response.json({ id: "file", name: "Notes", mimeType });

describe("Google file text", () => {
  it("rejects plain-text spreadsheet exports with the field and usable alternatives before exporting", async () => {
    const requests: string[] = [];
    const adapter = connector(async input => { requests.push(String(input)); return metadata("application/vnd.google-apps.spreadsheet"); });
    await expect(adapter.executeTool("drive.export", { fileId: "file", mimeType: "text/plain" }, context()))
      .rejects.toMatchObject({ details: { field: "mimeType", reason: "unsupported_export_format" }, message: expect.stringContaining("sheets.read_values") });
    expect(requests.some(url => url.includes("/export"))).toBe(false);
  });

  it("exports spreadsheets as CSV with an explicit first-sheet coverage notice", async () => {
    const adapter = connector(async input => String(input).includes("/export") ? new Response("name,count\nAda,2") : metadata("application/vnd.google-apps.spreadsheet"));
    expect((await adapter.executeTool("drive.export", { fileId: "file", mimeType: "text/csv" }, context())).output)
      .toMatchObject({ text: "name,count\nAda,2", contentScope: "first_sheet_csv", hasMore: false });
  });

  it("routes Google Doc downloads through Docs rather than Drive export", async () => {
    const requests: string[] = [];
    const adapter = connector(async input => {
      requests.push(String(input));
      return String(input).includes("docs.googleapis.com") ? Response.json({ documentId: "file", body: { content: [{ paragraph: { elements: [{ textRun: { content: "Native document text" } }] } }] } }) : metadata();
    });
    expect((await adapter.executeTool("drive.download", { fileId: "file" }, context())).output).toMatchObject({ textContent: "Native document text", hasMore: false });
    expect(requests.some(url => url.includes("/export"))).toBe(false);
    expect(requests.some(url => url.includes("docs.googleapis.com"))).toBe(true);
  });

  it("directs Google Sheet downloads to native range reads", async () => {
    await expect(connector(async () => metadata("application/vnd.google-apps.spreadsheet"))
      .executeTool("drive.download", { fileId: "file" }, context())).rejects.toMatchObject({
        details: { reason: "native_spreadsheet_requires_range", field: "fileId" }, message: expect.stringContaining("sheets.read_values"),
      });
  });

  it("reads native Slides with their supported plain-text export", async () => {
    const adapter = connector(async input => String(input).includes("/export")
      ? new Response("Slide one\nSlide two") : metadata("application/vnd.google-apps.presentation"));
    expect((await adapter.executeTool("drive.download", { fileId: "file" }, context())).output)
      .toMatchObject({ textContent: "Slide one\nSlide two", hasMore: false });
  });

  it("returns every byte across export pages from one immutable snapshot, including split UTF-8 characters", async () => {
    const text = "a".repeat(127999) + "🙂second page";
    let exports = 0;
    const adapter = connector(async input => {
      if (String(input).includes("/export")) { exports++; return new Response(exports === 1 ? text : "changed source"); }
      return metadata();
    });
    const ctx = context();
    const first = await adapter.executeTool("drive.export", { fileId: "file", mimeType: "text/plain" }, ctx);
    const next = await adapter.executeTool("drive.export", first.pagination!.continuations[0]!.input, ctx);
    expect(first.output).toMatchObject({ text: "a".repeat(127999), hasMore: true, startByte: 0 });
    expect(next.output).toMatchObject({ text: "🙂second page", hasMore: false, startByte: 127999 });
    expect(next.pagination).toEqual({ continuations: [] });
    expect(JSON.stringify(first.output)).not.toContain(snapshotId);
    expect(exports).toBe(1);
  });

  it("reads a native Doc larger than the former JSON response budget to its final page", async () => {
    const adapter = connector(async input => String(input).includes("docs.googleapis.com")
      ? Response.json({ documentId: "file", body: { textRun: { content: "x".repeat(640000) + "last line" } } }) : metadata());
    const ctx = context();
    let page = await adapter.executeTool("docs.read_document", { documentId: "file" }, ctx);
    let total = 0;
    while (page.pagination!.continuations.length) {
      total += (page.output as { bytes: number }).bytes;
      page = await adapter.executeTool("docs.read_document", page.pagination!.continuations[0]!.input, ctx);
    }
    expect(total).toBe(640000);
    expect(page.output).toMatchObject({ textContent: "last line", hasMore: false, totalBytes: 640009 });
  });

  it("pages native Docs beyond the former text truncation and rechecks access on continuation", async () => {
    let denied = false;
    const adapter = connector(async input => String(input).includes("docs.googleapis.com")
      ? Response.json({ documentId: "file", body: { textRun: { content: "x".repeat(128000) + "the ending" } } })
      : denied ? Response.json({ error: { code: 404 } }, { status: 404 }) : metadata());
    const ctx = context();
    const first = await adapter.executeTool("docs.read_document", { documentId: "file" }, ctx);
    const continuation = first.pagination!.continuations[0]!.input;
    expect((await adapter.executeTool("docs.read_document", continuation, ctx)).output).toMatchObject({ textContent: "the ending", hasMore: false });
    denied = true;
    await expect(adapter.executeTool("docs.read_document", continuation, ctx)).rejects.toMatchObject({ code: "provider_error" });
  });

  it("reports only allowlisted Google export reasons, never the provider's message or unknown reason", async () => {
    const adapter = connector(async input => String(input).includes("/export")
      ? Response.json({ error: { message: "PRIVATE provider text", errors: [{ reason: "PRIVATE" }, { reason: "exportSizeLimitExceeded" }] } }, { status: 403 }) : metadata());
    const error = await adapter.executeTool("drive.export", { fileId: "file", mimeType: "text/plain" }, context()).catch(error => error);
    expect(error).toMatchObject({ code: "provider_error", details: { reason: "exportSizeLimitExceeded", field: "fileId" }, message: expect.stringContaining("docs.read_document") });
    expect(JSON.stringify(error)).not.toContain("PRIVATE");
  });

  it("keeps source truncation explicit after the final stored page", async () => {
    const adapter = connector(async input => String(input).includes("docs.googleapis.com")
      ? Response.json({ documentId: "file", body: [{ textRun: { content: "x".repeat(128000) + "ending" } }, ...Array.from({ length: 100000 }, () => ({}))] })
      : metadata());
    const ctx = context();
    const first = await adapter.executeTool("docs.read_document", { documentId: "file" }, ctx);
    expect(first.output).toMatchObject({ sourceTruncated: true, hasMore: true });
    const last = await adapter.executeTool("docs.read_document", first.pagination!.continuations[0]!.input, ctx);
    expect(last.output).toMatchObject({ textContent: "ending", hasMore: false, sourceTruncated: true, contentTruncated: true, textTruncated: true });
  });

  it("keeps a complete small text page independent of snapshot storage", async () => {
    expect(await readConnectorTextPage({ text: "hello", pageBytes: 128000 })).toEqual({ text: "hello", bytes: 5, startByte: 0, totalBytes: 5, hasMore: false, cursor: null });
  });
});
