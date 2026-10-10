import { asUserId } from "@rally/contracts";
import { authorizedConnection, createGoogleConnector } from "@rally/connectors";
import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { officeDocumentTextReader } from "../src/lib/office-document-text";

// The Office converter is the real one the registry hands the Google adapter;
// only Google's HTTP API is faked, because it cannot run here.

const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const PPTX = "application/vnd.openxmlformats-officedocument.presentationml.presentation";

describe("Office files stored in Google Drive", () => {
  it("returns every sheet of an Excel workbook from drive.download", async () => {
    const drive = fakeDrive({ name: "Cap Table.xlsx", mimeType: XLSX, bytes: capTable() });

    const result = await download(drive.fetch);

    expect(result.output).toMatchObject({ contentIncluded: true, contentTruncated: false });
    expect(result.output.textContent).toBe([
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

  it("reads a Word memo and a PowerPoint deck from drive.download", async () => {
    const memo = zipSync({
      "word/document.xml": strToU8('<w:document><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Investment Memo</w:t></w:r></w:p><w:p><w:r><w:t>We own 12.5%.</w:t></w:r></w:p></w:body></w:document>'),
    });
    const deck = zipSync({
      "ppt/slides/slide1.xml": strToU8("<p:sld><a:p><a:r><a:t>Q3 board update</a:t></a:r></a:p></p:sld>"),
      "ppt/notesSlides/notesSlide1.xml": strToU8("<p:notes><a:p><a:r><a:t>Lead with runway</a:t></a:r></a:p></p:notes>"),
    });

    const [word, powerpoint] = await Promise.all([
      download(fakeDrive({ name: "Investment Memo.docx", mimeType: DOCX, bytes: memo }).fetch),
      download(fakeDrive({ name: "Board.pptx", mimeType: PPTX, bytes: deck }).fetch),
    ]);

    expect(word.output.textContent).toBe("# Investment Memo\n\nWe own 12.5%.");
    expect(powerpoint.output.textContent).toBe("# Slide 1\n\nQ3 board update\n\n## Speaker notes\n\nLead with runway");
  });

  it("names why a file that is not really an Office archive could not be read", async () => {
    const drive = fakeDrive({ name: "Broken.xlsx", mimeType: XLSX, bytes: strToU8("not a zip") });

    const result = await download(drive.fetch);

    expect(result.output).toMatchObject({
      textContent: null,
      contentIncluded: false,
      contentOmittedReason: "The file could not be read as a document: invalid_office_archive",
    });
  });

  it("cuts a long workbook's text to the tool budget and says so", async () => {
    const rows = Array.from({ length: 12_000 }, (_, index) =>
      `<row r="${index + 1}"><c r="A${index + 1}"><v>${1_000_000 + index}</v></c></row>`).join("");
    const drive = fakeDrive({
      name: "Ledger.xlsx",
      mimeType: XLSX,
      bytes: workbook({ Ledger: `<worksheet><sheetData>${rows}</sheetData></worksheet>` }),
    });

    const result = await download(drive.fetch);

    expect(result.output.contentTruncated).toBe(true);
    expect(new TextEncoder().encode(result.output.textContent ?? "").byteLength).toBeLessThanOrEqual(128_000);
    expect(result.output.textContent?.startsWith("# Sheet: Ledger\n\nA1: 1000000\nA2: 1000001")).toBe(true);
  });

  it("does not download a file larger than the converter accepts", async () => {
    const drive = fakeDrive({ name: "Huge.pptx", mimeType: PPTX, bytes: new Uint8Array(), size: 9 * 1_024 * 1_024 });

    const result = await download(drive.fetch);

    expect(result.output).toMatchObject({
      textContent: null,
      contentOmittedReason: "File exceeds the 8388608-byte document conversion limit",
    });
    expect(drive.mediaRequests).toBe(0);
  });
});

async function download(fetcher: typeof fetch) {
  const adapter = createGoogleConnector({
    clientId: "google-client",
    clientSecret: "google-secret",
    redirectUri: "https://rally.example/connections/google/callback",
    fetch: fetcher,
    storedDocumentText: officeDocumentTextReader,
  });
  const result = await adapter.executeTool!("drive.download", { fileId: "file-1" }, {
    connection: authorizedConnection({
      id: "00000000-0000-7000-8000-000000000003",
      workspaceId: "00000000-0000-7000-8000-000000000002",
      scope: "personal",
      ownerUserId: asUserId("00000000-0000-7000-8000-000000000001"),
      grantedScopes: ["drive.read"],
      credentials: { accessToken: "google-access-token" },
      cursor: {},
      config: { region: "global", pollIntervalSeconds: 300 },
    }),
    principal: { type: "user", userId: asUserId("00000000-0000-7000-8000-000000000001") },
    signal: new AbortController().signal,
  });
  return result as { output: Record<string, unknown> & { textContent?: string | null } };
}

/** Drive answering one file's metadata and its stored bytes. */
function fakeDrive(file: { name: string; mimeType: string; bytes: Uint8Array; size?: number }) {
  const drive = {
    mediaRequests: 0,
    fetch: (async (input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.searchParams.get("alt") === "media") {
        drive.mediaRequests += 1;
        return new Response(new Blob([new Uint8Array(file.bytes)]));
      }
      return Response.json({
        id: "file-1",
        name: file.name,
        mimeType: file.mimeType,
        size: String(file.size ?? file.bytes.byteLength),
      });
    }) as typeof fetch,
  };
  return drive;
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
