import { describe, expect, it } from "vitest";
import { serializeRichEmail } from "./google-mail-mime";

describe("rich Gmail MIME", () => {
  it("encodes Unicode text and HTML separately with correct MIME line endings", () => {
    const mime = serializeRichEmail(["To: recipient@example.com", "MIME-Version: 1.0"], { body: "Hello café", htmlBody: "<b>Hello café</b>" });
    expect(mime).toContain("Content-Type: multipart/alternative;");
    expect(mime).toContain("Content-Type: text/plain; charset=\"UTF-8\"\r\nContent-Transfer-Encoding: base64\r\n\r\nSGVsbG8gY2Fmw6k=");
    expect(mime).toContain("Content-Type: text/html; charset=\"UTF-8\"\r\nContent-Transfer-Encoding: base64\r\n\r\nPGI+SGVsbG8gY2Fmw6k8L2I+");
    expect(mime.replaceAll("\r\n", "")).not.toContain("\n");
  });
});
