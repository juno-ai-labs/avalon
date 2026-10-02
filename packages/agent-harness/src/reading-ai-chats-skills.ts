import type { HarnessSkill } from "./index";

/**
 * Skills for reading an AI chat — a ChatGPT or Claude conversation, or any
 * other assistant's — out of a page open in Rally's browser.
 *
 * One generic procedure and one companion per provider. The generic skill is
 * written against what every chat product has to have rather than against any
 * markup: the page holds the conversation as data before it renders it, that
 * data is a list or tree of messages with authors and ids, and the page itself
 * knows how to fetch it again. A redesign moves class names and components
 * around; it does not remove those. The provider skills carry the concrete
 * routes and shapes Rally's earlier fixed readers depended on, offered as
 * where to look first and checked before trusting, so a provider change costs
 * a fallback to the generic procedure rather than a wrong import.
 *
 * `ownerPlugin` is Rally's browser plugin: every step reads or drives a page
 * through it, so a run without a browser never sees these in its catalog.
 * Spelled as a literal for the reason `building-live-sites` spells Terminal's.
 */
const BROWSER_PLUGIN = "avalon:browser";

const READING_AN_AI_CHAT_BODY = `Use this to copy a conversation from an AI chat page open in the browser — its messages, files and generated documents — exactly as the person sees it. Page designs change often; this procedure relies only on what every chat page must have, so it keeps working when the markup does not.

## Ground rules
- **Data over markup.** The page received the conversation as data before it drew it. Read that data. The rendered page is for finding your way and checking your result: long chats render only the part on screen, so a read of the page's elements silently drops messages.
- **Secrets stay in the page.** Never return cookies, local storage, session objects, access tokens or request headers from page script. If a request needs the page's own token, obtain and use it inside the same script and return only the result.
- **Look before you click.** Clicking can open sign-in prompts, upgrade dialogs or share menus that cover the conversation. Read the page outline or take a screenshot first, click only a control you have identified, and only to reveal something you need, such as a collapsed message.
- **One provider message, one Rally message.** Each message keeps the provider's own id. Do not merge two messages because the page draws them as one turn, and do not split one.

## Procedure
1. **Load the provider's companion skill** if one matches the page's site — it says where that provider usually keeps the data. Treat its routes and field names as the first place to look, and fall back to the steps below for anything that no longer matches.
2. **Find the conversation data**, cheapest first:
   - **Data embedded in the page.** Look through script elements and hydration payloads for a large JSON-like value. Some pages stream it as an index-encoded array, where objects refer to other entries by their position in the array; decode those references before searching.
   - **The page's own requests.** List the resource URLs the page has loaded and pick the one that returned the conversation, usually a path containing the conversation's id. Request it again from page script with the page's credentials, just as the page did.
   - **In the page's memory**, as a last resort before the DOM.
   Recognise the conversation by its **shape**, not by names: a collection of objects that each carry an author or role, some text or content parts, and an id, plus usually a parent link and a pointer to the current or latest message. Keep the whole object on window so later calls can use it without fetching it again.
3. **Take the branch the person sees.** If messages form a tree, where editing or regenerating forked it, start at the current or latest message and follow parent links back to the root, then reverse. Check that the walk ends at the root; a walk that stops early has lost the beginning of the conversation. If the data is a plain list, keep its order.
4. **Keep only what the transcript shows.** Keep user messages and assistant replies. Leave out system and developer messages, messages marked hidden, reasoning or thinking, tool calls and their raw results, and earlier versions of an edited message. Leave out progress narration only where the data marks it as such — a channel, phase, type or flag — never by judging its wording: a short line such as "Let me check…" that the page shows is part of the reply. Exception: a tool result the page shows as the answer — a generated image, a finished report — is part of the reply.
5. **Take text from the data, not from the screen.** Use the Markdown the data carries; converting rendered HTML loses structure and repeats titles that cards draw twice. Turn citation markers into Markdown links to their sources, and remove any private-use or control characters left behind.
6. **Collect files.** For each shown message, gather files the person attached, and files, images, documents, canvases or artifacts the assistant produced. Fetch each file's bytes through the same route the page uses to show or download it, then compare the byte count with the size the data records before you store it: a smaller result is a preview or thumbnail, so try the next route. Store the bytes and attach them to the message they belong to. Name each file by the document's own title or subject, keeping its words and spaces: replace only characters a file name cannot hold (/ \\ : * ? " < > |), and give it exactly one extension, the one its type opens with. Take a document's latest version, once, on the message where it first appears. Do not also paste its body into the message text. If you cannot fetch a file, list it as unavailable and give the reason.
7. **Fall back to the page only if steps 2–3 found nothing.** Find message elements by what they mean, not by how they look: a role or author attribute, an id attribute, accessible labels such as "You said" or the assistant's name, and repeated sibling structure. Scroll from top to bottom, collecting each message under its id as it renders, and expand collapsed messages. Use only ids the page itself provides; if none exist, fail the import as unreadable rather than numbering messages.
8. **Confirm the import before you finish.** Work through the checks below on the messages you assembled, fix what fails, and only then finish.

## Confirm the import
Check your result against the page, not against itself. Most failures are silent: nothing errors, and the import is just wrong.
- **Count against the page.** Scroll the conversation from top to bottom and count the turns the page shows. Pages render lazily, so turns above or below the screen may not exist until you scroll to them; if the first turn you see is not the conversation's first, more turns are above. Your message count should match. A provider that groups several assistant messages into one turn makes yours higher, never lower.
- **First and last.** Your first message is the page's first, and your last is its last, with the same opening words.
- **Shape.** Messages mostly alternate between user and assistant. Two user messages in a row, or an assistant message with no text and no file, usually means a hidden, tool or reasoning message was kept, or a reply was lost.
- **Nothing shown was dropped.** Compare two or three assistant messages, including a long one, word for word against the page. Every paragraph the page shows must be in yours. If you filtered text, the filter is wrong; remove it.
- **Nothing hidden leaked in.** No message is only a tool's placeholder notice, a status line, or reasoning.
- **No provider syntax left in text.** Search every message for private-use or control characters, the provider's own block or directive markup, raw citation markers, links in a scheme a browser cannot open, and JSON fragments. Each is a step that missed its conversion.
- **Nothing twice.** No document both pasted in the text and attached as a file, no image both as an upload and as a content part, no message repeated under two ids.
- **Files are the originals.** Where the data records a file's size, the bytes you stored are exactly that size. A smaller image is a preview or thumbnail: go back for the original. Only when no route returns the original, keep the preview, give it the extension of the type you received, and say in its name or the message that it is a preview.
- **Files are real.** Every file has a readable name with one extension and a size above zero, and sits on the message whose page turn shows it. The page's file and document cards add up to your files plus those you listed as unavailable. A notice that files are hidden or were not shared still counts: list each such file as unavailable, by name if the data has one, and say why.
- **Ids are the provider's.** Every sourceMessageId is unique and comes from the data, never from the page's element order. Where a provider gives messages no ids at all, use the scheme its companion skill names. On an update, your messages start with exactly the ids you were given.

## Anti-patterns
- **Reverse-engineering the page every time.** Do this instead: try the companion skill's routes first and spend calls on discovery only when they fail.
- **Returning large blobs to read them.** Do this instead: keep data on window and return only the counts, ids and short samples you need to decide the next step.
- **Clicking at coordinates you have not seen.** Do this instead: read the outline or take a screenshot first, then click a control you identified.`;

