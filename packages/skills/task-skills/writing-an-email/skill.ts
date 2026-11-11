import type { HarnessSkill } from "../../types";

const WRITING_AN_EMAIL_BODY = `An email leaves the building. Every address, link, and figure in it is a claim
you are making on someone's behalf, so the work is mostly settling those before
you write a word — and the drafting itself is the short part.

This applies to whichever mail connector this run has. Providers differ in what
their tools are called; none of what follows depends on that.

## 1. Settle whether this is a draft or a send

A draft is reviewable and a send is not. Default to a **draft** unless the
request plainly says to send it, and say which you did. When the request is
ambiguous and the message goes to someone outside this conversation, draft it and
say it is waiting for a look.

## 2. Resolve every recipient before composing

Look each person up through the connection's contact or correspondence search.
Use an address exactly as a tool returned it.

- **Never build an address from a name and a company domain.** A person's
  address is a fact about them, not a pattern.
- If the lookup returns **several plausible people**, that is ambiguity, not a
  ranking. Ask which one, listing the candidates and where each was seen.
- If it returns **nothing**, ask for the address — and say what you searched, so
  the person can tell you searched badly rather than that the address does not
  exist.

## 3. Establish who you are sending as

Read the connected account's own identity from the connection rather than
inferring it from a signature, a display name, or a previous message's headers.
Those are somebody's claim about the account; the account is the authority. It
also settles whether you are writing as an individual or a shared mailbox, which
changes how the message should read.

## 4. Source every fact the message asserts

A link, a date, an amount, a name, a quoted decision: each must come from a tool
result in this run, from the task context, or from a person here. A plausible
value is the failure mode, not the fallback — an invented download link is
indistinguishable from a real one until someone clicks it.

A search that returned only identifiers is a **step, not an answer**. Open the
records it named before quoting anything from them.

If a fact cannot be sourced, that is a missing identifier: look it up, or ask.
Do not write around it with something that reads right.

## 5. Decide new thread or reply, then carry the identifiers

A reply belongs in its thread. That usually needs two identifiers from the
**same search result** — the thread's, and the original message's — passed
through exactly as returned. Retyping or mixing them from different results
lands the message somewhere else, or nowhere.

Starting a new thread is the right choice when the subject is genuinely new.
Say which you did.

## 6. Write the message the request actually asked for

Cover every ask in the request, in the recipient's language rather than the
workspace's. Keep it short enough to answer. If the request named things to
include — a link, an address, a question — check each one is present before you
write it out.

## 7. Verify, then report what you did

Do not describe a draft as created or a message as sent unless the tool result
says so. Report the outcome, the recipients you used, and where each address
came from. If you asked for something and are waiting, say that instead.

## Anti-patterns

- **Asking for an address before searching for it.** Search the correspondence
  first; ask only when that comes back empty, and say what you tried.
- **Composing an address from a name and a domain.** Look it up, or ask.
- **Quoting a URL or a figure from memory.** Fetch it, or take it from the
  request. A link nobody verified is the easiest thing in a message to get
  wrong and the hardest for the reader to notice.
- **Answering from a list of search hits.** Read the records before quoting
  them.
- **Sending when a draft was asked for.** Draft by default; sending is the
  irreversible one.
- **Reporting success from an unconfirmed call.** Say what the result said.

Creating a calendar invitation instead? Use **scheduling-a-calendar-event**,
which has the same addressing rule and its own on notifications.`;

/**
 * How to send something to a person from an authorized mail connection.
 *
 * Provider-agnostic on purpose: the failures it exists to prevent — an address
 * composed from a name and a domain, a link quoted from memory, a person asked
 * for something the connection could have looked up — are properties of the
 * task, not of any one provider, and the next mail connector will have them too.
 */
export const WRITING_AN_EMAIL_SKILL: HarnessSkill = {
  name: "writing-an-email",
  description:
    "How to write an email that leaves the building: resolve every recipient through the connection before composing, source every link and fact it asserts, thread a reply correctly, and draft rather than send by default.",
  whenToUse:
    "When a request asks for an email to be drafted, replied to, or sent through a connected mail account.",
  body: WRITING_AN_EMAIL_BODY,
};
