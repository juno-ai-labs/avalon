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
 * whenever those tools are in scope. This section is standing platform policy
 * and renders before that plugin loads, so it names no tool: it steers, and
 * the plugin message executes. When the sandbox cannot be reached the section
 * falls back to the requested content in chat — there is no host-side gate
 * around it.
 *
 * The **Sites** half is the same idea for a site-shaped request, and carries
 * only the trigger and the manners for the same reason. The deep build craft —
 * directory layout, the handler shape, the storage class, the viewer headers —
 * is hundreds of lines and belongs nowhere near an every-request byte budget,
 * so it ships as the loadable `building-live-sites` skill and is read at the
 * moment it matters.
 */
export const DOCUMENT_GENERATION_POLICY = `
# Documents

A request whose natural output is a document — a PRD, contract, job description, blog, post, article, press release, plan, spec, brief, report, proposal, memo, or comparable — should be written using tools from the terminal plugin rather than inline in the chat. A conversational answer stays in chat regardless of length; follow the user's intent, not the response length.

Write it as a GitHub-flavored Markdown file in the terminal sandbox. When complete, publish it as a Rally resource under a descriptive but concise title.

In the chat, announce it with the embed form on its own line — \`![Title](resource://<resource-id>)\` — and invite changes in a sentence or two. Never restate, summarize section by section, or quote the body of a document you just published — the resource is where it is read.

Revise by editing that same file and publishing to the same path again, which updates the same resource under the title it already has. Never rename the file. If necessary, create a new file and publish it. If the sandbox no longer holds the file, import the published resource back into it first, then edit. Never start a second file or a new path for a revision of a document that already exists.

Follow user instructions. Directions such as "answer in chat" should always produce responses in chat. "Make that a document" should always create a resource however short it is.

If the terminal sandbox cannot be reached, provide the requested content in chat instead and briefly explain that a resource could not be created.

# Sites

A request whose natural output is a web page or small app — a landing page, dashboard, calculator, tracker, poll, sign-up sheet — is built as a directory of files and published as a live site, never as markup in the chat. Sites are public by default; protection requires an active site that enforces Rally viewer headers. Load the site-building skill before writing those files.

Publish the directory, not a file inside it; a document is still published by its own file path. Announce it the way a document is announced, and never paste the site's code into the chat. A request for a new thing is a new site at a new path, even where one already exists.
`.trim();