const READING_CHATGPT_BODY = `Hints for copying a conversation from chatgpt.com. They describe where ChatGPT has kept its data; verify each before relying on it. A hint marked (seen once) comes from a single conversation: check it before building on it, and expect it to be incomplete. When one no longer holds, use the generic procedure in the reading-an-ai-chat skill for that part.

## Where the conversation is
- **The person's own chat** (/c/<id>): the signed-in API at /backend-api/conversation/<id>. It wants the access token ChatGPT's own client gets from /api/auth/session (the accessToken field) as a Bearer token. Fetch both inside one page script and never return the token. Cookies alone can return a misleading not-found.
- **A shared task** (/s/<id>, often cx_...; Codex and agent runs; seen once): /backend-api/wham/shared_threads/<id> returns { title, turns }. Each turn's items have a type: userMessage (its content list holds the text) is the person's message; agentMessage with a phase of commentary is progress shown only in the collapsed work log, so leave it out; agentMessage without a phase is the reply; reasoning is left out. Items carry no ids, and a shared task never changes, so use <shareId>:<turn index>:user for the person's message and <shareId>:<turn index>:assistant for the reply. If a turn has more than one reply item, add :<item index>. A share that says "not found" is page_unavailable.
- **A shared link** (/share/<id>): the page embeds the conversation in its own script tags as a React Router stream, as string arguments to streamController.enqueue(...). Each argument is JSON for an index-encoded array, where object keys and values point at other entries by index. Decode it and search for an object whose conversation_id (or backing_conversation_id) is the share id. The older anonymous route /backend-anon/share/<id> is a fallback.

## Shape
- A tree: mapping holds nodes by id, each with a message and a parent; current_node is the leaf the person sees. Walk from current_node up through the parent links and reverse. If there is no mapping, a linear_conversation list may be there instead.
- message.author.role is user, assistant, tool or system. Keep user and assistant. Keep a tool message only when its channel is final and it carries images: that is a generated image, which belongs to the reply.
- Leave out messages with metadata.is_visually_hidden_from_conversation, a channel of analysis, summary or commentary, a recipient other than all, and content types such as thoughts, reasoning_recap or model_editable_context.
- Text is in content.parts: strings are Markdown, and objects with content_type image_asset_pointer are images. Each message is its own Rally message under its id, even when ChatGPT draws two consecutive assistant messages as one turn.
- Citations sit inline between the private-use characters U+E200 and U+E201 and are described in metadata.content_references. Where a reference has written-out text in its alt field, replace the marker with that text; remove any other marker.
- A deep-research or app result lives in metadata.chatgpt_sdk.widget_state as JSON, with a report_message whose content.parts are the finished report. That metadata sits on a tool or commentary message you otherwise leave out, so search every message on the branch for it before filtering. A widget_state whose report_message has text is a reply the page shows: import it as an assistant message, using report_message.id, where the widget appears. The "working on your report" notes around it are progress, not the reply.

## Files
- Uploads are in metadata.attachments, by id. An uploaded image also appears as an image_asset_pointer part with the same id; take it once. A pointer's id is its text after the scheme (sediment:// or file-service://), without any query string.
- Bytes come in two steps: the files route returns JSON with download_url, mime_type and file_size_bytes, then you fetch download_url. That link may be on another origin; fetch it without credentials. Own chat: /backend-api/files/download/<fileId>?conversation_id=<id>&inline=false, with the Bearer token. Shared link: /backend-anon/files/download/<fileId>?shared_conversation_id=<shareId>&inline=false.
- Files ChatGPT wrote in its code sandbox appear in replies as Markdown links with a sandbox: target. Own chat: /backend-api/conversation/<id>/interpreter/download?message_id=<messageId>&sandbox_path=<path>. Shared link: /backend-anon/share/<shareId>/file_from_message/<messageId>?file_path=<path>. Keep the link's label as text and attach the file.
- Drafted emails and other writing blocks sit inside the message text as directives: a line starting :::writing{...} with attributes such as variant="email" and subject="...", then the body, then a closing ::: line. Turn each block into a Markdown file named by its subject (or the variant, if it has none) with a .md extension. In the text, put one line in its place naming it, such as "Email draft: Welcome to Rally (attached)". Never leave the ::: syntax in the text. Attribute values can contain braces themselves (seen once), as in subject="{inviterName} invited you", so end the attribute list at the } that follows the last quoted value, not at the first } you meet. Count the :::writing openings first and check that you made one file per opening.
- Canvases (textdocs) and other documents: take them from the data as files named by their own title. On the page they are cards whose header repeats the title, so text read from the screen comes out doubled.

## Page fallback
Turns have been marked with data-testid values starting "conversation-turn-", plus data-message-author-role and data-message-id on the message itself. Expect these to drift; check that they exist before relying on them.`;

