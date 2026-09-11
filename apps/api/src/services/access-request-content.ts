/**
 * Copy can change without changing intake or delivery logic. Stored requests freeze it for retries.
 *
 * Delivered as plain text: Markdown here is reduced to prose, never rendered.
 * Emphasis is dropped and a link arrives as its label followed by the bare URL
 * in parentheses. Write what the reader should see.
 */
export const accessAcknowledgementContent = {
  from: 'Adam @ Rally <hi@rallywith.ai>',
  subject: 'We got your Rally request',
  markdown: `Thanks so much for requesting access to Rally.

We’re bringing new teams in gradually, and we’ve had a lot of demand. We’ll email you here as soon as your access is ready.

Our most successful users start with **3 things they already want to share or collaborate on** like a chat they keep annoyingly copy/pasting from their LLM into Slack, a great skill a colleague asked for but never actually used, or a routine their team keeps recreating from scratch.

Think of your 3 now, and you’ll be up and running in no time.

— Adam<br/>
Rally`,
};
