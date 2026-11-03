import type { HarnessSkill } from "../../index";

/**
 * How to answer a request for a data report: find every source that holds part
 * of the answer, work out how their records connect, and join them into the
 * view the person asked for.
 *
 * A task skill: it names the outcome a person asks for ("a report on…") and
 * routes to the procedure skills underneath it, rather than teaching one
 * capability. `using-external-structured-data` owns reading rows without loss;
 * this skill owns choosing and connecting the sources.
 *
 * No `ownerPlugin`, so every run sees it, including a Sidekick wizard. The
 * wizard section is in the body rather than a second skill because it is the
 * same job done ahead of time: map the data, then save a plan that runs follow.
 */
const REPORTING_ON_DATA_BODY = `A data report is most useful when it connects sources the person could not
easily line up by hand. Your job is to find every source that holds part of the
answer, work out how their records relate, and join them into the cut the
person asked for: one wide table, several linked views, or a short list of
findings.

## 1. Pin down what the report must show

Write the request as the questions the report answers and the grain of each
row. "How are our enterprise deals doing" becomes: one row per open enterprise
deal, with stage, amount, owner, last customer contact and open support
tickets. Note the time window and any filter the person named. If the person
asked for breadth ("everything we know about…"), the grain is the entity and
the columns come from every source you can connect.

## 2. Find every related source

Search all connected sources, not just the first one that answers. A single
entity usually has records in several places: a CRM, a spreadsheet, a ticket
system, email, calendar, chat, product analytics, documents. For each candidate
source, record:

- **What entity it describes** (a customer, a deal, a person, an event).
- **Its identifiers** (ids, emails, domains, names, dates).
- **Its time coverage and how fresh it is.**
- **How to read it completely** (which tool, which range or query).

Load each source's plugin as you need it. Prefer two or three sources that
connect cleanly over many that do not.

## 3. Find the keys that connect them

For each pair of sources you want to join, name the field that links them and
how reliable it is:

- **Exact ids** (a shared customer id, an order number) join directly.
- **Emails and domains** join people and companies across tools. Lowercase
  and trim before comparing.
- **Names** join only after normalizing case, spacing and suffixes such as
  "Inc". Treat a name match as weaker and say so.
- **Time** links events that have no shared id: a meeting and the deal it
  discussed, a release and the tickets that followed. State the window you used.

When no key exists, do not guess a join. Report the sources side by side and
say they could not be linked.

## 4. Read, join and check

Read each source in full, following \`using-external-structured-data\` for
tables, exports and API records. Then join on the keys from step 3. After the
join, count:

- rows matched in every source,
- rows found in only one source, and
- rows that matched more than one record (a fan-out that would double a total).

Fix fan-outs before summing anything. Keep unmatched rows visible rather than
dropping them; they are often the finding.

## 5. Slice and connect the way the person asked

Give the cuts the request calls for: by time, by owner, by segment, by stage.
Where two sources measure the same thing differently, show both and name the
difference in one line rather than picking one silently. Point out patterns
that only show up because sources were joined, such as deals with no contact in
thirty days, or customers whose ticket volume rose before they churned.

## 6. Deliver

Lead with the answer, then the table or views, then a short **Sources** note:
which sources you joined, on which keys, how many rows matched, and what you
could not connect. For a report people will open again, load
\`building-live-sites\`; for a chart, follow the charting guidance you have.

## In a Sidekick wizard: map the data, then plan

When you are setting up a Sidekick whose runs will produce a report, explore
before you write instructions, because each run starts cold and should not
repeat discovery.

1. **Explore the shape of all accessible data.** For every connected source
   that could bear on the report, read a sample: list its fields and types,
   its identifiers, its row count or size, its time coverage, and how it is
   paged. Include sources the person did not name if they hold the same
   entities.
2. **Map the joins.** From the samples, name each key that links two sources,
   how many sample rows actually matched on it, and which sources stand alone.
3. **Write a plan and show it to the person.** List the sources, the joins,
   the cuts and slices the report will offer, and two or three combinations
   they may not have thought of. Ask which to keep before saving.
4. **Save the plan as the run procedure.** Record the exact queries, ranges and
   tool arguments that worked, the join keys and how to normalize them, the
   output shape, and where to deliver it, so every run follows the same plan.

## Anti-patterns

- **Stopping at the first source.** One source answers part of the question.
  Search every connection before you decide the scope.
- **Joining on a guess.** A loose name match or an assumed id silently mixes
  records. Join only on a key you can name, and report the match rate.
- **Dropping what did not match.** Unmatched rows are evidence. Show them
  separately with a count.
- **Summing after a fan-out.** One deal with three contacts counts three times.
  Check for duplicate matches before every total.
- **Blocking on disagreement.** Two sources that define a measure differently
  will not agree. Report both and deliver the report.`;

export const REPORTING_ON_DATA_SKILL: HarnessSkill = {
  name: "reporting-on-data",
  description:
    "How to build a data report that connects several sources: find every related source, name the keys that join them, merge and slice the records, and say what could not be linked.",
  whenToUse:
    "When asked for a report, breakdown, analysis or combined view of data, or when setting up a Sidekick that will produce one.",
  body: REPORTING_ON_DATA_BODY,
};
