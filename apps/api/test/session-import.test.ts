import { describe, it, expect } from "vitest";
import { parseSessionExport, previewSessionImport, sessionShareUrl } from "../src/services/session-import";

describe("shared session import", () => {
  it("follows the selected ChatGPT branch and drops hidden, thinking and tool turns", () => {
    const message = (role: string, value: string, extra = {}) => ({ author: { role }, content: { content_type: "text", parts: [value] }, ...extra });
    const content = parseSessionExport("chatgpt", JSON.stringify({ title: "Branch", current_node: "b", mapping: {
      a: { parent: null, message: message("user", "Question") },
      discarded: { parent: "a", message: message("assistant", "Old answer") },
      thinking: { parent: "a", message: message("assistant", "Private", { channel: "analysis" }) },
      tool: { parent: "thinking", message: message("tool", "Tool result") },
      b: { parent: "tool", message: message("assistant", "Selected answer") },
    } }));
    expect(content.content.messages).toEqual([{ role: "user", text: "Question" }, { role: "assistant", text: "Selected answer" }]);
  });
  it("decodes the observed ChatGPT loader reference format without executing script", () => {
    const table = [
      { _1: 2, _3: 4 }, "title", "Demo", "linear_conversation", [5, 6],
      { _7: 8 }, { _7: 16 }, "message", { _9: 10, _12: 13 }, "author",
      { _11: 14 }, "role", "content", { _15: 17, _18: 19 }, "user", "content_type",
      { _9: 20, _12: 21 }, "text", "parts", [22], { _11: 23 }, { _15: 17, _18: 24 },
      "Question", "assistant", [25], "Answer",
    ];
    const html = `<script>window.streamController.enqueue(${JSON.stringify(JSON.stringify(table))})</script>`;
    expect(parseSessionExport("chatgpt", html).content.messages).toEqual([
      { role: "user", text: "Question" }, { role: "assistant", text: "Answer" },
    ]);
  });

  it("reads public Claude text and preserves unavailable file references", () => {
    const result = parseSessionExport("claude", JSON.stringify({ snapshot_name: "Comments", chat_messages: [
      { sender: "human", text: "", content: [{ type: "text", text: "Why two comments?" }], files: [{ name: "hidden.png" }] },
      { sender: "assistant", text: "", content: [{ type: "thinking", thinking: "private" }, { type: "tool_use", name: "read" }, { type: "text", text: "Check the header." }], compaction_summary: "omit" },
    ] }));
    expect(result.content.messages).toMatchObject([{ role: "user", text: "Why two comments?", files: [{ name: "hidden.png", source: { kind: "unavailable" } }] }, { role: "assistant", text: "Check the header." }]);
  });
  it("reads Code JSONL messages but omits tool results and compaction", () => {
    const result = parseSessionExport("claude", [
      { type: "user", message: { role: "user", content: "Fix this" } },
      { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", name: "Read" }] } },
      { type: "user", message: { role: "user", content: [{ type: "tool_result", content: "source" }] } },
      { type: "user", isCompactSummary: true, message: { role: "user", content: "compacted" } },
      { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Fixed" }] } },
    ].map((value) => JSON.stringify(value)).join("\n"));
    expect(result.content.messages).toEqual([{ role: "user", text: "Fix this" }, { role: "assistant", text: "Fixed" }]);
  });
  it("retains attachment-only messages, embedded image bytes and artifact documents", () => {
    const result = parseSessionExport("claude", JSON.stringify({ chat_messages: [
      { sender: "human", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" } }] },
      { sender: "assistant", content: [{ type: "text", text: '<antArtifact title="Chart.html" type="text/html"><h1>Chart</h1></antArtifact>' }] },
    ] }));
    expect(result.content.messages).toMatchObject([
      { role: "user", text: "", files: [{ source: { kind: "inline", encoding: "base64", data: "aGVsbG8=" } }] },
      { role: "assistant", files: [{ name: "Chart.html", kind: "artifact", source: { kind: "inline", data: "<h1>Chart</h1>" } }] },
    ]);
  });
  it("reads a one-record Code JSONL export and refuses unsupported visible text shapes", () => {
    expect(parseSessionExport("claude", JSON.stringify({ type: "user", message: { role: "user", content: "Only turn" } })).content.messages)
      .toEqual([{ role: "user", text: "Only turn" }]);
    expect(() => parseSessionExport("claude", JSON.stringify({ chat_messages: [
      { sender: "human", content: "Question" }, { sender: "assistant", content: [{ type: "unknown secret payload" }] },
    ] }))).toThrow("Unsupported Claude content block type");
  });
  it("labels extracted text separately from the unavailable original document", () => {
    const result = parseSessionExport("claude", JSON.stringify({ chat_messages: [
      { sender: "human", content: "", attachments: [{ file_name: "notes.pdf", file_type: "application/pdf", extracted_content: "Notes" }] },
    ] }));
    expect(result.content.messages[0]?.files).toMatchObject([
      { name: "notes.pdf", source: { kind: "unavailable" } },
      { name: "notes.pdf (extracted text).txt", mimeType: "text/plain", source: { kind: "inline", data: "Notes" } },
    ]);
  });
  it("preserves complete and partial Claude artifact events without importing tool calls", () => {
    const result = parseSessionExport("claude", JSON.stringify({ type: "assistant", message: { role: "assistant", content: [
      { type: "tool_use", name: "Write", input: { file_path: "/tmp/report.html", content: "<h1>Report</h1>" } },
      { type: "tool_use", name: "artifacts", input: { id: "diagram", command: "update" } },
    ] } }));
    expect(result.content.messages).toMatchObject([{ role: "assistant", text: "", files: [
      { name: "report.html", source: { kind: "inline", data: "<h1>Report</h1>" } },
      { name: "diagram", source: { kind: "unavailable", reference: "diagram" } },
    ] }]);
  });
  it("rejects arbitrary destinations and identifies Code login requirements", () => {
    for (const url of ["https://example.com/share/123", "https://claude.ai.evil.test/share/123", "http://claude.ai/share/123", "https://user:password@claude.ai/share/123"]) expect(() => sessionShareUrl(url)).toThrow();
    expect(() => sessionShareUrl("https://claude.ai/code/session_01As61kVEUr9wNkGSohfNaZb")).toThrow("signed-in");
  });
  it("does not follow a provider redirect", async () => {
    const calls: RequestInit[] = [];
    const fetcher: typeof fetch = async (_url, init) => {
      calls.push(init ?? {});
      return new Response("", { status: 302, headers: { location: "http://localhost/" } });
    };
    await expect(previewSessionImport({ kind: "link", url: "https://claude.ai/share/f027df6e-0004-460c-8ec7-0666310a2ee2" }, fetcher)).rejects.toThrow("could not return");
    expect(calls).toEqual([{ redirect: "manual" }]);
  });
  it("rejects empty or non-conversation content", () => {
    expect(() => parseSessionExport("claude", "{}")).toThrow("Expected Claude");
    expect(() => parseSessionExport("chatgpt", '<html>Log in</html>')).toThrow("Share page has no conversation data");
  });
});
