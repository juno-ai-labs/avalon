import type { HarnessSkill } from "./index";

/**
 * Skills the harness ships with, for a host that has no library of its own yet.
 *
 * These are ordinary `HarnessSkill` values, not a second source: a host still
 * chooses which to put in `RunHarnessInput.skills`, and the frozen-scope rule is
 * unchanged. They exist because a workspace's first skill should not have to be
 * its own authoring surface, and because a procedure this general — how to
 * research something properly — is the same in every workspace.
 *
 * Authored as TypeScript rather than `SKILL.md` files because this package runs
 * in `workerd`, where there is no filesystem to read them from at startup.
 */

const DEEP_RESEARCH_BODY = `Research is finished when you can say what is true, how you know, and what you
could not establish. An answer without the second and third parts is a guess
with formatting.

## 1. Fix the question before you gather

Write down what would count as an answer. "Look into the Northwind renewal"
becomes: what is the renewal date, what is the amount, who owns it, and has
anything changed since the last time it was discussed. Four checkable claims
beat one vague brief, and they tell you when to stop.

If the request has a decision behind it — a reply to send, a number to commit
to — name that too. It sets how hard you have to work: a date you will put in
front of a customer needs corroboration, a date for your own orientation does
not.

## 2. Go to authorized sources first, public ones second

The connectors loaded for this run see things the public web cannot, and they
are the record this workspace actually runs on. Search them before reaching for
\`web_search\`, and prefer them when the two disagree — a vendor's marketing page
is not evidence about your own contract.

Order that usually holds:

1. The work stream itself and its attached resources — someone may have already
   answered this.
2. Authorized connectors — mail, tickets, documents, messages.
3. The public web, for facts about the outside world only.

If a source you need is not loaded, load its plugin. If it is not available to
this run at all, say so in the answer rather than substituting a public
approximation and hoping.

## 3. Corroborate, and date everything

One source is a claim. Two independent sources agreeing is a finding. Two
sources that turn out to be the same underlying document — a thread quoting an
email, a page summarising the page you already read — are still one source, and
the most common way a research answer is confidently wrong.

Every fact worth reporting has a date. When two sources conflict, the later
dated one usually wins, but say that it was a conflict rather than silently
picking. When nothing is dated, that is itself worth reporting.

Distinguish what was **proposed** from what was **agreed** from what **shipped**.
Most bad research answers are a proposal reported as a decision.

## 4. Track confidence as you go, not at the end

For each claim, keep the source and how directly it supports the claim. A
detail you inferred from two adjacent facts is not the same as one you read.
Doing this while gathering costs nothing; reconstructing it afterwards means
re-reading everything, which is why answers that skip it tend to assert
uniformly and be uniformly trusted.

## 5. Stop deliberately

Stop when the checkable claims from step 1 are answered, or when the next source
is unlikely to change any of them. Exhausting your budget is not a stopping
condition — it is what happens when you never chose one.

If you are running out of room, say what you would have checked next. That is
more useful than a fifth corroboration of the thing you already knew.

## 6. Report the shape of what you found

Lead with the answer, not the search. Then, for each claim, where it came from
and how firm it is. Then — always, not only when it is empty — what you could
not establish: the question you could not answer, the source you could not
reach, the conflict you could not resolve.

Never present an inference as a reading. If you concluded that the renewal is
probably annual because the last two invoices were twelve months apart, say
that; do not write "the contract renews annually".

Research is a read-only activity. It does not send, schedule, or update
anything. If the work needs an action afterwards, prepare it and ask.`;

/**
 * How to answer a question that needs evidence rather than recall.
 *
 * Deliberately about *this run's* sources — the loaded connectors, the work
 * stream, the public web in that order — because the failure mode it exists to
 * prevent is a confident public-web answer about a fact the workspace already
 * holds authoritatively.
 */
export const DEEP_RESEARCH_SKILL: HarnessSkill = {
  name: "deep-research",
  description:
    "How to research a question end to end: scope it into checkable claims, work authorized sources before the public web, corroborate and date every fact, and report what you could not establish.",
  whenToUse:
    "When a request needs evidence gathered and reconciled across more than one source, rather than a single lookup or a direct answer.",
  body: DEEP_RESEARCH_BODY,
};

/** Every skill this package ships. A host picks from these; none is automatic. */
export const BUILT_IN_SKILLS: readonly HarnessSkill[] = [DEEP_RESEARCH_SKILL];