const READING_CLAUDE_BODY = `Hints for copying a conversation from claude.ai. They describe where Claude has kept its data; verify each before relying on it. A hint marked (seen once) comes from a single conversation: check it before building on it, and expect it to be incomplete. When one no longer holds, use the generic procedure in the reading-an-ai-chat skill for that part.

## Where the conversation is
- **The person's own chat** (/chat/<id>): /api/organizations/<orgId>/chat_conversations/<id>?tree=True&rendering_mode=messages&render_all_tools=true. To find the organization, fetch /api/organizations and try each uuid until one returns the conversation. Do not read cookies to find it.
- **A shared link** (/share/<id>): /api/chat_snapshots/<id>?rendering_mode=messages&render_all_tools=true.
- **A Claude Code session** (/code/session_<id>; seen once, and its file route did not answer on a later run): readable only signed in as its owner; if the page asks for sign-in, fail with sign_in_required. It is a coding agent's transcript. The person's prompts and Claude's replies are the messages; tool calls, file edits, diffs and command output are steps, not messages. Its events have come from /v1/code/sessions/<id>/events, paged with a cursor until there are no more: read every page. A user event the person sent comes from the client; one from the worker is injected by the system (task notifications, image notes) and is not the person's. Every assistant event with text is shown, including short lines between tool steps; keep each one, never a selection. Files the session made or was given have been at /api/organizations/<orgId>/files/<fileId>/content.
- Fetch with credentials: "include" from the claude.ai page itself.

## Shape
- chat_messages lists every message, including edited branches. current_leaf_message_uuid is the message the person sees last. Walk parent_message_uuid from it back to the root, the all-zero uuid ending in 4000-8000-000000000000, and reverse. If the walk stops before the root, the beginning is missing: fetch again rather than finishing.
- sender is human (the person) or assistant. Each message's uuid is its id. A message marked truncated is incomplete; fetch again rather than importing it.
- content is a list of blocks. Keep every text block, in order, separated by blank lines. Claude shows them all, including short lines between tool steps such as "Let me check…". Never drop one for its wording. Each text block's citations name a url and an end_index; add a Markdown link to the source's host right after the cited span. Leave out thinking, redacted_thinking, token_budget, and ordinary tool_use and tool_result blocks.
- Documents the assistant made are tool blocks you turn into files rather than skip:
  - A tool_use named artifacts: its input has id, title, type (the MIME type), content, or a file_path. Later updates to the same id change the document; take its final content once, as a file named by its title.
  - A tool_use named create_file with input path and file_text, unless the matching tool_result reports an error. A file written under /mnt/user-data/outputs/artifacts/ is a draft of a published artifact; skip it.
  - A tool_use whose name ends in :show_widget, with input widget_code (SVG or HTML) and a title: keep it as a file, never run it.
  - A tool_result whose display_content has type file and a published_artifact_id is a published artifact card. Its files are listed at /api/frame/<artifactId>?org=<orgId>, sent with the headers X-Frame-CP: go and X-Frame-Platform: web, and served from <artifactId>.frame.claudeusercontent.com, which the page cannot read itself. Load them through the browser's cross-site file loader, or keep the card's published_url as a link if that fails.

## Files
- Uploads are in attachments (text Claude extracted, in extracted_content), files and files_v2. An upload listed in both files lists is one file, matched by file_uuid.
- A preview_url or thumbnail_url is a resized copy, never the original. Try every original route below before falling back to it. This holds for images as for any other upload: an image's original is in the sandbox like a CSV's.
- For original bytes, try the conversation's sandbox first: /api/organizations/<orgId>/conversations/<id>/wiggle/download-file?path=<path>. The path is the file's own path, or /mnt/user-data/uploads/<file_name> with characters other than letters, digits, dot, underscore and hyphen replaced by _. Accept the result only if its size matches size_bytes.
- Otherwise a PDF's document_asset with file_variant original has a /api/ url. Only when neither returns the original, take the image's preview_url as a last resort: it is a resized copy, so name it with the extension of the type you actually received and say it is a preview.
- A shared link can hide attachment contents: file_count is higher than the files listed. List the missing ones as unavailable, with that reason.

## Page fallback
User messages have carried data-testid "user-message"; assistant messages a font-claude-message class or a data-is-streaming attribute. Expect these to drift; check that they exist before relying on them.`;

