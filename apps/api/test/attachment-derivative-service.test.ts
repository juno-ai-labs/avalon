import { strToU8, zipSync } from "fflate";
import { describe, expect, it, vi } from "vitest";
import {
  ATTACHMENT_TEXT_EXTRACTOR_VERSION,
  buildAttachmentDerivative,
  materializeAttachmentDerivative,
  type AuthorizedDerivativeResource,
} from "../src/services/attachment-derivative-service";
import { createCloudflareTestBinding, createTestD1Database } from "./helpers/cloudflare-test";

const encoder = new TextEncoder();

describe("attachment derivative conversion", () => {
  it("preserves a complete long Markdown attachment without the legacy 60,000-character cutoff", async () => {
    const source = `# Transcript\n\n${"first half\n".repeat(6_000)}## Evidence after cutoff\n${"second half\n".repeat(5_000)}`;

    const result = await buildAttachmentDerivative({
      bytes: encoder.encode(source),
      fileName: "transcript.md",
      mimeType: "text/markdown",
    });

    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.text).toBe(source);
    expect(result.text.length).toBeGreaterThan(60_000);
    expect(result.modelMimeType).toBe("text/markdown");
    expect(result.metadata.extractionMethod).toBe("utf8");
    expect(result.extractorVersion).toBe(ATTACHMENT_TEXT_EXTRACTOR_VERSION);
  });

  it("reads CSV and generic TSV sources through the plain-text converter", async () => {
    const csvSource = "month,total\nJuly,42\nAugust,57";
    const tsvSource = "owner\tstatus\nAdam\tready";

    const [csv, applicationCsv, genericTsv] = await Promise.all([
      buildAttachmentDerivative({
        bytes: encoder.encode(csvSource),
        fileName: "forecast.csv",
        mimeType: "text/csv",
      }),
      buildAttachmentDerivative({
        bytes: encoder.encode(csvSource),
        fileName: "forecast.csv",
        mimeType: "application/csv",
      }),
      buildAttachmentDerivative({
        bytes: encoder.encode(tsvSource),
        fileName: "owners.tsv",
        mimeType: "application/octet-stream",
      }),
    ]);

    for (const [result, expected] of [[csv, csvSource], [applicationCsv, csvSource], [genericTsv, tsvSource]] as const) {
      expect(result.status).toBe("ready");
      if (result.status !== "ready") continue;
      expect(result.text).toBe(expected);
      expect(result.modelMimeType).toBe("text/plain");
      expect(result.metadata.extractionMethod).toBe("utf8");
    }
  });

  it("preserves semantic Word structures, linked text, headers, footnotes, and endnotes", async () => {
    const docx = zipSync({
      "word/document.xml": strToU8(`
        <w:document xmlns:w="w" xmlns:r="r"><w:body>
          <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Roadmap</w:t></w:r></w:p>
          <w:p><w:pPr><w:numPr/></w:pPr><w:r><w:t>First item</w:t></w:r></w:p>
          <w:p><w:hyperlink r:id="rId9"><w:r><w:t>Product site</w:t></w:r></w:hyperlink></w:p>
          <w:tbl><w:tr><w:tc><w:p><w:r><w:t>Owner</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Adam</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
        </w:body></w:document>`),
      "word/_rels/document.xml.rels": strToU8('<Relationships><Relationship Id="rId9" Target="https://example.test"/></Relationships>'),
      "word/header1.xml": strToU8("<w:hdr><w:p><w:r><w:t>Confidential header</w:t></w:r></w:p></w:hdr>"),
      "word/footnotes.xml": strToU8("<w:footnotes><w:footnote w:id=\"1\"><w:p><w:r><w:t>Footnote body</w:t></w:r></w:p></w:footnote></w:footnotes>"),
      "word/endnotes.xml": strToU8("<w:endnotes><w:endnote w:id=\"1\"><w:p><w:r><w:t>Endnote body</w:t></w:r></w:p></w:endnote></w:endnotes>"),
    });

    const result = await buildAttachmentDerivative({ bytes: docx, fileName: "roadmap.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });

    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.text).toContain("# Roadmap");
    expect(result.text).toContain("- First item");
    expect(result.text).toContain("[Product site](https://example.test)");
    expect(result.text).toContain("| Owner | Adam |");
    expect(result.text).toContain("## Header 1\n\nConfidential header");
    expect(result.text).toContain("## Footnotes\n\nFootnote body");
    expect(result.text).toContain("## Endnotes\n\nEndnote body");
  });

  it("keeps presentation slide order, speaker notes, spreadsheet names, formulas, and display values", async () => {
    const pptx = zipSync({
      "ppt/slides/slide2.xml": strToU8("<p:sld><a:p><a:r><a:t>Second slide</a:t></a:r></a:p></p:sld>"),
      "ppt/slides/slide1.xml": strToU8("<p:sld><a:p><a:r><a:t>First slide</a:t></a:r></a:p><a:tbl><a:tr><a:tc><a:p><a:r><a:t>A</a:t></a:r></a:p></a:tc><a:tc><a:p><a:r><a:t>B</a:t></a:r></a:p></a:tc></a:tr></a:tbl></p:sld>"),
      "ppt/notesSlides/notesSlide1.xml": strToU8("<p:notes><a:p><a:r><a:t>Say this aloud</a:t></a:r></a:p></p:notes>"),
    });
    const xlsx = zipSync({
      "xl/workbook.xml": strToU8('<workbook xmlns:r="r"><sheets><sheet name="Forecast" sheetId="1" r:id="rId1"/></sheets></workbook>'),
      "xl/_rels/workbook.xml.rels": strToU8('<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>'),
      "xl/sharedStrings.xml": strToU8("<sst><si><t>Revenue</t></si></sst>"),
      "xl/worksheets/sheet1.xml": strToU8('<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><f>SUM(B2:B3)</f><v>42</v></c></row></sheetData></worksheet>'),
    });

    const [deck, workbook] = await Promise.all([
      buildAttachmentDerivative({ bytes: pptx, fileName: "deck.pptx", mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation" }),
      buildAttachmentDerivative({ bytes: xlsx, fileName: "book.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }),
    ]);

    expect(deck.status === "ready" ? deck.text : "").toMatch(/^# Slide 1[\s\S]*First slide[\s\S]*# Slide 2[\s\S]*Second slide/u);
    expect(deck.status === "ready" ? deck.text : "").toContain("## Speaker notes\n\nSay this aloud");
    expect(workbook.status === "ready" ? workbook.text : "").toContain("# Sheet: Forecast");
    expect(workbook.status === "ready" ? workbook.text : "").toContain("A1: Revenue");
    expect(workbook.status === "ready" ? workbook.text : "").toContain("B1: 42 (formula: SUM(B2:B3))");
  });

  it("extracts PDFs page by page and invokes bounded OCR only for materially empty documents", async () => {
    const textPdf = await buildAttachmentDerivative({
      bytes: encoder.encode("%PDF fixture"), fileName: "text.pdf", mimeType: "application/pdf",
      pdfExtractor: async () => ({ pageCount: 2, pages: ["Page one", "Page two"] }),
    });
    const ocr = vi.fn(async () => ({ pages: ["Scanned words"], method: "provider_ocr" as const }));
    const scannedPdf = await buildAttachmentDerivative({
      bytes: encoder.encode("%PDF scanned"), fileName: "scan.pdf", mimeType: "application/pdf",
      pdfExtractor: async () => ({ pageCount: 1, pages: ["   "] }), ocr,
    });

    expect(textPdf.status === "ready" ? textPdf.text : "").toBe("# Page 1\n\nPage one\n\n# Page 2\n\nPage two");
    expect(textPdf.status === "ready" ? textPdf.metadata.extractionMethod : "").toBe("pdf_text");
    expect(scannedPdf.status === "ready" ? scannedPdf.text : "").toBe("# Page 1\n\nScanned words");
    expect(scannedPdf.status === "ready" ? scannedPdf.metadata.extractionMethod : "").toBe("provider_ocr");
    expect(ocr).toHaveBeenCalledOnce();
  });

  it("trusts a verified MIME type before a contradictory filename extension", async () => {
    const pdfExtractor = vi.fn(async () => ({ pageCount: 1, pages: ["Verified PDF"] }));
    const [pdf, disguisedArchive, genericMarkdown] = await Promise.all([
      buildAttachmentDerivative({
        bytes: encoder.encode("%PDF fixture"),
        fileName: "misleading.txt",
        mimeType: "application/pdf",
        pdfExtractor,
      }),
      buildAttachmentDerivative({
        bytes: zipSync({ "word/document.xml": strToU8("<w:document/>") }),
        fileName: "misleading.docx",
        mimeType: "application/zip",
      }),
      buildAttachmentDerivative({
        bytes: encoder.encode("# Generic Markdown"),
        fileName: "notes.md",
        mimeType: "application/octet-stream",
      }),
    ]);

    expect(pdf.status === "ready" ? pdf.modelMimeType : null).toBe("text/markdown");
    expect(pdf.status === "ready" ? pdf.text : null).toContain("Verified PDF");
    expect(disguisedArchive).toMatchObject({ status: "unsupported" });
    expect(genericMarkdown.status === "ready" ? genericMarkdown.modelMimeType : null).toBe("text/markdown");
    expect(pdfExtractor).toHaveBeenCalledOnce();
  });

  it("fails explicitly for invalid UTF-8, corrupt or encrypted Office data, and unsupported binary content", async () => {
    const [invalidText, corruptOffice, encryptedOffice, unsupported] = await Promise.all([
      buildAttachmentDerivative({ bytes: new Uint8Array([0xc3, 0x28]), fileName: "bad.md", mimeType: "text/markdown" }),
      buildAttachmentDerivative({ bytes: encoder.encode("not a zip"), fileName: "bad.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }),
      buildAttachmentDerivative({ bytes: new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), fileName: "encrypted.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }),
      buildAttachmentDerivative({ bytes: new Uint8Array([0, 1, 2]), fileName: "clip.mp4", mimeType: "video/mp4" }),
    ]);

    expect(invalidText).toMatchObject({ status: "failed", errorCode: "invalid_utf8" });
    expect(corruptOffice).toMatchObject({ status: "failed", errorCode: "invalid_office_archive" });
    expect(encryptedOffice).toMatchObject({ status: "failed", errorCode: "office_encryption_unsupported" });
    expect(unsupported).toMatchObject({ status: "unsupported", errorCode: "resource_format_unsupported" });
  });

  it("rejects Office entity expansion and compressed-archive size bombs before rendering", async () => {
    const entityDocument = zipSync({
      "word/document.xml": strToU8('<!DOCTYPE w:document [<!ENTITY leak "blocked">]><w:document><w:body><w:p><w:r><w:t>&leak;</w:t></w:r></w:p></w:body></w:document>'),
    });
    const oversizedXml = zipSync({
      "word/document.xml": strToU8(`<w:document><w:body><w:p><w:r><w:t>${"x".repeat(3 * 1_024 * 1_024)}</w:t></w:r></w:p></w:body></w:document>`),
    });
    const expandedArchive = zipSync(Object.fromEntries([
      ["word/document.xml", "Document"],
      ["word/header1.xml", "One"],
      ["word/header2.xml", "Two"],
      ["word/header3.xml", "Three"],
      ["word/header4.xml", "Four"],
    ].map(([name, label]) => [
      name,
      strToU8(`<w:document><w:body><w:p><w:r><w:t>${label}${"x".repeat(2_600_000)}</w:t></w:r></w:p></w:body></w:document>`),
    ])));

    const [entity, xmlLimit, archiveLimit] = await Promise.all([
      buildAttachmentDerivative({ bytes: entityDocument, fileName: "entity.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }),
      buildAttachmentDerivative({ bytes: oversizedXml, fileName: "xml-limit.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }),
      buildAttachmentDerivative({ bytes: expandedArchive, fileName: "archive-limit.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }),
    ]);

    expect(entity).toMatchObject({ status: "failed", errorCode: "office_xml_entities_forbidden" });
    expect(xmlLimit).toMatchObject({ status: "failed", errorCode: "office_xml_too_large" });
    expect(archiveLimit).toMatchObject({ status: "failed", errorCode: "office_archive_too_large" });
  });

  it("rejects partial OCR", async () => {
    const partialOcr = await buildAttachmentDerivative({
      bytes: encoder.encode("%PDF scanned"),
      fileName: "partial.pdf",
      mimeType: "application/pdf",
      pdfExtractor: async () => ({ pageCount: 2, pages: ["", ""] }),
      ocr: async () => ({ pages: ["one page only"], method: "provider_ocr" }),
    });

    expect(partialOcr).toMatchObject({ status: "failed", errorCode: "pdf_ocr_incomplete" });
  });

  it("fails at bounded source, derivative, PDF, and deadline limits", async () => {
    const [empty, sourceTooLarge, derivativeTooLarge, pageLimit, timedOut] = await Promise.all([
      buildAttachmentDerivative({ bytes: new Uint8Array(), fileName: "empty.txt", mimeType: "text/plain" }),
      buildAttachmentDerivative({ bytes: new Uint8Array(8 * 1_024 * 1_024 + 1), fileName: "large.txt", mimeType: "text/plain" }),
      buildAttachmentDerivative({ bytes: encoder.encode("x".repeat(2_000_001)), fileName: "large.txt", mimeType: "text/plain" }),
      buildAttachmentDerivative({
        bytes: encoder.encode("%PDF-1.7"),
        fileName: "many-pages.pdf",
        mimeType: "application/pdf",
        pdfExtractor: async () => ({ pageCount: 201, pages: [] }),
      }),
      buildAttachmentDerivative({
        bytes: encoder.encode("%PDF-1.7"),
        fileName: "stuck.pdf",
        mimeType: "application/pdf",
        pdfExtractor: async () => new Promise(() => undefined),
        timeoutMs: 5,
      }),
    ]);
    expect(empty).toMatchObject({ status: "failed", errorCode: "empty_source" });
    expect(sourceTooLarge).toMatchObject({ status: "failed", errorCode: "source_too_large" });
    expect(derivativeTooLarge).toMatchObject({ status: "failed", errorCode: "derivative_too_large" });
    expect(pageLimit).toMatchObject({ status: "failed", errorCode: "pdf_page_limit_exceeded" });
    expect(timedOut).toMatchObject({ status: "failed", errorCode: "conversion_timeout" });
  });

  it("aborts an in-flight asynchronous converter", async () => {
    const controller = new AbortController();
    const result = buildAttachmentDerivative({
      bytes: encoder.encode("%PDF-1.7"),
      fileName: "scan.pdf",
      mimeType: "application/pdf",
      pdfExtractor: async () => new Promise(() => undefined),
      signal: controller.signal,
    });
    controller.abort("test_abort");
    await expect(result).resolves.toMatchObject({ status: "failed", errorCode: "conversion_aborted" });
  });

  it("releases an aborted shared materialization claim without persisting a failure", async () => {
    const controller = new AbortController();
    const statements: string[] = [];
    const database = createTestD1Database({
      prepare(sql: string) {
        statements.push(sql);
        return { bind() { return { async run() { return { meta: { changes: 1 } }; } }; } };
      },
    });
    const bytes = encoder.encode("%PDF-1.7\nfixture");
    const bucket = createCloudflareTestBinding<R2Bucket>({
      async get() {
        return {
          size: bytes.byteLength,
          async arrayBuffer() { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); },
        };
      },
    });
    const resource: AuthorizedDerivativeResource = {
      id: "aborted-resource", workspaceId: "workspace-1", fileName: "scan.pdf", mimeType: "application/pdf",
      contentRef: "original", contentSha256: "a".repeat(64), modelContentRef: null, modelMimeType: null,
      modelContentSha256: null, modelContentStatus: "pending", modelContentExtractorVersion: null,
      modelContentCharacterCount: null, modelContentClaimedAt: null, modelContentClaimId: null,
    };
    const result = materializeAttachmentDerivative(database, bucket, resource, {
      signal: controller.signal,
      pdfExtractor: async () => new Promise(() => undefined),
    });

    controller.abort("lightbox_closed");

    await expect(result).resolves.toEqual({ status: "processing", retryAfterMs: 250 });
    expect(statements.some((sql) => sql.includes("SET model_content_status = 'pending'"))).toBe(true);
    expect(statements.some((sql) => sql.includes("SET model_content_status = ?"))).toBe(false);
  });

  it("allows one concurrent materialization claim and reuses the atomically selected version", async () => {
    const source = encoder.encode("# Current\n\nThe complete reusable derivative.");
    const state = { status: "pending", contentRef: null as string | null, mime: null as string | null, sha: null as string | null, count: null as number | null };
    const statements: Array<{ sql: string; values: unknown[] }> = [];
    const database = createTestD1Database({
      prepare(sql: string) {
        return {
          bind(...values: unknown[]) {
            const statement = { sql, values };
            statements.push(statement);
            return {
              async run() {
                if (sql.includes("SET model_content_status = 'processing'")) {
                  if (state.status === "processing" || state.status === "ready") return { meta: { changes: 0 } };
                  state.status = "processing";
                }
                if (sql.includes("model_content_ref = ?")) {
                  if (state.status !== "processing") return { meta: { changes: 0 } };
                  state.status = "ready";
                  state.contentRef = String(values[0]);
                  state.mime = String(values[1]);
                  state.sha = String(values[2]);
                  state.count = Number(values[5]);
                }
                return { meta: { changes: 1 } };
              },
            };
          },
        };
      },
      async batch(batch: D1PreparedStatement[]) {
        return Promise.all(batch.map((statement) => statement.run()));
      },
    });
    const objects: Record<string, Uint8Array> = { original: source };
    const gets: string[] = [];
    const puts: string[] = [];
    const bucket = createCloudflareTestBinding<R2Bucket>({
      async get(key: string) {
        gets.push(key);
        const value = objects[key];
        return value ? { async arrayBuffer() { return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength); } } : null;
      },
      async put(key: string, value: ArrayBuffer) {
        puts.push(key);
        objects[key] = new Uint8Array(value);
        return {};
      },
      async delete(key: string) { delete objects[key]; },
    });
    const resource: AuthorizedDerivativeResource = {
      id: "resource-1", workspaceId: "workspace-1", fileName: "brief.md", mimeType: "text/markdown", contentRef: "original",
      contentSha256: "0d79b05d5f5a26ef53e9a4e3443ad6555391cc60aecfcb7b6282e7aa864eb1ed",
      modelContentRef: null, modelMimeType: null, modelContentSha256: null,
      modelContentStatus: "pending", modelContentExtractorVersion: null, modelContentCharacterCount: null,
      modelContentClaimedAt: null, modelContentClaimId: null,
    };

    const results = await Promise.all([
      materializeAttachmentDerivative(database, bucket, resource),
      materializeAttachmentDerivative(database, bucket, resource),
    ]);

    expect(results.map((result) => result.status).sort()).toEqual(["processing", "ready"]);
    expect(puts).toHaveLength(1);
    expect(puts.every((key) => key.includes(`/resource-1/${resource.contentSha256}/${ATTACHMENT_TEXT_EXTRACTOR_VERSION}/`))).toBe(true);
    expect(state).toMatchObject({ status: "ready", mime: "text/markdown", count: source.length });
    expect(statements.some((statement) => statement.sql.includes("model_content_claim_id = ?"))).toBe(true);

    const reused = await materializeAttachmentDerivative(database, bucket, {
      ...resource,
      modelContentRef: state.contentRef,
      modelMimeType: state.mime,
      modelContentSha256: state.sha,
      modelContentStatus: "ready",
      modelContentExtractorVersion: ATTACHMENT_TEXT_EXTRACTOR_VERSION,
      modelContentCharacterCount: state.count,
      modelContentClaimedAt: null,
      modelContentClaimId: null,
    });
    expect(reused.status).toBe("ready");
    expect(gets).toEqual(["original", "original"]);
  });

  it("reclaims an expired processing lease but waits for a current fenced claim", async () => {
    const source = encoder.encode("# Recovered\n\nLease recovery works.");
    const sql: string[] = [];
    const database = createTestD1Database({
      prepare(statement: string) {
        sql.push(statement);
        return {
          bind() {
            return { async run() { return { meta: { changes: 1 } }; } };
          },
        };
      },
      async batch(batch: D1PreparedStatement[]) {
        return Promise.all(batch.map((statement) => statement.run()));
      },
    });
    const gets = vi.fn(async () => ({
      async arrayBuffer() {
        return source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength);
      },
    }));
    const bucket = createCloudflareTestBinding<R2Bucket>({
      get: gets,
      async put() { return {}; },
      async delete() { return undefined; },
    });
    const common: AuthorizedDerivativeResource = {
      id: "resource-lease",
      workspaceId: "workspace-1",
      fileName: "lease.md",
      mimeType: "text/markdown",
      contentRef: "original",
      contentSha256: "97cbc8d940300fd8d5c1984f429421c55c30a6c25f1f1c32bdedce5ab03028bb",
      modelContentRef: null,
      modelMimeType: null,
      modelContentSha256: null,
      modelContentStatus: "processing",
      modelContentExtractorVersion: ATTACHMENT_TEXT_EXTRACTOR_VERSION,
      modelContentCharacterCount: null,
      modelContentClaimId: "old-claim",
      modelContentClaimedAt: "2026-08-12T10:00:00.000Z",
    };

    await expect(materializeAttachmentDerivative(database, bucket, common, {
      now: () => new Date("2026-08-12T10:04:59.000Z"),
    })).resolves.toEqual({ status: "processing", retryAfterMs: 1_000 });
    expect(gets).not.toHaveBeenCalled();

    const phases: Array<{ phase: string; outcome: string }> = [];
    const recovered = await materializeAttachmentDerivative(database, bucket, common, {
      now: () => new Date("2026-08-12T10:05:01.000Z"),
      onPhase: (event) => phases.push({ phase: event.phase, outcome: event.outcome }),
    });
    expect(recovered.status).toBe("ready");
    expect(phases).toEqual([
      { phase: "source_read", outcome: "ready" },
      { phase: "claim", outcome: "ready" },
      { phase: "convert", outcome: "ready" },
      { phase: "publish", outcome: "ready" },
    ]);
    expect(gets).toHaveBeenCalledOnce();
    expect(sql.some((statement) => statement.includes("model_content_claimed_at <= ?"))).toBe(true);
    expect(sql.some((statement) => statement.includes("AND model_content_claim_id = ?"))).toBe(true);
  });

  it("reuses a terminal result from the current extractor without reading R2 again", async () => {
    const database = createTestD1Database({
      prepare() {
        throw new Error("terminal derivatives must not touch D1");
      },
    });
    const get = vi.fn();
    const bucket = createCloudflareTestBinding<R2Bucket>({ get });
    const terminal: AuthorizedDerivativeResource = {
      id: "resource-terminal",
      workspaceId: "workspace-1",
      fileName: "archive.bin",
      mimeType: "application/octet-stream",
      contentRef: "original/archive.bin",
      contentSha256: "a".repeat(64),
      modelContentRef: null,
      modelMimeType: null,
      modelContentSha256: null,
      modelContentStatus: "unsupported",
      modelContentExtractorVersion: ATTACHMENT_TEXT_EXTRACTOR_VERSION,
      modelContentCharacterCount: null,
      modelContentClaimedAt: null,
      modelContentClaimId: null,
      modelContentErrorCode: "resource_format_unsupported",
    };

    await expect(materializeAttachmentDerivative(database, bucket, terminal)).resolves.toEqual({
      status: "unsupported",
      errorCode: "resource_format_unsupported",
    });
    expect(get).not.toHaveBeenCalled();
  });

  it("prevents an expired publisher from replacing or deleting the reclaimed generation", async () => {
    const source = encoder.encode("%PDF-1.7\nfixture");
    const state = {
      status: "pending",
      claimId: null as string | null,
      claimedAt: null as string | null,
      contentRef: null as string | null,
    };
    const outbox = new Set<string>();
    let failRelease = false;
    const database = createTestD1Database({
      prepare(sql: string) {
        return {
          bind(...values: unknown[]) {
            return {
              async run() {
                if (sql.includes("SET model_content_status = 'processing'")) {
                  const staleBefore = String(values[9]);
                  if (state.status === "processing" && state.claimedAt && state.claimedAt > staleBefore) {
                    return { meta: { changes: 0 } };
                  }
                  state.status = "processing";
                  state.claimedAt = String(values[1]);
                  state.claimId = String(values[2]);
                  return { meta: { changes: 1 } };
                }
                if (sql.includes("INSERT OR IGNORE INTO resource_object_deletion_outbox")) {
                  outbox.add(String(values[0]));
                  return { meta: { changes: 1 } };
                }
                if (failRelease && sql.includes("UPDATE resource_object_deletion_outbox")) {
                  throw new Error("release_unavailable");
                }
                if (sql.includes("SET model_content_ref = ?")) {
                  if (state.status !== "processing" || state.claimId !== values[13]) return { meta: { changes: 0 } };
                  state.status = "ready";
                  state.contentRef = String(values[0]);
                  return { meta: { changes: 1 } };
                }
                return { meta: { changes: 1 } };
              },
            };
          },
        };
      },
      async batch(batch: D1PreparedStatement[]) {
        return Promise.all(batch.map((statement) => statement.run()));
      },
    });
    const objects = new Map<string, Uint8Array>([["original", source]]);
    const deleted: string[] = [];
    const bucket = createCloudflareTestBinding<R2Bucket>({
      async get(key: string) {
        const value = objects.get(key);
        return value ? {
          size: value.byteLength,
          async arrayBuffer() { return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength); },
        } : null;
      },
      async put(key: string, value: ArrayBuffer) { objects.set(key, new Uint8Array(value)); },
      async delete(key: string) { deleted.push(key); objects.delete(key); },
    });
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let firstStarted!: () => void;
    const firstEntered = new Promise<void>((resolve) => { firstStarted = resolve; });
    const resource: AuthorizedDerivativeResource = {
      id: "race-resource",
      workspaceId: "race-workspace",
      fileName: "scan.pdf",
      mimeType: "application/pdf",
      contentRef: "original",
      contentSha256: "c".repeat(64),
      modelContentRef: null,
      modelMimeType: null,
      modelContentSha256: null,
      modelContentStatus: "pending",
      modelContentExtractorVersion: null,
      modelContentCharacterCount: null,
      modelContentClaimedAt: null,
      modelContentClaimId: null,
    };

    const publisherA = materializeAttachmentDerivative(database, bucket, resource, {
      now: () => new Date("2026-08-12T10:00:00.000Z"),
      pdfExtractor: async () => {
        firstStarted();
        await firstBlocked;
        return { pageCount: 1, pages: ["generation A"] };
      },
    });
    await firstEntered;
    const publisherB = await materializeAttachmentDerivative(database, bucket, resource, {
      now: () => new Date("2026-08-12T10:06:00.000Z"),
      pdfExtractor: async () => ({ pageCount: 1, pages: ["generation B"] }),
    });
    expect(publisherB.status).toBe("ready");
    const winningRef = state.contentRef;

    failRelease = true;
    releaseFirst();
    await expect(publisherA).resolves.toEqual({ status: "processing", retryAfterMs: 250 });
    expect(state.contentRef).toBe(winningRef);
    expect(winningRef).not.toBeNull();
    expect(objects.has(winningRef!)).toBe(true);
    // Losing the claim proves no pointer committed, so that generation is
    // released to the outbox rather than deleted in the request. Even if the
    // release RPC fails, the already-staged row is recoverable residue and
    // must not replace the settled processing result.
    expect(deleted).toEqual([]);
    const losingRefs = [...objects.keys()].filter((key) => key !== "original" && key !== winningRef);
    expect(losingRefs).toHaveLength(1);
    expect(outbox.has(losingRefs[0]!)).toBe(true);
  });
});
