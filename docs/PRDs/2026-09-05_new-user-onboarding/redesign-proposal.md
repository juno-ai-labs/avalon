# Onboarding that teaches Rally through useful work

> Product/design proposal, 2026-09-05. Prepared by the delegated onboarding
> reviewer after inspecting the product contract, current implementation, and
> primary onboarding research. This is a proposed replacement experience, not
> a description of changes already shipped. The completed [original PRD](prd.md)
> remains historical; [new-user-onboarding.md](../../new-user-onboarding.md)
> describes the implemented flow.

The companion [implementation review](redesign-implementation-review.md) maps
this proposal to the existing authority boundaries and implementation gaps.

## Recommendation

Make the first experience a small piece of the user's real work: turn rough
context into a usable brief, then improve that same brief with one follow-up.
Teach the complete working pattern: give a concrete outcome its own work stream,
bring relevant context, explore a question in a private substream, and bring
useful conclusions back to Main where people work together.

The first wow is **“Those were my messy notes; now I have something I can use.”**
The second is **“I changed the direction and the same piece of work improved.”**
The collaborative payoff follows when a teammate contributes to that context
and the shared result changes. Substreams and multiplayer are core onboarding
concepts, including for someone who first tries Rally alone.
Animation makes those relationships legible; a successful-looking animation is
never the evidence that Rally did the work.

Keep the original requirements: creator and member paths, platform introduction,
workspace creation, connector setup, teammate invitations, server-owned personal
color/avatar, and an actual first agent loop. **Proposed sequencing change:**
move bulk connector configuration and teammate discovery/invitations after the
first useful result. Keep essential workspace creation or explicit invitation
acceptance before any workspace work. This proposal does not silently adopt that
change; the within-current-order variant below is independently buildable.

## What Rally is teaching

The [standing product contract](../2026-08-05_avalon-implementation-brief/prd.md)
defines a work stream as the durable multiplayer home of an outcome. Rally is
inherent in it. Viewing does not imply participation, and workspace membership
does not automatically share a private work stream. The product aims to bring
communication and execution together around work, with automations continuing
that pattern through their own runs.

