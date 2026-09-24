import { describe, it, expect } from "vitest";
import { parseSessionExport, previewSessionImport, sessionShareUrl, sessionSourceUrlProvider } from "../src/services/session-import";

describe("shared session import", () => {
  it('keeps the private ChatGPT conversation URL with an authenticated export preview', async () => {
    const url = 'https://example.com/research-note';
    const result = await previewSessionImport({ kind: 'export', provider: 'chatgpt', sourceUrl: url,
      text: JSON.stringify({ conversation_id: url.split('/').at(-1), title: 'Selected chat', current_node: 'm1', mapping: {
        m1: { id: 'm1', parent: null, message: { id: 'm1', author: { role: 'user' }, content: { content_type: 'text', parts: ['Hello'] } } },
      } }),
    });
    expect(result.source).toMatchObject({ provider: 'chatgpt', sessionId: url.split('/').at(-1), url });
    expect(result.content.messages).toHaveLength(1);
    expect(sessionSourceUrlProvider(url, result.source.sessionId!)).toBe('chatgpt');
    expect(() => sessionSourceUrlProvider(url, 'another-conversation')).toThrow('The sourceUrl names a different conversation than the decoded text');
  });
  it('keeps the private Claude conversation URL with an authenticated export preview', async () => {
    const id = '4f2b7c1e-9a3d-4e8b-b1c2-0d9e8f7a6b5c';
    const url = `https://claude.ai/chat/${id}`;
    const result = await previewSessionImport({ kind: 'export', provider: 'claude', sourceUrl: url,
      text: JSON.stringify({ uuid: id, name: 'Selected Claude chat', chat_messages: [
        { uuid: 'h1', sender: 'human', content: [{ type: 'text', text: 'Hello' }] },
        { uuid: 'a1', sender: 'assistant', content: [{ type: 'text', text: 'Hi' }] },
      ] }),
    });
    expect(result.source).toMatchObject({ provider: 'claude', sessionId: id, url });
    expect(result.content.messages).toHaveLength(2);
    expect(() => sessionSourceUrlProvider(url, 'another-conversation')).toThrow('The sourceUrl names a different conversation than the decoded text');
    expect(() => sessionSourceUrlProvider(`https://chatgpt.com/chat/${id}`, id)).toThrow('Use a ChatGPT or Claude public share link');
  });
  it('writes ChatGPT inline links as links and keeps one copy of a fetched uploaded image', () => {
    const link = '\uE200url\uE202Pricing\uE202turn0search0\uE201';
    const cite = '\uE200cite\uE202turn0search1\uE201';
    const result = parseSessionExport('chatgpt', JSON.stringify({ current_node: 'a', mapping: {
      u: { parent: null, message: { id: 'u', author: { role: 'user' },
        metadata: { attachments: [{ id: 'file_1', name: 'shot.png', mime_type: 'image/png', inline_base64: 'iVBORw0K' }] },
        content: { content_type: 'multimodal_text', parts: [{ content_type: 'image_asset_pointer', asset_pointer: 'sediment://file_1' }, 'Look'] } } },
      a: { parent: 'u', message: { id: 'a', author: { role: 'assistant' },
        metadata: { content_references: [{ matched_text: link, type: 'url', alt: '[Pricing](https://x.ai/pricing)' }, { matched_text: cite, type: 'grouped_webpages', alt: '' }] },
        content: { content_type: 'text', parts: [`See ${link}. Done ${cite}\uE200unknown\uE201`] } } },
    } }));
    expect(result.content.messages).toEqual([
      { role: 'user', text: 'Look', sourceMessageId: 'u', files: [{ name: 'shot.png', mimeType: 'image/png', kind: 'attachment', source: { kind: 'inline', encoding: 'base64', data: 'iVBORw0K' } }] },
      { role: 'assistant', text: 'See [Pricing](https://x.ai/pricing). Done', sourceMessageId: 'a' },
    ]);
  });
  it('copies a ChatGPT sandbox file the reply links, and reports one it could not copy', () => {
    const result = parseSessionExport('chatgpt', JSON.stringify({ current_node: 'a', mapping: {
      a: { parent: null, message: { id: 'a', author: { role: 'assistant' }, content: { content_type: 'text',
        parts: ['Done.\n\n[Download the HTML](sandbox:/mnt/data/page.html) or [the CSV](sandbox:/mnt/data/rows.csv). Again: [HTML](sandbox:/mnt/data/page.html)'] },
        metadata: { rally_sandbox_files: [{ link: 'sandbox:/mnt/data/page.html', name: 'page.html', mime_type: 'text/html', inline_base64: 'PHA+' }] } } },
    } }));
    expect(result.content.messages[0]).toEqual({ role: 'assistant', sourceMessageId: 'a', text: 'Done.\n\nDownload the HTML or the CSV. Again: HTML', files: [
      { name: 'page.html', mimeType: 'text/html', kind: 'artifact', source: { kind: 'inline', encoding: 'base64', data: 'PHA+' } },
      { name: 'rows.csv', mimeType: 'application/octet-stream', kind: 'artifact', source: expect.objectContaining({ kind: 'unavailable', reference: 'sandbox:/mnt/data/rows.csv' }) },
    ] });
  });
  it('imports a Deep Research report from its widget where the widget appears', () => {
    const report = { id: 'report-1', author: { role: 'assistant' }, content: { content_type: 'text', parts: ['# Findings\n\nSee \uE200cite\uE202turn1\uE201.'] },
      metadata: { content_references: [{ matched_text: '\uE200cite\uE202turn1\uE201', alt: '([slack.com](https://slack.com/help))' }] } };
    const result = parseSessionExport('chatgpt', JSON.stringify({ current_node: 'b', mapping: {
      a: { parent: null, message: { id: 'a', author: { role: 'user' }, content: { content_type: 'text', parts: ['Research this'] } } },
      w: { parent: 'a', message: { id: 'w', author: { role: 'tool' }, channel: 'commentary', content: { content_type: 'code', text: '{}' },
        metadata: { chatgpt_sdk: { widget_state: JSON.stringify({ plan: {}, report_message: report }) } } } },
      b: { parent: 'w', message: { id: 'b', author: { role: 'user' }, content: { content_type: 'text', parts: ['Narrow it'] } } },
    } }));
    expect(result.content.messages).toEqual([
      { role: 'user', text: 'Research this', sourceMessageId: 'a' },
      { role: 'assistant', text: '# Findings\n\nSee ([slack.com](https://slack.com/help)).', sourceMessageId: 'report-1' },
      { role: 'user', text: 'Narrow it', sourceMessageId: 'b' },
    ]);
  });
  it('copies a published claude.ai Artifact once, at its first card', () => {
    const card = { type: 'file', published_url: 'https://claude.ai/code/artifact/a1', published_artifact_id: 'a1', title: 'Nav',
      rally_files: [{ path: 'project/Main.html', content_type: 'text/html', inline_base64: 'PHA+PC9wPg==' }] };
    const result = parseSessionExport('claude', JSON.stringify({ uuid: 'c1', name: 'Chat', chat_messages: [
      { uuid: 'a1', sender: 'assistant', content: [{ type: 'tool_result', content: [], display_content: card }, { type: 'text', text: 'Made it.' }] },
      { uuid: 'a2', sender: 'assistant', content: [{ type: 'tool_result', content: [], display_content: card }, { type: 'text', text: 'Updated.' }] },
    ] }));
    expect(result.content.messages).toEqual([
      { role: 'assistant', text: 'Made it.', sourceMessageId: 'a1', files: [
        { name: 'Main.html', mimeType: 'text/html', kind: 'artifact', source: { kind: 'inline', encoding: 'base64', data: 'PHA+PC9wPg==' } }] },
      { role: 'assistant', text: 'Updated.', sourceMessageId: 'a2' },
    ]);
  });
  it('links a published claude.ai Artifact it could not copy, and writes web citations as links', () => {
    const card = { type: 'file', published_url: 'https://claude.ai/code/artifact/a1', title: 'Nav [Options]' };
    const result = parseSessionExport('claude', JSON.stringify({ uuid: 'c1', name: 'Chat', chat_messages: [
      { uuid: 'h1', sender: 'human', content: [{ type: 'text', text: 'Mock it up' }] },
      { uuid: 'a1', sender: 'assistant', content: [
        { type: 'tool_use', name: 'Artifact', input: { action: 'publish' } },
        { type: 'tool_result', name: 'Artifact', content: [], display_content: card },
        { type: 'tool_result', name: 'Artifact', content: [], display_content: { ...card, published_action: 'opened' } },
        { type: 'text', text: 'Columns work. Pinning helps.', citations: [
          { url: 'https://www.example.com/columns', start_index: 0, end_index: 13 },
          { url: 'http://insecure.example', start_index: 15, end_index: 27 },
        ] },
      ] },
    ] }));
    expect(result.content.messages[1]).toEqual({ role: 'assistant', sourceMessageId: 'a1',
      text: '[Nav Options](https://claude.ai/code/artifact/a1)\n\nColumns work. ([example.com](https://www.example.com/columns)) Pinning helps.' });
  });
  it('keeps claude.ai uploads listed only in files_v2, once when also in files', () => {
    const upload = (uuid: string, name: string) => ({ file_uuid: uuid, file_name: name, file_kind: 'blob', inline_base64: 'UEs=', mime_type: 'application/zip' });
    const result = parseSessionExport('claude', JSON.stringify({ uuid: 'c', chat_messages: [
      { uuid: 'h1', sender: 'human', content: [{ type: 'text', text: 'Files' }], files: [upload('f1', 'one.zip')], files_v2: [upload('f1', 'one.zip'), upload('f2', 'two.zip')] },
    ] }));
    expect(result.content.messages[0]!.files?.map((file) => file.name)).toEqual(['one.zip', 'two.zip']);
  });
  it('writes each distinct claude.ai source once where several support one span', () => {
    const result = parseSessionExport('claude', JSON.stringify({ uuid: 'c', chat_messages: [
      { uuid: 'a1', sender: 'assistant', content: [{ type: 'text', text: 'Found it.', citations: [
        { url: 'https://x.com/a', end_index: 9 }, { url: 'https://x.com/b', end_index: 9 }, { url: 'https://x.com/a', end_index: 9 },
      ] }] },
    ] }));
    expect(result.content.messages[0]!.text).toBe('Found it. ([x.com](https://x.com/a)) ([x.com](https://x.com/b))');
  });
  it('names a copied Claude upload preview for its own format', () => {
    const result = parseSessionExport('claude', JSON.stringify({ uuid: 'c4', name: 'Bug', chat_messages: [
      { uuid: 'h1', sender: 'human', content: [{ type: 'text', text: 'See the screenshot' }], files: [
        { file_kind: 'image', file_name: 'shot.png', preview_url: '/api/o/files/f/preview', inline_base64: 'UklGRg==', mime_type: 'image/webp', inline_name: 'shot.webp' },
        { file_kind: 'image', file_name: 'missing.png', preview_url: '/api/o/files/g/preview' },
      ] },
    ] }));
    expect(result.content.messages[0]!.files).toEqual([
      { name: 'shot.webp', mimeType: 'image/webp', kind: 'attachment', source: { kind: 'inline', encoding: 'base64', data: 'UklGRg==' } },
      expect.objectContaining({ name: 'missing.png', source: expect.objectContaining({ kind: 'unavailable' }) }),
    ]);
  });
  it('names a Claude Research report by its type and keeps its cited sources', () => {
    const result = parseSessionExport('claude', JSON.stringify({ uuid: 'c3', name: 'Research', chat_messages: [
      { uuid: 'a1', sender: 'assistant', content: [
        { type: 'text', text: '\n\nYour report is ready.' },
        { type: 'tool_use', name: 'artifacts', input: { command: 'create', title: 'Background: Evaluation', type: 'text/markdown',
          content: '# Report\n\nHe was the 10th hire.', md_citations: [{ url: 'https://example.com/profile', start_index: 10, end_index: 31 }] } },
      ] },
    ] }));
    expect(result.content.messages[0]).toEqual({ role: 'assistant', text: 'Your report is ready.', sourceMessageId: 'a1', files: [
      { name: 'Background: Evaluation.md', mimeType: 'text/markdown', kind: 'artifact',
        source: { kind: 'inline', encoding: 'utf8', data: '# Report\n\nHe was the 10th hire. ([example.com](https://example.com/profile))' } }] });
  });
  it('imports claude.ai files and drawn visuals, but not refused writes or Artifact drafts', () => {
    const result = parseSessionExport('claude', JSON.stringify({ uuid: 'c2', name: 'Poem', chat_messages: [
      { uuid: 'h1', sender: 'human', content: [{ type: 'text', text: 'Write a poem file' }] },
      { uuid: 'a1', sender: 'assistant', content: [
        { type: 'tool_use', id: 't1', name: 'create_file', input: { path: '/home/claude/poem.md', file_text: '# Poem' } },
        { type: 'tool_result', tool_use_id: 't1', is_error: false, content: [] },
        { type: 'tool_use', id: 't2', name: 'create_file', input: { path: '/home/claude/poem.md', file_text: '# Again' } },
        { type: 'tool_result', tool_use_id: 't2', is_error: true, content: [] },
        { type: 'tool_use', id: 't3', name: 'create_file', input: { path: '/mnt/user-data/outputs/artifacts/x/project/Main.html', file_text: '<p>draft</p>' } },
        { type: 'tool_result', tool_use_id: 't3', is_error: false, content: [] },
        { type: 'tool_use', id: 't4', name: 'visualize:show_widget', input: { title: 'poem_view', widget_code: '<div>A Quiet Moment</div>' } },
        { type: 'tool_result', tool_use_id: 't4', is_error: false, content: [] },
        { type: 'token_budget' },
        { type: 'text', text: 'Done.' },
      ] },
    ] }));
    expect(result.content.messages[1]).toEqual({ role: 'assistant', text: 'Done.', sourceMessageId: 'a1', files: [
      { name: 'poem.md', mimeType: 'text/markdown', kind: 'artifact', source: { kind: 'inline', encoding: 'utf8', data: '# Poem' } },
      { name: 'poem_view.html', mimeType: 'text/html', kind: 'artifact', source: { kind: 'inline', encoding: 'utf8', data: '<div>A Quiet Moment</div>' } },
    ] });
  });
  it("follows the selected ChatGPT branch and drops hidden, thinking and tool turns", () => {
    const message = (role: string, value: string, extra = {}) => ({ author: { role }, content: { content_type: "text", parts: [value] }, ...extra });
    const content = parseSessionExport("chatgpt", JSON.stringify({ title: "Branch", current_node: "b", mapping: {
      a: { parent: null, message: message("user", "Question") },
      discarded: { parent: "a", message: message("assistant", "Old answer") },
      thinking: { parent: "a", message: message("assistant", "Private", { channel: "analysis" }) },
      progress: { parent: "thinking", message: message("assistant", "Checking the PR", { channel: "commentary" }) },
      tool: { parent: "progress", message: message("tool", "Tool result") },
      b: { parent: "tool", message: message("assistant", "Selected answer \uE200cite\uE202turn0view0\uE201") },
    } }));
    expect(content.content.messages).toEqual([{ role: "user", text: "Question", sourceMessageId: "position:0" }, { role: "assistant", text: "Selected answer", sourceMessageId: "position:4" }]);
  });
  it("reads public Claude text and preserves unavailable file references", () => {
    const result = parseSessionExport("claude", JSON.stringify({ snapshot_name: "Comments", chat_messages: [
      { sender: "human", text: "", content: [{ type: "text", text: "Why two comments?" }], files: [{ name: "hidden.png" }] },
      { sender: "assistant", text: "", content: [{ type: "thinking", thinking: "private" }, { type: "tool_use", name: "read" }, { type: "text", text: "Check the header." }], compaction_summary: "omit" },
    ] }));
    expect(result.content.messages).toMatchObject([{ role: "user", text: "Why two comments?", files: [{ name: "hidden.png", source: { kind: "unavailable" } }] }, { role: "assistant", text: "Check the header." }]);
  });
  it('keeps claude.ai image and document blocks, including attachment-only turns', () => {
    const result = parseSessionExport('claude', JSON.stringify({ uuid: 'code-files', chat_messages: [
      { uuid: 'u1', sender: 'human', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } }] },
      { uuid: 'a1', sender: 'assistant', content: [{ type: 'document', title: 'Notes', source: { type: 'text', media_type: 'text/plain', data: 'Summary' } }] },
    ] }));
    expect(result.content.messages).toMatchObject([
      { role: 'user', text: '', files: [{ kind: 'attachment', source: { kind: 'inline', data: 'aGVsbG8=' } }] },
      { role: 'assistant', text: '', files: [{ kind: 'artifact', source: { kind: 'inline', data: 'Summary' } }] },
    ]);
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
  it("preserves Claude document text sources as original file content", () => {
    const result = parseSessionExport("claude", JSON.stringify({ chat_messages: [
      { sender: "human", content: [{ type: "document", title: "Meeting notes", source: {
        type: "text", media_type: "text/plain", data: "Café notes\nFollow up tomorrow.",
      } }] },
    ] }));
    expect(result.content.messages).toEqual([{ role: "user", text: "", sourceMessageId: "position:0", files: [{
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
  it("reports a partial claude.ai artifact event as unavailable without importing the tool call", () => {
    const result = parseSessionExport("claude", JSON.stringify({ uuid: "c", chat_messages: [{ uuid: "a1", sender: "assistant", content: [
      { type: "tool_use", name: "artifacts", input: { id: "diagram", command: "update" } },
    ] }] }));
    expect(result.content.messages).toMatchObject([{ role: "assistant", text: "", files: [
      { name: "diagram", source: { kind: "unavailable", reference: "diagram" } },
    ] }]);
  });
  it("rejects arbitrary destinations and identifies Code login requirements", () => {
    for (const url of ["https://example.com/share/123", "https://claude.ai.evil.test/share/123", "http://claude.ai/share/123", "https://user:password@claude.ai/share/123"]) expect(() => sessionShareUrl(url)).toThrow();
    expect(() => sessionShareUrl("https://claude.ai/code/session_01As61kVEUr9wNkGSohfNaZb")).toThrow("signed-in");
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
      { role: "user", text: "Draw a garden", sourceMessageId: "position:0" },
      { role: "assistant", text: "", sourceMessageId: "position:6", files: [{ name: "Garden.png", mimeType: "image/png", kind: "artifact", source: { kind: "unavailable", reference: "sediment://image-1", reason: expect.any(String) } }] },
      { role: "assistant", text: "Here is your garden", sourceMessageId: "position:7" },
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
  it("rejects empty or non-conversation content", () => {
    expect(() => parseSessionExport("claude", "{}")).toThrow("Expected Claude");
    expect(() => parseSessionExport("chatgpt", '<html>Log in</html>')).toThrow("Malformed conversation data");
    expect(() => parseSessionExport("chatgpt", '{}')).toThrow("Expected mapping/current_node or linear_conversation");
  });
});
