import { zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { verifyAttachmentMimeType } from "../src/services/attachment-mime-verification";

const encode = (value: string) => new TextEncoder().encode(value);

describe("attachment MIME verification", () => {
  it("ignores a spoofed binary MIME when the signature does not match", () => {
    expect(verifyAttachmentMimeType(encode("not a PDF"), "attack.pdf", "application/pdf"))
      .toBe("text/plain");
    expect(verifyAttachmentMimeType(new Uint8Array([0, 255, 1]), "attack.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"))
      .toBe("application/octet-stream");
  });

  it("recognizes binary formats by server-inspected signatures", () => {
    expect(verifyAttachmentMimeType(encode("%PDF-1.7\n"), "wrong.txt", "text/plain"))
      .toBe("application/pdf");
    expect(verifyAttachmentMimeType(
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      "wrong.txt",
      "text/plain",
    )).toBe("image/png");
    expect(verifyAttachmentMimeType(
      new Uint8Array([0x49, 0x44, 0x33, 0x04, 0x00, 0x00]),
      "wrong.txt",
      "text/plain",
    )).toBe("audio/mpeg");
    expect(verifyAttachmentMimeType(
      new Uint8Array([0xff, 0xfb, 0x90, 0x64]),
      "wrong.bin",
      "application/octet-stream",
    )).toBe("audio/mpeg");
  });

  it("distinguishes OOXML subtypes from central-directory entries without expanding the archive", () => {
    const fixtures = [
      ["word/document.xml", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
      ["ppt/presentation.xml", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
      ["xl/workbook.xml", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
    ] as const;
    for (const [entry, expected] of fixtures) {
      const bytes = zipSync({ "[Content_Types].xml": encode("<Types/>") , [entry]: encode("<root/>") });
      expect(verifyAttachmentMimeType(bytes, "spoofed.bin", "application/octet-stream")).toBe(expected);
    }
  });

  it("accepts textual MIME hints only after strict UTF-8 validation", () => {
    expect(verifyAttachmentMimeType(encode("# Hello"), "README.md", "application/octet-stream"))
      .toBe("text/markdown");
    expect(verifyAttachmentMimeType(encode("{}"), "payload", "application/json"))
      .toBe("application/json");
    expect(verifyAttachmentMimeType(new Uint8Array([0xc3, 0x28]), "payload.json", "application/json"))
      .toBe("application/octet-stream");
  });
});
