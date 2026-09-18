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
  it("preserves Claude document text sources as original file content", () => {
    const result = parseSessionExport("claude", JSON.stringify({ chat_messages: [
      { sender: "human", content: [{ type: "document", title: "Meeting notes", source: {
        type: "text", media_type: "text/plain", data: "Café notes\nFollow up tomorrow.",
      } }] },
    ] }));
    expect(result.content.messages).toEqual([{ role: "user", text: "", files: [{
      name: "Meeting notes", mimeType: "text/plain", kind: "attachment",
      source: { kind: "inline", encoding: "utf8", data: "Café notes\nFollow up tomorrow." },
    }] }]);
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
  it("fetches source JSON through Firecrawl and rejects source redirects and block pages", async () => {
    const url = "https://claude.ai/share/f027df6e-0004-460c-8ec7-0666310a2ee2";
    const endpoint = "https://claude.ai/api/chat_snapshots/f027df6e-0004-460c-8ec7-0666310a2ee2?rendering_mode=messages&render_all_tools=true";
    const requests: { url: string; body: Record<string, unknown> }[] = [];
    const fetcher: typeof fetch = async (destination, init) => {
      requests.push({ url: String(destination), body: JSON.parse(String(init?.body)) });
      return Response.json({ success: true, data: { rawHtml: JSON.stringify({ chat_messages: [{ sender: "human", content: "Question", file_count: 1 }] }), metadata: { url: endpoint, statusCode: 200 } } });
    };
    const result = await previewSessionImport({ kind: "link", url }, { FIRECRAWL_API_KEY: "test-key" }, fetcher);
    expect(result.content.messages).toMatchObject([{ role: "user", text: "Question", files: [{ source: { kind: "unavailable" } }] }]);
    expect(requests).toEqual([{ url: "https://api.firecrawl.dev/v2/scrape", body: expect.objectContaining({ url: endpoint, formats: ["rawHtml"], onlyMainContent: false, removeBase64Images: false, maxAge: 0, storeInCache: false }) }]);
    for (const metadata of [{ url: "https://claude.ai/login", statusCode: 200 }, { url: endpoint, statusCode: 403 }]) {
      await expect(previewSessionImport({ kind: "link", url }, { FIRECRAWL_API_KEY: "test-key" }, async () => Response.json({ success: true, data: { rawHtml: "Blocked", metadata } })))
        .rejects.toMatchObject({ code: "session_unavailable" });
    }
  });
  it("omits internal ChatGPT content while preserving final generated image outputs", () => {
    const node = (role: string, content: unknown, extra = {}) => ({ message: { author: { role }, content, ...extra } });
    const image = { content_type: "image_asset_pointer", asset_pointer: "sediment://image-1", mime_type: "image/png" };
    const result = parseSessionExport("chatgpt", JSON.stringify({ linear_conversation: [
      node("user", { content_type: "text", parts: ["Draw a garden"] }),
      ...["model_editable_context", "thoughts", "reasoning_recap"].map((content_type) => node("assistant", { content_type })),
      node("assistant", { content_type: "code", text: "tool arguments" }, { recipient: "image_tool" }),
      node("tool", { content_type: "multimodal_text", parts: [image, "private tool diagnostics"] }, { channel: "commentary" }),
      node("tool", { content_type: "multimodal_text", parts: [image] }, { channel: "final", metadata: { image_gen_title: "Garden.png" } }),
      node("assistant", { content_type: "text", parts: ["Here is your garden"] }),
    ] }));
    expect(result.content.messages).toEqual([
      { role: "user", text: "Draw a garden" },
      { role: "assistant", text: "", files: [{ name: "Garden.png", mimeType: "image/png", kind: "artifact", source: { kind: "unavailable", reference: "sediment://image-1", reason: expect.any(String) } }] },
      { role: "assistant", text: "Here is your garden" },
    ]);
  });
  it("refuses truncated Claude messages and unknown visible ChatGPT blocks", () => {
    expect(() => parseSessionExport("claude", JSON.stringify({ chat_messages: [{ sender: "human", content: "partial", truncated: true }] }))).toThrow("truncated");
    expect(() => parseSessionExport("chatgpt", JSON.stringify({ linear_conversation: [{ message: { author: { role: "assistant" }, content: { content_type: "unknown" } } }] }))).toThrow("content.content_type");
  });
  it("identifies invalid canonical fields without echoing source values", () => {
    expect(() => parseSessionExport("claude", JSON.stringify({ chat_messages: [] })))
      .toThrow("content.messages:too_small");
  });
  it("reports missing configuration and provider failures without disclosing provider details", async () => {
    const input = { kind: "link" as const, url: "https://claude.ai/share/f027df6e-0004-460c-8ec7-0666310a2ee2" };
    await expect(previewSessionImport(input, {})).rejects.toMatchObject({ code: "session_import_unavailable" });
    await expect(previewSessionImport(input, { FIRECRAWL_API_KEY: "test-key" }, async () => Response.json({ error: "private provider detail" }, { status: 400 })))
      .rejects.toMatchObject({ code: "session_unavailable" });
  });
  it("rejects empty or non-conversation content", () => {
    expect(() => parseSessionExport("claude", "{}")).toThrow("Expected Claude");
    expect(() => parseSessionExport("chatgpt", '<html>Log in</html>')).toThrow("Share page has no conversation data");
  });
});
