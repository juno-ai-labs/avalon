import { strToU8, zipSync } from "fflate";
import { describe, expect, it, vi } from "vitest";
import {
  ATTACHMENT_TEXT_EXTRACTOR_VERSION,
  buildAttachmentDerivative,
  buildDerivativeIndex,
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

  it("fails explicitly for invalid UTF-8 and corrupt Office data and reports unsupported binary content", async () => {
    const [invalidText, corruptOffice, unsupported] = await Promise.all([
      buildAttachmentDerivative({ bytes: new Uint8Array([0xc3, 0x28]), fileName: "bad.md", mimeType: "text/markdown" }),
      buildAttachmentDerivative({ bytes: encoder.encode("not a zip"), fileName: "bad.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }),
      buildAttachmentDerivative({ bytes: new Uint8Array([0, 1, 2]), fileName: "clip.mp4", mimeType: "video/mp4" }),
    ]);

    expect(invalidText).toMatchObject({ status: "failed", errorCode: "invalid_utf8" });
    expect(corruptOffice).toMatchObject({ status: "failed", errorCode: "invalid_office_archive" });
    expect(unsupported).toMatchObject({ status: "unsupported", errorCode: "resource_format_unsupported" });
  });

  it("creates a bounded deterministic index against exact UTF-16 offsets", () => {
    const text = "# Alpha\n\n😀 one two three\n\n## Beta\n\nfour five six";
    const first = buildDerivativeIndex(text, 18);
    const second = buildDerivativeIndex(text, 18);

    expect(first).toEqual(second);
    expect(first.chunks.length).toBeGreaterThan(1);
    for (const chunk of first.chunks) {
      expect(text.slice(chunk.start, chunk.end).length).toBeLessThanOrEqual(18);
      expect(chunk).not.toHaveProperty("text");
      expect(chunk.terms.length).toBeLessThanOrEqual(64);
    }
    expect(first.chunks.some((chunk) => chunk.sectionLabel === "Alpha")).toBe(true);
    expect(first.chunks.some((chunk) => chunk.sectionLabel === "Beta")).toBe(true);
  });

  it("allows one concurrent materialization claim and reuses the atomically selected version", async () => {
    const source = encoder.encode("# Current\n\nThe complete reusable derivative.");
    const state = { status: "pending", contentRef: null as string | null, indexRef: null as string | null, mime: null as string | null, sha: null as string | null, count: null as number | null };
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
                  state.indexRef = String(values[4]);
                  state.count = Number(values[6]);
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
      id: "resource-1", fileName: "brief.md", mimeType: "text/markdown", contentRef: "original",
      contentSha256: "0d79b05d5f5a26ef53e9a4e3443ad6555391cc60aecfcb7b6282e7aa864eb1ed",
      modelContentRef: null, modelMimeType: null, modelContentSha256: null, modelIndexRef: null,
      modelContentStatus: "pending", modelContentExtractorVersion: null, modelContentCharacterCount: null,
    };

    const results = await Promise.all([
      materializeAttachmentDerivative(database, bucket, resource),
      materializeAttachmentDerivative(database, bucket, resource),
    ]);

    expect(results.map((result) => result.status).sort()).toEqual(["processing", "ready"]);
    expect(puts).toHaveLength(2);
    expect(puts.every((key) => key.includes(`/resource-1/${resource.contentSha256}/${ATTACHMENT_TEXT_EXTRACTOR_VERSION}/`))).toBe(true);
    expect(state).toMatchObject({ status: "ready", mime: "text/markdown", count: source.length });
    expect(statements.some((statement) => statement.sql.includes("resource_model_objects"))).toBe(true);

    const reused = await materializeAttachmentDerivative(database, bucket, {
      ...resource,
      modelContentRef: state.contentRef,
      modelIndexRef: state.indexRef,
      modelMimeType: state.mime,
      modelContentSha256: state.sha,
      modelContentStatus: "ready",
      modelContentExtractorVersion: ATTACHMENT_TEXT_EXTRACTOR_VERSION,
      modelContentCharacterCount: state.count,
    });
    expect(reused.status).toBe("ready");
    expect(gets).toEqual(["original", "original"]);
  });
});