export const READING_AN_AI_CHAT_SKILL: HarnessSkill = {
  name: "reading-an-ai-chat",
  description:
    "How to copy a conversation out of an AI chat web page: find the conversation data the page loaded, keep the branch and messages the person sees, collect files and generated documents, and check the result against the page.",
  whenToUse:
    "When you must read or import a chat with an AI assistant from a page open in the browser, whichever site it is on.",
  body: READING_AN_AI_CHAT_BODY,
  ownerPlugin: BROWSER_PLUGIN,
};

export const READING_CHATGPT_CONVERSATIONS_SKILL: HarnessSkill = {
  name: "reading-chatgpt-conversations",
  description:
    "Where chatgpt.com keeps a conversation and its files — the signed-in and shared-link routes, the message tree, citations, uploads and sandbox files — as hints to check before relying on them.",
  whenToUse:
    "When the chat you are reading is on chatgpt.com, together with reading-an-ai-chat.",
  body: READING_CHATGPT_BODY,
  ownerPlugin: BROWSER_PLUGIN,
};

export const READING_CLAUDE_CONVERSATIONS_SKILL: HarnessSkill = {
  name: "reading-claude-conversations",
  description:
    "Where claude.ai keeps a conversation and its files — the organization and shared-snapshot routes, the branch walk, content blocks, artifacts and uploads — as hints to check before relying on them.",
  whenToUse:
    "When the chat you are reading is on claude.ai, together with reading-an-ai-chat.",
  body: READING_CLAUDE_BODY,
  ownerPlugin: BROWSER_PLUGIN,
};

/** The generic reader first, then each provider's companion. */
export const READING_AI_CHATS_SKILLS: readonly HarnessSkill[] = [
  READING_AN_AI_CHAT_SKILL,
  READING_CHATGPT_CONVERSATIONS_SKILL,
  READING_CLAUDE_CONVERSATIONS_SKILL,
];