| Teach now | Product evidence and boundary |
| --- | --- |
| Start a work stream for one outcome | Durable conversation, participants and resources already exist; unrelated work deserves a separate stream. |
| Give Rally useful context and a desired output | Ordinary runs use authorized tools and structured input; they do not know arbitrary company context merely because someone signed in. |
| Work becomes something you can use | [Agent behavior](../../agent-harness.md#behavior-policy) creates document-shaped results as published Markdown resources, with an inline fallback when the workspace is unavailable. |
| Improve the work in the same place | That policy preserves the resource on same-path revisions. An actual follow-up can demonstrate this. |
| Explore part of the same task privately | [Substream creation](../../substream-creation.md) prepares frozen starting context from Main, lets the creator review and confirm it, and opens a private idle conversation. Sending a new instruction starts its work. |
| Bring a person into that work deliberately | Explicit participant and visibility controls govern sharing. Workspace invitations and work-stream participation are different actions. |
| Connect only what the task needs | Catalog entries and grants are real; a workspace Slack installation does not imply that every personal Slack reading capability exists. |

Cover substreams and multiplayer in the introduction and practice them after
the first useful draft. Defer projects, recurring work and advanced connections
until a relevant need. Use **New work stream** for a different outcome and
**New substream** for private exploration within the current outcome.
Do not promise a remote desktop, autonomous company-wide knowledge, universal
memory across streams, or approval before every external action. The current
contract permits ordinary authorized external writes without a global approval
gate. The starter is explicitly a drafting task, not a claim about all runs.

**Separate identities visually.** The chosen color and avatar represent the
person. Label the preview **You** and carry it into their message and participant
chip. Use the consistent Rally mark for AI work. Do not animate the person's
avatar as though the user just created or customized a new bot.

## Why change the current experience

The implementation currently begins with broad promises, demonstrates a generic
tool-to-plan sequence, and then asks creators to configure tools and invite
people before receiving anything useful. Its two starter prompts explicitly ask
Rally to ask a question first. This increases the chance that the first reward
is another form of setup. This is a code-derived design concern, not an observed
conversion failure or a claim about measured abandonment.

Research supports a shorter explanation followed by contextual instruction.
NN/G recommends help alongside the relevant step rather than requiring users to
remember an upfront tour. Its study of inexperienced AI users also found that
novices lacked a clear model of capabilities; that small qualitative study is
directional evidence, not a Rally conversion benchmark.
[Contextual onboarding](https://www.nngroup.com/articles/onboarding-tutorials/),
[AI novice study](https://www.nngroup.com/articles/new-ai-users-onboarding/).

Google PAIR recommends introducing benefits and limits, supporting contained
experimentation, and explaining features when they become relevant. Applied
here, that means a concrete result and an editable next step instead of a broad
promise of AI magic.
[PAIR mental models](https://pair.withgoogle.com/guidebook-v2/chapter/mental-models/).

Notion's current first-party agent guide illustrates specific output-shaped
requests and refinement, while Slack publishes distinct guidance for creators
and members. These are useful product precedents for concrete tasks and role
branching; their documentation does not establish that their onboarding converts
better or that Rally should copy their information architecture.
[Notion agent guide](https://www.notion.com/help/guides/get-started-with-your-personal-agent-in-notion),
[Slack creator guide](https://slack.com/help/articles/217626298-Getting-started-for-workspace-creators).

The screen designs below are Rally-specific design judgments derived from that
evidence and the repository, not claims made by those sources.

## Replace the explainer slides

Use four short, user-controlled beats of **one continuous example**. Keep the
spacious Grok reference, its spring feel and gentle entrances, but let a work
stream and result carry the narrative. The demo carries a quiet **Example**
label, uses invented sample notes, and never looks like a live read of the
user's account. All essential text is visible without waiting for animation.

| Beat | Exact copy | Scene and motion | Action |
| --- | --- | --- | --- |
| 1 — Outcome | **Start with something you need done.** Supporting: **Give Rally a goal and the context. It can turn rough notes into a brief, a plan, or a useful first draft.** | A sample note card reads “Customer pilot next month · onboarding confusing · support coverage unresolved.” It settles into a composer containing “Turn these notes into a pilot brief.” Rally's mark responds; a work-stream title, “Customer pilot,” appears. | **See how it works**. Secondary **Start my first task** skips the remaining explanation. |
| 2 — Execution | **Watch the work take shape.** Supporting: **Rally works through the task here. Read the result, check its sources, and tell it what to change.** | The same stream persists. The notes move into its context area; one representative activity row leads to a real-shaped “Pilot brief” resource card. Preview shows “Goal,” “Next steps,” and “Open questions: support coverage.” A source chip points to the sample notes. No fake Google/Slack activity. | **See how we keep going**. Back available. |
| 3 — Private exploration | **Explore an idea in a substream.** Supporting: **Take part of this task into a private conversation. Review its starting context, explore with Rally, then bring back what helps.** | Under “Main log,” “Support options” appears after illustrated Review context and Create substream actions. The context card stays labeled “Starting context from Main.” The person explicitly sends “Compare support options.” They copy a conclusion into a visibly editable draft in Main and send it. No automatic merge or arrows suggesting live synchronization. | **See how we work together**. Back available. |
| 4 — Multiplayer | **Move the work forward, together.** Supporting: **Add a teammate to this work stream. Their context, your direction, and Rally's work all contribute to the same result.** | Back in Main, an explicit Add people action introduces “Sam · teammate” in this labeled Example. Sam posts “Support can cover Tuesday and Thursday.” The creator sends “Update the pilot brief with Sam's coverage and the option I brought back.” Rally updates the same brief; the changed coverage is visible. The substream remains private beneath Main. | **Start my first task**. Back available. |

The first two beats make the work concrete before the third introduces a
substream and the fourth demonstrates a human contribution. The illustrated
teammate is fictional, never a simulated live person in the user's workspace.
Main is shared only after the explicit addition; parent participation grants
no private-child access. Do not say viewing joins a stream. Keep New work stream
guidance in the hands-on conclusion so the example remains one outcome.

Reuse the audited [spring and transition vocabulary](motion-reference.md),
not the computer-demo pointer route when no computer is being demonstrated.
Replace the three-bot constellation with separate work-stream cards. Preserve
the standard spring for context-to-result motion and the bounce for the personal
avatar's arrival. Reduced motion presents each complete scene immediately.
Remove the fixed post-receipt handoff delay: opening the actual work stream is
the payoff, so decoration should not hold it back. A brief transition can overlap
the real navigation and never obscure the composer.

## Make privacy visible at the decision

Privacy is part of the core explanation and each consequential action, rather
than an extra policy slide. Teach two separate things: who in the workspace can
see the work, and what connected services Rally can use. Private conversation
access is not a promise of local-only processing or end-to-end encryption.

In the continuous example, show **Private work stream** before the first task,
**Private substream** during exploration, and the actual audience changing when
the person adds Sam to Main. The substream's audience does not change with it.
Make audience labels accessible in text; a lock icon or avatar pile alone is not
an explanation. Details should be available without interrupting the task.

| Moment | Proposed concise copy | Required meaning |
| --- | --- | --- |
| Before the first Send | **This work stream starts private. Other workspace members won't see it unless you share it.** | This applies to the personal starter, not every project or workspace-scoped stream. Use actual scope and audience in subsequent screens. |
| Create a substream | **This conversation starts private to you. People in Main aren't added automatically.** | Review the frozen starting context; parent membership does not grant child access. |
| Return a finding to Main | **What you post here will be visible to people who can access Main.** | Show the actual destination audience next to the editable draft. Returning alone shares nothing; posting the selected text shares that text. |
| Add a teammate | **[Name] will be able to see this work stream's shared history and results. Your private substream stays private.** | Explain actual access before the ordinary explicit add action. Do not imply they see only future messages or private child content. |
| Invite to workspace | **Invite them to the workspace. Your private first task isn't shared by this invitation.** | Workspace acceptance and work-stream access are separate. Workspace-visible content follows ordinary scope rules. |
| Connect for me | **Rally can use this connection for your work. Joining a work stream doesn't give others your connection.** | Personal connector ownership stays personal. Information returned into a shared conversation may be visible to its audience. |
| Connect for workspace | **This gives Rally the selected tool access for work across this workspace.** | Workspace connections are organization capabilities, not equivalent to personal connections. Show actual scopes and provider account before OAuth. |
| Bring source material into shared work | **Check the audience before adding sensitive context.** | Connector authorization is not a guarantee that derived text will stay private once intentionally posted or used in shared work. |

These meanings follow [connector access](../../connectors.md) and
[substream access](../../substream-creation.md). The shared parent sidebar's
people controls manage the work stream, even while a child is selected. Keep
**Private substream** visible in the conversation so parent avatars cannot be
mistaken for the people reading it. Do not imply that all resources visible in
the parent sidebar are private child outputs.

Provide a secondary **How Rally handles your data** link using verified current
product disclosures. It must distinguish processing by Rally/model providers,
retention, regional handling and any training commitments from in-product
visibility. This design makes no new claims about those policies: do not write
“only you can access your data,” “never leaves your device,” “never used for
training,” or “everything stays in your region” without the applicable verified
policy and implementation. Region selection alone is not that evidence.

Privacy acceptance uses two real accounts: confirm the starter and private child
are not discoverable by the other member, explicitly share Main and verify its
history/results become accessible, verify the child remains inaccessible, then
post one reviewed child conclusion to Main and verify only that intentionally
shared content appears. Check connector scope copy against actual grants. No
privacy success state may be inferred merely from the presence of a lock icon.

## Recommended complete journey

### Entry and choosing a task

After the explanation, complete workspace discovery. For creators show
**Where will your team work?** with workspace name, region and the existing
plain-language residency explanation. Primary: **Create workspace**.
For invited users show **Join [workspace name]** with inviter, account and explicit
**Accept invitation**. Existing members use **Continue in [workspace name]** when
a workspace choice is necessary. A pending invite grants no content access;
expired/revoked invitations return to the ordinary recovery path.

Once inside a workspace, show **What would be useful to finish first?**
Supporting: **Bring something small from your day. You'll keep the result and
can build on it.** This is task selection, not a role/industry survey.

| Choice | Helper | Required input | Output |
| --- | --- | --- | --- |
| **Turn notes into a brief** — default emphasis | **A clear summary, next steps, and the decisions still open.** | Paste relevant rough notes; optionally name the intended audience. | A concise working brief. |
| **Prepare for a conversation** | **An agenda and the questions worth asking.** | Meeting purpose plus known context; select an accessible event only when calendar access exists. | Meeting prep brief without invented attendee history. |
| **Make a practical plan** | **Milestones, dependencies, and a first action.** | A goal; optional deadline or constraints. | A draft plan with unknowns separated from facts. |
| **Use my own task** | **Tell Rally the outcome you want.** | Freeform ordinary request. | Ordinary agent behavior; no promise of a document when another output fits. |

Cards choose a template and focus its input; they never send. Every template
remains editable. An empty editor says **Paste a few notes or describe your goal**.
Secondary **Try sample notes** inserts clearly labeled fictional notes, keeps
them editable, and still executes a real agent run only after Send. Track a
sample separately from a user's own work; a sample result demonstrates capability
but cannot establish personal activation.

### Context, connections, and personal identity

Use one context area alongside the chosen task. Default **Paste notes**; show
**Add a file** only through the ordinary supported upload flow. Offer **Use a
connected source** when a usable, authorized source exists. For creators,
**Connect a tool for this task** reveals relevant actual provider cards, with
**Browse all tools** available. State the benefit before OAuth, for example
**Use a Drive document as context for this brief.** Keep the actual grant/scope
description truthful: a drafting starter does not make a broad OAuth grant
read-only. One successful connection is enough; a failed connection leaves the
notes path available.

Member onboarding skips workspace connector setup. It can use existing sources
the initiating person is authorized to use, or pasted notes. Missing personal
access must never borrow the inviter's private connection. Additional personal
connection setup remains an optional ordinary product action after first use.

Retain the requested personal setup before the first run, but make it brief:
**This is you in Rally.** Supporting: **Choose your avatar and color. Your team
will see them, and they'll follow you across devices.** Initialize valid defaults.
Primary **Continue with this look** saves them. Keep both avatar and app-shell
preview labeled **You**. Do not force a changed selection or imply it teaches
the AI the person's personality. Preserve the task draft during this step.

### The first real run

Return to a populated ordinary composer under **Let's make something useful.**
Supporting: **Your first work stream starts privately. You can add people later.**
Show the selected context and request for review. Primary **Create my brief**,
**Prepare my meeting**, or **Make my plan** according to the chosen task; custom
tasks use **Send to Rally**. Secondary **Explore Rally** remains available.

Default notes-to-brief request, fully visible and editable:

> Turn these notes into a concise working brief for [audience, if supplied].
> Include the goal, what we know, proposed next steps, and open decisions.
> Use the supplied notes as the source. Mark assumptions and unknown owners or
> dates clearly. Give me a useful first draft now; ask a question only if you
> cannot proceed without the answer. Keep this as a draft here in Rally.
>
> Notes: [the person's supplied text]

This replaces “ask me what you need to know first.” It does not forbid necessary
elicitation and does not invent facts to avoid a question. The existing document
policy supplies the generated-resource behavior. No hidden prompt sends messages,
creates calendar events, or changes source documents during the demonstration.

On receipt, open the actual work stream immediately. Its real transcript and
activity rows show progress. One unobtrusive line by the composer says
**You can add context or change direction while Rally works.** Never fake a
progress percentage, tool sequence, estimated finish time, or prewritten answer.
When a question is necessary, show **Rally needs this to continue** beside the
normal structured input. The guidance must not compete with answering it.

When a published resource arrives, present the normal resource card and preview.
Guide: **Here's your first draft. What would make it more useful?** The best
first follow-up is chosen from what the user wanted, with static safe fallbacks:
**Make it shorter**, **Add risks and open questions**, **Change the audience**.
Selecting a suggestion fills the ordinary composer and focuses it; it does not
send. A targeted revision should update the same document where normal policy
supports it. Keep the original task visible in the sidebar and preserve history.

If publishing is unavailable but a substantive inline draft is returned, show
**Your draft is here in the conversation**. Do not render a fictional file or
announce a saved document. The user can still refine the result. If the model
only asks a question, says it will start, or fails, do not show the first-result
celebration just because a run has the status `completed`.

### Explore a private substream — both paths

After the first useful draft and refinement, guide **Try an idea without changing
the main conversation.** Supporting: **Create a private substream for one
question about this work. You'll choose what to bring back.** Primary **Explore
an option** opens the ordinary **New substream** flow; **I'll try this later**
retains the exercise without blocking work.

For the sample suggest **Support options**; otherwise use the editable neutral
title **Explore an alternative**. Follow the actual creation lifecycle:

1. The person selects **Review context**. Show the actual read-only prepared
   summary of completed Main context. Explain **This is the starting context.
   Later messages in Main won't update it automatically.** Cancellation
   publishes nothing; no editable context or strategy picker is invented.
2. The person selects **Create substream**, confirming that exact preparation.
   The creator-only child opens idle. Guide **Your private conversation is
   ready. Send Rally the question you want to explore.** Creating it sends no
   instruction and copies no running work.
3. Offer the editable request **Compare two approaches to this plan. Describe
   the tradeoffs and recommend what to bring back to Main. Reply here; keep
   the main brief unchanged.** Nothing executes until the person selects Send.
   The answer comes from the real child agent loop.
4. Guide **Choose what to bring back.** The person reviews and copies a useful
   conclusion, selects **Main log**, and pastes an editable summary into the
   normal composer. Suggested wrapper: **I explored an alternative. Here's
   the conclusion I want to use: [reviewed summary]. Update our brief with
   this direction.** Sending is explicit. No automatic private-text transfer,
   merge command, or live context synchronization is promised.
5. The real Main run updates the brief. The work stream stayed the same while
   the conversations differed. Returning to Main does not publish child messages.

The parent sidebar's artifact inventory and people controls still belong to the
whole work stream while a child is selected. Onboarding must not imply that
adding someone through those controls grants private-child access, or that all
artifacts in parent chrome were created privately. Main holds shared decisions;
substreams support private exploration of the same outcome. An unrelated
outcome belongs in a new work stream.

Preparation failure preserves the ordinary retry/cancel operation; no fallback
substitutes a different context. A lost confirmation resumes the same child.
Provider failure cannot discard the useful first brief or block ordinary Main
work. Record the exercise as explained, tried, or deferred; skipping is never
reported as successful private exploration.

### Work with a teammate — both paths

Guide **Bring someone into this work.** Supporting: **Add a teammate to the
work stream, then ask for the context or decision that would improve this
draft.** When eligible workspace members exist, **Add a teammate** opens the
ordinary parent participant picker with its access explanation. Nobody is
preselected or automatically added. Existing participation is respected.

After explicit addition, suggest an editable Main message **What would you
change before we use this brief?** The person chooses whom to address and sends
through normal controls. When a real response arrives, **Use their input** fills
the composer with **Update the brief using the feedback above. Keep unresolved
disagreements visible.** The user sends; the subsequent real run demonstrates
people and Rally changing the same deliverable. Do not promise every human
message automatically triggers a revision.

Waiting for another person is never a completion gate. **Keep working on my own**
retains the collaboration opportunity. The explainer teaches the whole loop;
the real workspace shows only actual membership, presence and contributions.
No fake typing, invented teammates or manufactured replies. An explicit
addition and an actual teammate contribution are separate outcomes.

### Workspace invitations after value — creator path

When the needed teammate is not a workspace member, offer **Who could help move
this forward?** Supporting: **Invite your teammates to the workspace. Add people
to this work stream when you're ready to share its context and results.**

Primary choices are **Invite teammates** and **Keep working**. Manual email entry
is immediately available. **Find people from shared meetings** expands the
existing Google discovery UI, explains the actual calendar/date-range signal,
and never describes it as a judgment of closeness. Leave all candidates
unselected; review exact recipients and Member role before **Invite N people**.
Preserve the existing pagination and partial-evidence labels. Slack ranking is
future work, not a promised feature in this proposal.

Do not couple the invite action to sharing the private starter. When a member
exists, the normal **Add people** control can add that person to the stream with
the ordinary visible access explanation. Pending invitees remain pending until
acceptance; do not imply they've seen the draft. A larger connector catalog can
live here as **Bring in more of your work**, alongside ordinary Settings.

### Member path and continuation

Members arrive through intro → accepted/active workspace → useful task → context
→ appearance → first private work stream → refinement → private-substream
exercise and reviewed Main return → multiplayer practice. They are never asked to
administer an existing workspace. After a useful result, contextual guidance can
offer **Add a teammate** through ordinary authorized controls or **Back to
[workspace name]**. If entry carried an authorized destination stream, retain
**Return to the work you were invited to**; do not let generic onboarding lose
that intent or automatically post the tutorial into someone else's work.

The concluding nudge is **Keep shared decisions in Main. Explore a question
privately in a substream and bring back what helps. Start a new work stream for
a different outcome.** No checklist blocks normal use.
An optional **Finish workspace setup** entry retains deferred creator tasks.
Introduce recurring work only when the person expresses a repeated need, through
the existing automation authoring flow; do not turn one successful task into an
automatic schedule.

## Variant that preserves the originally requested order

If the original setup order remains fixed, use the new four beats and keep:

**Creator:** intro → workspace → connectors → invites → appearance → real task.

**Member:** intro → explicit acceptance/active workspace → appearance → real task.

Both continue through refinement → private-substream exercise and reviewed
Main return → multiplayer practice, with explicit defer options. These learning
steps are core even when creator setup stays in its original position.

Improve creator setup without changing the state graph: connector heading
**Bring context for your first task**, emphasize one relevant connection, keep
**Use notes for now** as a direct continue action; invitation heading
**Who will work here with you?**, show manual entry first and calendar discovery
on demand, with **Invite later** equally legible. Use the same task templates,
visible artifact-first request, immediate handoff, and refinement guidance above.
This is safer to adopt incrementally but retains setup before value. Do not
present it as equivalent to the recommended after-value invitation sequence.

## Recovery and interaction requirements

| Condition | Behavior and copy |
| --- | --- |
| OAuth cancelled | **Connection wasn't finished. Try again or use notes for this task.** Keep successful connections and the draft. |
| Source unavailable | **Rally couldn't read this source. Choose another source or paste the relevant context.** Never manufacture its contents. |
| Offline | **You're offline. Your draft is still here.** Show only if the draft has actually been retained; sending waits for a connection. |
| Run failed | **Rally couldn't finish this attempt. Your task and context are still here.** Use normal retry/steer controls and retain one starter stream. |
| Unusable answer | Offer **Tell Rally what's missing** and focus the composer. Do not blame the user's prompt or force a tutorial restart. |
| Lost response/relaunch | Reconcile the durable receipt, same stream, chosen task and exact context. No duplicate invitation, stream or prompt. |
| Invitation partly failed | Keep successes and list failed recipients for selective retry; finishing a tutorial never requires mail delivery. |
| Competing session | Read server revisions and latest progression; do not overwrite a newer appearance or restart setup because a stale window reopened. |
| Reduced motion or keyboard use | Complete static scenes, descriptive labels, stable focus, and visible skip/back. Actions never wait for scene completion. |

Task/context drafts must survive the recommended new intervening screens. Today
the starter only persists after submission and unsent invitations are local;
durable draft resumption is a build requirement, not existing behavior. Store
workspace task content within its region, never in the Global identity profile.

## Success and acceptance

Judge onboarding by useful work and a correct mental model, not setup completion.
These are proposed evaluation definitions, not claims that instrumentation
already exists or targets already agreed with the team.

| Signal | What it establishes | What it does not establish |
| --- | --- | --- |
| First run admitted | The request reached execution | A useful result |
| First generated resource available | A real persistent output exists | Quality, usefulness, or correct sources |
| Substantive result reviewed and user selects **This is useful** | Explicit reported first value; optional feedback | Independent factual correctness |
| User sends a targeted follow-up in the same stream | The person tried steering the work | That the revision succeeded |
| Revision succeeds and preserves the resource identity where applicable | The continuation loop worked | Long-term retention |
| Creator reviews context, confirms one child, then explicitly sends its first instruction | The real private-substream lifecycle was practiced | Live context updates or shared child access |
| Person reviews and sends a child conclusion back in Main | Deliberate private-to-shared communication occurred | An automatic merge or all child content being shared |
| A teammate explicitly joins and contributes | Collaborative use occurred | A prerequisite for an individual's first success |
| User returns to continue or starts another concrete outcome | Behavior consistent with Rally's model | Causal proof onboarding produced retention |

For release QA, run the default personal-notes task with configured inference,
verify a useful brief grounded in those notes, open its published resource, and
revise that same resource. Then prepare/review/confirm a private child, verify it
remains idle before Send, run its question, and manually bring a reviewed
conclusion back to Main. With a second real test user, explicitly add them to
the parent, verify they cannot enumerate/read the private child, post a real
Main contribution, and revise the shared result from it. Test solo continuation
and the inline fallback independently. Inspect
real elapsed time to useful output and where people leave, but set no invented
universal time promise or conversion percentage. Qualitative review asks users
to explain when to choose a new work stream versus a substream, which context
is frozen, how to bring a private conclusion into Main, how people contribute,
and what adding someone shares. A clicked Next is not evidence they
understood those things.

Acceptance must cover both paths; explicit pending-invitation acceptance;
connector-free real work; no auto-sent invitations; correct personal versus
Rally identity; successful and failed agent runs; one-stream replay; accessible
short/light/dark/reduced-motion windows; and preserved region/scope boundaries.
Any new analytics follow the repository's governed regional telemetry path and
exclude notes, prompts, addresses, resource contents, and interaction evidence.

## Adoption and remaining implementation choices

No feature flag: preserve the user's explicit direct-to-new-users decision.
Existing users remain exempt. Server compatibility must precede a desktop
release that depends on new journey states or draft persistence.

Adopting the recommended sequence requires a new journey graph, deferred-setup
state, and task/context draft persistence; the current completed PRD should not
be rewritten to pretend it always specified that. Carry the adopted behavior in
a new implementation PRD and update the owning module document with code.
The explainer copy, identity distinction, useful starter requests, and immediate
handoff can be built without claiming the larger sequence already changed.

The central product choice is whether to retain invites before first work or
move them after value as recommended. The quality boundary is non-negotiable:
verify a real useful result and a real revision before declaring the wow moment
implemented. A new set of attractive slides alone does not meet this proposal.
