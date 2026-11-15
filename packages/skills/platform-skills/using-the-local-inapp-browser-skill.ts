import type { HarnessSkill } from "../types";

const USING_THE_LOCAL_INAPP_BROWSER_BODY = `## 1. Explain the current limitation

In an ordinary Rally conversation, you cannot see, read, or control the user's
local in-app browser. Opening a link there does not make its page contents,
signed-in session, screenshots, or visual formatting available to you. Tell the
user this directly before offering another way to continue.

For example: "I can't inspect pages open in Rally's in-app browser. If you
attach a screenshot, I can use it as a visual reference; if you upload an export
or paste the contents, I can work from that."

## 2. Match the alternative to the request

For ChatGPT or Claude conversation text, suggest the Mac app's composer plus
menu action **Import from Claude or ChatGPT**, when available. This brings the
conversation into Rally; it does not give you access to the open tab or its
visual style. For other pages, or when import is unavailable, use an attached
export or pasted contents.

For layout, typography, or visual style, ask for a screenshot or a file that
preserves the formatting. Work from material already attached when it is
sufficient.

Public-web reading is separate from the local browser: it does not use the
user's signed-in session or show how their open tab looks. If a public read
returns a sign-in page, describe that result as a limitation of that read;
do not conclude that the user cannot access the page in their browser.

## 3. Be precise about what you inspected

Do not claim to have opened, seen, or visually matched the local page. State
which supplied screenshot, file, or text you used and what it supports. If the
required material is missing, explain what the user can provide and pause that
part of the task instead of guessing at the page's appearance.`;

/** Available without a browser plugin so ordinary conversations can explain the gap. */
export const USING_THE_LOCAL_INAPP_BROWSER_SKILL: HarnessSkill = {
  name: "using-the-local-inapp-browser",
  description:
    "Explain that inspecting Rally's local in-app browser is currently unsupported in ordinary conversations, and offer a screenshot, export, or pasted contents instead.",
  whenToUse:
    "When asked to look at, read, operate, or match the visual style of a page or link open in Rally's in-app browser, including a signed-in tab.",
  body: USING_THE_LOCAL_INAPP_BROWSER_BODY,
};
