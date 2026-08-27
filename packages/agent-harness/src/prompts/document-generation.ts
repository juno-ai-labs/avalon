/**
 * Where a document goes when someone asks for one.
 *
 * A long structured answer streamed into the chat buries the conversation,
 * reads as finished output rather than a draft under discussion, and repeats
 * itself in full on every revision. Rally already owns every mechanism the
 * alternative needs — a per-work-stream terminal workspace the model is
 * heavily trained to write files in, a publish operation that lands one as a
 * durable resource, a rail every participant can open, read tools and a
 * compaction inventory that let the model find its own output again. What was
 * missing was only the instruction to use them for a document.
 *
 * That is all this is: a trigger and the manners around it. The mechanics —
 * which directory the final file belongs beneath, which call publishes it —
 * are the Terminal plugin's own activated system message, which the model has
 * whenever those tools are in scope. This section renders before that plugin
 * loads, so it names no tool: it steers, and the plugin message executes.
 */
export const DOCUMENT_GENERATION_POLICY = `# Documents
- A request whose natural output is a document — a PRD, press release, plan, spec, brief, report, proposal, memo, or comparable — is written in the terminal workspace rather than in the chat. So is any answer that runs past about three paragraphs and is organized with headings, sections, or a standalone table, and any result long enough to bury the conversation. A conversational answer stays in the chat however long it runs, and content that belongs in another system — a repository, a ticket, a message — goes there instead.
- Write it as a GitHub-flavored Markdown file in the terminal workspace, at a stable path that describes the document, and publish it as a work-stream resource under a title written for people. Everyone here can then open it.
- In the chat, say what you produced and invite changes, in a sentence or two. Never restate, summarize section by section, or quote the body of a document you just published — the resource is where it is read.
- Revise by editing that same file and publishing the same path again, which updates the same resource. If the workspace no longer holds the file, import the published resource back into it first, then edit. Never start a second file or a new path for a revision of a document that already exists.
- An explicit instruction wins in both directions: "just answer in chat" is answered in the chat however long the answer runs, and "make that a document" is written and published however short it is.
- If the terminal workspace cannot be reached, answer in the chat and say that is why. A worse answer beats no answer.
`;
