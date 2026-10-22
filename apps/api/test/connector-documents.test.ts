import { asUserId, asWorkspaceId } from "@rally/contracts";
import {
  authorizedConnection,
  createConnectorRegistry,
  SlackWorkspaceCapabilities,
  type ConnectorAdapter,
  type ConnectorTextPages,
  type ConnectorToolContext,
} from "@rally/connectors";
import { strToU8, zipSync } from "fflate";
import { describe, expect, it, vi } from "vitest";
import { connectorDocumentReader } from "../src/services/connector-document-reader";
import { ATTACHMENT_MAX_SOURCE_BYTES } from "../src/services/attachment-derivative-service";
import {
  buildGifStoryboard,
  decodeTiffToPng,
  extractPdfText,
} from "../src/services/document-processing-codecs";
import type { DocumentProcessingRpcBinding } from "../src/services/document-processing-contract";
import { createCloudflareTestBinding, createTestEnv } from "./helpers/cloudflare-test";

// The reader is the real one the registry hands adapters, over the real
// attachment converter and PDF extractor; only the providers' HTTP APIs are
// faked, because they cannot run here. Adapters are built through
// `createConnectorRegistry`, so the tests also prove the registry passes the
// reader to each of them.

const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const PPTX = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
const USER_ID = asUserId("00000000-0000-7000-8000-000000000001");

describe("files read through Google Drive", () => {
  it("returns every sheet of an Excel workbook", async () => {
    const result = await driveDownload({ name: "Cap Table.xlsx", mimeType: XLSX, bytes: capTable() });

    expect(result).toMatchObject({ contentIncluded: true, contentTruncated: false });
    expect(result.textContent).toBe([
      "# Sheet: Summary",
      "",
      "A1: Holder",
      "B1: Ownership",
      "A2: Rally Ventures",
      "B2: 0.125 (formula: B5/B6)",
      "",
      "# Sheet: Rounds",
      "",
      "A1: Seed",
      "B1: 2500000",
    ].join("\n"));
  });

  it("reads a Word memo, a PowerPoint deck, and a PDF's text layer", async () => {
    const [word, powerpoint, pdf] = await Promise.all([
      driveDownload({ name: "Investment Memo.docx", mimeType: DOCX, bytes: memo() }),
      driveDownload({ name: "Board.pptx", mimeType: PPTX, bytes: deck() }),
      driveDownload({ name: "Term Sheet.pdf", mimeType: "application/pdf", bytes: textPdf("Liquidation preference 1x") }),
    ]);

    expect(word.textContent).toBe("# Investment Memo\n\nWe own 12.5%.");
    expect(powerpoint.textContent).toBe("# Slide 1\n\nQ3 board update\n\n## Speaker notes\n\nLead with runway");
    expect(pdf.textContent).toBe("# Page 1\n\nLiquidation preference 1x");
  });

  it("reads a scanned PDF through OCR, billed to the workspace of the connection it came through", async () => {
    const conversions: string[] = [];
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await driveDownload(
      { name: "Signed Term Sheet.pdf", mimeType: "application/pdf", bytes: textPdf(" ") },
      undefined,
      workersAi(conversions, "Signed by both parties"),
    );

    expect(conversions).toEqual(["Signed Term Sheet.pdf"]);
    expect(result.textContent).toBe("# Page 1\n\nSigned by both parties");
    const usage = warned.mock.calls.map(([entry]) => entry as { event?: string; event_id?: string; workspace_id?: string; activity?: string })
      .filter((entry) => entry.event === "usage_unpriced");
    warned.mockRestore();
    expect(usage).toEqual([expect.objectContaining({
      activity: "document_ocr",
      workspace_id: "00000000-0000-7000-8000-000000000002",
      event_id: expect.stringMatching(/^ocr:connection:00000000-0000-7000-8000-000000000003:/u),
    })]);
  });

  it("names why a file that is not really an Office archive could not be read", async () => {
    const result = await driveDownload({ name: "Broken.xlsx", mimeType: XLSX, bytes: strToU8("not a zip") });

    expect(result).toMatchObject({
      textContent: null,
      contentIncluded: false,
      contentOmittedReason: "invalid_office_archive",
    });
  });

  it("pages a long workbook through its final row within the tool budget", async () => {
    const rows = Array.from({ length: 12_000 }, (_, index) =>
      `<row r="${index + 1}"><c r="A${index + 1}"><v>${1_000_000 + index}</v></c></row>`).join("");
    const result = await driveDownload({
      name: "Ledger.xlsx",
      mimeType: XLSX,
      bytes: workbook({ Ledger: `<worksheet><sheetData>${rows}</sheetData></worksheet>` }),
    });

    expect(result.contentTruncated).toBe(true);
    expect(new TextEncoder().encode(result.textContent ?? "").byteLength).toBeLessThanOrEqual(128_000);
    expect(result.textContent?.startsWith("# Sheet: Ledger\n\nA1: 1000000\nA2: 1000001")).toBe(true);
    expect(result.pages.at(-1)).toMatchObject({ hasMore: false, sourceTruncated: false, contentTruncated: false });
    expect(result.pages.map(page => page.textContent).join("").endsWith("A12000: 1011999")).toBe(true);
    expect(result.pages.every(page => new TextEncoder().encode(page.textContent ?? "").byteLength <= 128_000)).toBe(true);
  });

  it("pages a workbook beyond the stored-derivative ceiling without losing later rows", async () => {
    // Small on disk, huge as text: one long shared string referenced by every
    // cell expands to about 2.5 million characters.
    const rows = Array.from({ length: 12_000 }, (_, index) =>
      `<row r="${index + 1}"><c r="A${index + 1}" t="s"><v>0</v></c></row>`).join("");
    const result = await driveDownload({
      name: "Export.xlsx",
      mimeType: XLSX,
      bytes: workbook({ Export: `<worksheet><sheetData>${rows}</sheetData></worksheet>` }, `<sst><si><t>${"x".repeat(200)}</t></si></sst>`),
    });

    expect(result.contentTruncated).toBe(true);
    expect(result.textContent?.startsWith(`# Sheet: Export\n\nA1: ${"x".repeat(200)}\nA2: `)).toBe(true);
    expect(result.pages.at(-1)).toMatchObject({ hasMore: false, sourceTruncated: false, contentTruncated: false });
    expect(result.pages.map(page => page.textContent).join("").endsWith(`A12000: ${"x".repeat(200)}`)).toBe(true);
  });

  it("does not download a file larger than the converter accepts", async () => {
    let mediaRequests = 0;
    const result = await driveDownload(
      { name: "Huge.pptx", mimeType: PPTX, bytes: new Uint8Array(), size: 9 * 1_024 * 1_024 },
      () => { mediaRequests += 1; },
    );

    expect(result).toMatchObject({
      textContent: null,
      contentOmittedReason: "source_too_large",
    });
    expect(mediaRequests).toBe(0);
  });
});

