/**
 * The custom-tool paragraph of the wizard's guide, rendered only where a
 * program runtime exists; without one the test tool is absent too.
 */
export const CUSTOM_TOOLS_GUIDE = `# Save the tested method as a tool
When the tested method is work every run repeats, save it as a custom tool, so a run
does the routine part in one call rather than over many turns. Every turn re-reads the
whole conversation, so a procedure split across small tools costs a turn per step and
grows dearer as the run goes on. Prefer one tool that runs the whole repeated
procedure end to end: the reads, every page, the loop over items, the dedupe, the date
bounds, the arithmetic, and the writes to the Sidekick's own tables that record
progress. Add another tool only where the run must judge something between two steps
that code cannot decide, and keep the set under five.
Declare its input, write the program against the tools you used (the API code_execute
shows), test it with sidekick_tool_test on representative input, and tell runs in the
instructions to call custom_<name> first, what to do with what it returns, and what to
do when it fails. Read each tool's real output once before the program parses it:
inside a program a call returns the \`data\` of a direct result with no success/data
wrapper, and current_time, for one, returns text lines, not an object.
The tool returns what the run reports and decides with, compactly: totals and the facts
to report, not the raw rows it read. It does not stop for one item that fails or does
not fit the rule: it finishes the rest and lists each such item under exceptions, with
its identifier, what was wrong and what is known, for the run to handle. An item is an
exception only when code cannot decide it: each read returns every fact the next step
needs (the values, not only a count or a yes), and any list the decision checks items
against is read once per call, so the tool classifies every item itself.
It throws only when it cannot do the job at all. A program has a time limit; when the
work can outgrow it, the tool does a bounded share, records where it stopped in the Sidekick's own
table, and returns what remains, and the instructions call it again until nothing
remains. Size the share by time, never a fixed count: msLeft() in the program returns
the milliseconds left before its deadline, and the tool keeps taking groups while
msLeft() is more than its slowest group has taken, with room for its last write, or
until no work is left. Use msLeft() only for that decision, never as data to write. A
page is not a share: when one page of items is done and time remains, it reads the
next page. After each group it records that group's finished items with one write (one
update_rows for a table), so a call that overruns loses at most the group in flight. When a write is
refused, it lists the row the error names under exceptions and writes the rest, so one
bad item never stalls the share. Items it did not reach stay pending for the next call;
a tool that claims items claims only the group about to be read, and takes each row's
new revision from the claim write's result, not a re-read. A check the instructions have
a run make by hand, such as a re-read after each write, does not carry into the code. Independent calls may run side by side in Promise.all, writes included;
read a group together, then write it.
Tune by measurement, not by guess. The one measure is finished items per call: the
more each call finishes, the fewer calls and turns a run needs. Four things raise it,
in this order. Fewer requests per item: look first for a source that answers for many
items in one request (an index, a log or a table that spans them) before reading each
item where it lives; otherwise one read that covers a group of items where the source
allows it, rather than one per item; and no read the program already has the answer
to. More results per request: where a read takes a page size, limit or batch size, use
the largest the source accepts that does not slow the call or fail. More requests at
once. And the whole time budget used, never a fixed count or a single page.
Have the tool return how many items it finished, the requests it made (its tool calls,
reads and writes), the seconds it took and the errors it met, and take the page size,
concurrency and group size as inputs while you tune. Run sidekick_tool_test on a
representative share of real items, enough that the time budget, not the work, ends
the call. Raise the page size to the source's documented maximum, or double it while
items per call keep rising. Then start at 4 at once and double (8, 16, 32 and on) while
items per call keep rising and no errors or failed reads appear. Keep the last setting
of each that raised it, then fix them in the tool. A limit a person asked for, or a
source's documented limit, caps a setting; a number an earlier revision wrote without
a measurement is a guess to re-measure, not a limit. Write the measured numbers (items
per call, requests per item, results per request, seconds, errors at each setting) and
the chosen settings in the instructions. When
no real items exist yet, time a few scratch items instead; never hold up setup to ask
for data to time.
Calling it again after a failure or a partial call is safe: it skips work it already
recorded. What it records is the facts it found, not only that an item is
done, and it returns every recorded fact and exception the run has not yet marked
delivered, so a call that timed out after its writes loses nothing. The run marks them
delivered only after posting succeeds, with a second tool that takes what it marks as
input.
The run keeps what needs judgement: whether and what to post and how to word it, what
an exception means and what to do about it, and anything the instructions leave to a
person. Posting and messages to people stay out of the tool; the run delivers what the
tool returned. A tool has one entry point, never a mode, action, dryRun or preview
input that makes the run pick a path. It may read current_time to work out which dates
or items the work covers, never to decide whether to do the work: a time-of-day or
day-of-week gate belongs in the trigger and the instructions, and the tool does its
job whenever it is called.
A tool takes the IDs of the Sidekick's tables it reads or writes as input, never fixed
in its code or found by name, and the instructions pass the real ones. A test performs
its writes: test a writing tool against scratch tables with the same columns, passed as
its input, or accept the test's row. Name each scratch table after its real table with
" (test)" appended, never the real name, which reopens the live table; reuse it on
later tests, and invalidate the rows a test wrote once you have read its result. Every connector plugin a tool calls goes in recommendedPlugins.
A changed tool is tested again before it is saved. A test that returns warnings is not
done: fix what each names and test again, or say why it does not apply.
In a self-review, tools change with the procedure, using only plugins already
recommended. The plan takes each deterministic step the report says a run repeated,
skipped or got wrong (a dedupe after the reads, a page not followed, date bounds, a
union, a count) and says whether it moves into the tool or why it stays in the
instructions; a plan that leaves that unanswered is incomplete. It also uses the
report's cost figures. A run that spent many turns on routine steps is the case for
moving them into the tool; one whose tool call finished fewer items than the measured
settings in its instructions, returned exceptions code could have settled, or timed its
share against a fixed number instead of msLeft() is the case for re-tuning the tool as
above and timing it again. A tuned tool that still needs several calls for a large job
stays as it is. Tools the runs always call one after another become one. "The instructions already say so" is not a
reason a step stays: an instruction the run did not follow is the case for code the
run calls, unless the run shows the step failed on something outside it (a timed-out
read) rather than being done by hand or skipped. A tool the runs misused or no longer
need is rewritten or removed along with the instructions that call it. A tool is part
of the procedure, not a new capability.
Nobody is present during a review, so it tests a writing tool only against scratch
tables passed as its input, never by accepting a row in a table the runs read. A tool
with a table ID fixed in its code is rewritten to take the ID as input when the
review changes it; a writing tool it still cannot test that way it leaves as it is
and reports.`;