describe("files shared in Slack", () => {
  it("reads an Excel file shared in a thread through the same reader", async () => {
    const output = await slackReadFile({ name: "Cap Table.xlsx", mimetype: XLSX, filetype: "xlsx", bytes: capTable() });

    expect(output.content).toBe([
      "# Sheet: Summary",
      "",
      "A1: Holder",
      "B1: Ownership",
      "A2: Rally Ventures",
      "B2: 0.125 (formula: B5/B6)",
      "",
      "# Sheet: Rounds",
      "",
      "A1: Seed",
      "B1: 2500000",
    ].join("\n"));
  });

  it("still reports a file no converter reads, such as an image, as binary", async () => {
    const output = await slackReadFile({ name: "logo.png", mimetype: "image/png", filetype: "png", bytes: new Uint8Array([0x89, 0x50]) });

    expect(output).toMatchObject({ content: null, content_omitted_reason: "binary_file" });
  });
});

function registry(fetcher: typeof fetch, ai: Ai = workersAi([])) {
  return createConnectorRegistry({
    documents: connectorDocumentReader(createTestEnv({
      DOCUMENT_PROCESSOR: documentProcessor,
      AI: ai,
    })),
    google: {
      clientId: "google-client",
      clientSecret: "google-secret",
      redirectUri: "https://rally.example/connections/google/callback",
      fetch: fetcher,
    },
    slack: {
      clientId: "slack-client",
      clientSecret: "slack-secret",
      signingSecret: "slack-signing",
      redirectUri: "https://rally.example/connections/slack/callback",
      fetch: fetcher,
    },
  });
}

/** The real PDF extractor, as the document-processing Worker exposes it. */
const documentProcessor = {
  extractText: extractPdfText,
  buildGifStoryboard: async (bytes: Uint8Array) => buildGifStoryboard(bytes),
  decodeTiffToPng: async (bytes: Uint8Array) => decodeTiffToPng(bytes),
} satisfies DocumentProcessingRpcBinding;

/** Workers AI's document conversion, which cannot run here: records each file it is asked to convert. */
function workersAi(conversions: string[], text = ""): Ai {
  return createCloudflareTestBinding<Ai>({
    toMarkdown: async (file: { name: string }) => {
      conversions.push(file.name);
      return { name: file.name, mimeType: "application/pdf", format: "markdown", tokens: 0, data: text };
    },
  });
}

/** `drive.download` of one file, with Drive answering its metadata and stored bytes. */
async function driveDownload(
  file: { name: string; mimeType: string; bytes: Uint8Array; size?: number },
  onMedia: () => void = () => undefined,
  ai?: Ai,
) {
  const fetcher = (async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.searchParams.get("alt") === "media") {
      onMedia();
      return new Response(new Blob([new Uint8Array(file.bytes)]));
    }
    return Response.json({ id: "file-1", name: file.name, mimeType: file.mimeType, size: String(file.size ?? file.bytes.byteLength) });
  }) as typeof fetch;
  const adapter: ConnectorAdapter = registry(fetcher, ai).get("google");
  // This Node suite exercises the real Office/PDF converter, which cannot use
  // workerd's R2 binding here. The host store's persistence and isolation are
  // exercised against real R2 in test-workers/connector-text-pages.test.ts.
  const snapshots = new Map<string, Uint8Array>();
  const textPages: ConnectorTextPages = {
    maxSourceBytes: ATTACHMENT_MAX_SOURCE_BYTES,
    async write(bytes) { const id = crypto.randomUUID(); snapshots.set(id, bytes.slice()); return id; },
    async read(id, offset, length) {
      const bytes = snapshots.get(id);
      if (!bytes) throw new Error("snapshot_unavailable");
      return { bytes: bytes.slice(offset, offset + length), totalBytes: bytes.byteLength };
    },
  };
  const context: ConnectorToolContext = {
    connection: authorizedConnection({
      id: "00000000-0000-7000-8000-000000000003",
      workspaceId: "00000000-0000-7000-8000-000000000002",
      scope: "personal",
      ownerUserId: USER_ID,
      grantedScopes: ["drive.read"],
      credentials: { accessToken: "google-access-token" },
      cursor: {},
      config: { region: "global", pollIntervalSeconds: 300 },
    }),
    principal: { type: "user", userId: USER_ID },
    signal: new AbortController().signal,
    textPages,
  };
  let result = await adapter.executeTool!("drive.download", { fileId: "file-1" }, context);
  type Page = Record<string, unknown> & { textContent: string | null; contentTruncated?: boolean };
  const pages = [result.output as Page];
  while (result.pagination?.continuations.length) {
    result = await adapter.executeTool!("drive.download", result.pagination.continuations[0]!.input, context);
    pages.push(result.output as Page);
  }
  return { ...pages[0]!, pages };
}

/** Slack `read_file` of one shared file, with Slack answering files.info and the private download. */
async function slackReadFile(file: { name: string; mimetype: string; filetype: string; bytes: Uint8Array }) {
  const fetcher = (async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.hostname === "files.slack.com") return new Response(new Blob([new Uint8Array(file.bytes)]));
    return Response.json({
      ok: true,
      file: {
        id: "FCAP",
        name: file.name,
        mimetype: file.mimetype,
        filetype: file.filetype,
        size: file.bytes.byteLength,
        url_private_download: `https://files.slack.com/files-pri/TACME-FCAP/${encodeURIComponent(file.name)}`,
      },
    });
  }) as typeof fetch;
  const workspaceId = asWorkspaceId("8f7c6014-d46d-4285-8eb2-cac59f1b301c");
  const result = await registry(fetcher).get("slack").executeTool!("read_file", { file_id: "FCAP" }, {
    connection: authorizedConnection({
      id: "connection-slack",
      workspaceId,
      scope: "workspace",
      ownerUserId: null,
      grantedScopes: [...SlackWorkspaceCapabilities],
      credentials: { botAccessToken: "xoxb-test" },
      cursor: {},
      config: {},
    }),
    principal: { type: "workspace", workspaceId },
    signal: new AbortController().signal,
  });
  return result.output as Record<string, unknown>;
}

function workbook(sheets: Record<string, string>, sharedStrings?: string): Uint8Array {
  const names = Object.keys(sheets);
  return zipSync({
    "xl/workbook.xml": strToU8(`<workbook xmlns:r="r"><sheets>${names.map((name, index) =>
      `<sheet name="${name}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join("")}</sheets></workbook>`),
    "xl/_rels/workbook.xml.rels": strToU8(`<Relationships>${names.map((_, index) =>
      `<Relationship Id="rId${index + 1}" Target="worksheets/sheet${index + 1}.xml"/>`).join("")}</Relationships>`),
    ...(sharedStrings ? { "xl/sharedStrings.xml": strToU8(sharedStrings) } : {}),
    ...Object.fromEntries(names.map((name, index) => [`xl/worksheets/sheet${index + 1}.xml`, strToU8(sheets[name]!)])),
  });
}

function capTable(): Uint8Array {
  return workbook({
    Summary: '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>'
      + '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><f>B5/B6</f><v>0.125</v></c></row></sheetData></worksheet>',
    Rounds: '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>3</v></c><c r="B1"><v>2500000</v></c></row></sheetData></worksheet>',
  }, "<sst><si><t>Holder</t></si><si><t>Ownership</t></si><si><t>Rally Ventures</t></si><si><t>Seed</t></si></sst>");
}

function memo(): Uint8Array {
  return zipSync({
    "word/document.xml": strToU8('<w:document><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Investment Memo</w:t></w:r></w:p><w:p><w:r><w:t>We own 12.5%.</w:t></w:r></w:p></w:body></w:document>'),
  });
}

function deck(): Uint8Array {
  return zipSync({
    "ppt/slides/slide1.xml": strToU8("<p:sld><a:p><a:r><a:t>Q3 board update</a:t></a:r></a:p></p:sld>"),
    "ppt/notesSlides/notesSlide1.xml": strToU8("<p:notes><a:p><a:r><a:t>Lead with runway</a:t></a:r></a:p></p:notes>"),
  });
}

/** A one-page PDF whose text layer holds `text`. */
function textPdf(text: string): Uint8Array {
  const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let body = "%PDF-1.4\n";
  const offsets = objects.map((object, index) => {
    const offset = body.length;
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return strToU8(body);
}
