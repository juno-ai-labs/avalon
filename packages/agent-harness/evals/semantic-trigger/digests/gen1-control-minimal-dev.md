## Candidate gen1-control-minimal (generation 1), on the development split

Three-class accuracy 75.3% (55/73). Admit-decision accuracy 86.3%. Hard-case accuracy 76.8%.
Mean confidence when right 0.833, when wrong 0.544.

### Confusion
- not_met->not_met: 27
- met->met: 25
- not_judgeable->not_met: 7
- not_met->met: 5
- met->not_met: 5
- not_judgeable->not_judgeable: 3
- not_met->not_judgeable: 1

### Per class
- met: support 30, correct 25, predicted 30
- not_met: support 33, correct 27, predicted 39
- not_judgeable: support 10, correct 3, predicted 4

### Failures by family
- untestable: 7 wrong of 10
- near_miss: 4 wrong of 6
- unstated_but_true: 2 wrong of 14
- easy_met: 2 wrong of 10
- negated_condition: 1 wrong of 9
- wrong_field: 1 wrong of 4
- inference_needed: 1 wrong of 4
- topical_trap: 0 wrong of 4
- injection: 0 wrong of 4
- partial_clauses: 0 wrong of 6
- easy_not_met: 0 wrong of 2

### 12 failing cases, spanning every error class

#### eng-023 — truth `not_met`, judged `met` at confidence 0.96 (family `near_miss`, hard)
- condition: "an issue is created about the data pipeline"
- connector / event_type: linear / linear.issue.create
- title: "ENG-2866: Deploy pipeline stuck on the smoke-test stage"
- summary: "Marcus Feld created ENG-2866 in team Platform. Status: Todo."
- text_snippet: "The Cloudflare deploy pipeline for apps/web has been sitting on `smoke-test` for 40 minutes on the last two runs. The stage waits on a health check against the preview URL that never comes up. Nothing to do with the warehouse jobs — this is the web deploy only."
- why the corpus says `not_met`: Nearest label is condition_met because 'pipeline' is in the title and body. It loses because the pipeline named is the web deploy pipeline, and the body rules out the warehouse jobs, so the subject is not the data pipeline.

#### meet-007 — truth `not_judgeable`, judged `not_met` at confidence 0.94 (family `untestable`, hard)
- condition: "northwind is going to sign this quarter"
- connector / event_type: fireflies / fireflies.meeting.summarized
- title: "Northwind Logistics <> Lattice Harbor: proposal review"
- summary: "Carla Mendes reviewed the proposal with Priya Raman and said she intends to take it to her CFO next week with a recommendation to proceed. Open items: SSO timeline and a Q4 start date."
- text_snippet: "Participants: Carla Mendes (Northwind), Priya Raman\n\nKey points\n- Carla: 'I'm recommending this. Whether it lands this quarter depends on the CFO's calendar'\n- Q4 start is Carla's preference, not confirmed\n\nAction items\n- Priya: send redlined MSA\n- Carla: CFO review next week"
- why the corpus says `not_judgeable`: The condition asks about a future outcome, and no meeting record can settle whether a contract will be signed later; the most a meeting can carry is intent. condition_met is the tempting reading because Carla is recommending the deal, but a recommendation is not the signing the condition names, and no other event of this kind could carry it either.

#### comms-039 — truth `met`, judged `not_met` at confidence 0.58 (family `easy_met`, easy)
- condition: "a customer call gets cancelled"
- connector / event_type: google / calendar.event.cancelled
- title: "Brightwater Foods — Q3 business review"
- summary: "Ines Ferreira cancelled the event scheduled for Mon Sep 21, 13:00 PT."
- text_snippet: "Cancelled.\nGuests: ines, marcus, k.adeyemi@brightwaterfoods.example, j.lund@brightwaterfoods.example"
- why the corpus says `met`: condition_not_met would need this to be an internal meeting; it loses because the event is a business review with two Brightwater attendees and the summary says it was cancelled.

#### comms-040 — truth `not_met`, judged `not_judgeable` at confidence 0.27 (family `inference_needed`, hard)
- condition: "a meeting with more than 8 attendees is added to my calendar"
- connector / event_type: google / calendar.event.created
- title: "Ledgerline all-hands — September"
- summary: "Sam Achterberg invited you to a meeting on Fri Sep 25, 09:00–09:45 PT."
- text_snippet: "Guests: engineering@ledgerline.example, gtm@ledgerline.example, sam@ledgerline.example\nAgenda: Q4 priorities, Pricing 2.0 update, security review status"
- why the corpus says `not_met`: condition_met is tempting because an all-hands is surely more than eight people; it loses because the event lists three guest entries, two of them group aliases whose membership it does not state, so the count over 8 is an inference and not a fact of the event.

#### meet-032 — truth `not_met`, judged `met` at confidence 0.96 (family `near_miss`, hard)
- condition: "a design candidate reached the onsite stage"
- connector / event_type: ashby / candidateStageChange
- title: "Stage change: Kenji Oyelaran → Onsite"
- summary: "Kenji Oyelaran moved from Take-home exercise to Onsite for Senior Backend Engineer."
- text_snippet: "Job: Senior Backend Engineer\nFrom: Take-home exercise\nTo: Onsite\nInterviewers: Jae Park, Dana Whitfield (design collaboration round), Marcus Lee\nNote from Jae: take-home was clean, worth the full loop."
- why the corpus says `not_met`: The stage is exactly Onsite and the Head of Design is on the panel, but the candidate is in the engineering pipeline and the condition names a design candidate. condition_met loses because the subject is the wrong requisition, however right the stage.

#### eng-019 — truth `not_judgeable`, judged `not_met` at confidence 0.69 (family `untestable`, easy)
- condition: "post the release notes to #eng-releases in slack"
- connector / event_type: github / github.release.published
- title: "corvid-hq/mobile: android-v3.8.0"
- summary: "Devin Ashby published release android-v3.8.0 in corvid-hq/mobile."
- text_snippet: "Offline job notes, faster photo uploads on cellular, bug fixes."
- why the corpus says `not_judgeable`: Nearest label is condition_met because a release with notes did happen. It loses because the text is an instruction for what to do, not a test of the event; there is nothing in it for the event to satisfy.

#### eng-030 — truth `met`, judged `not_met` at confidence 0.51 (family `unstated_but_true`, hard)
- condition: "a postmortem document is created"
- connector / event_type: linear / linear.document.create
- title: "2026-09-11 invoice PDF 5xx"
- summary: "Ingrid Sørensen created a document in project Checkout v2."
- text_snippet: "## Impact\n3.4% of `/invoices/:id/pdf` requests returned 502 between 14:07 and 15:22 UTC. 41 workspaces affected.\n\n## Timeline\n- 14:07 #4128 deployed\n- 14:19 alert `pdf_5xx_rate` fired\n- 15:22 revert deployed\n\n## What went wrong\nweasyprint's font cache is not isolate-safe.\n\n## Action items\n- [ ] Re-land behind ff_pdf_renderer_v2 (Ingrid)\n- [ ] Add pdf render to the canary suite (Marcus)"
- why the corpus says `met`: Nearest label is condition_not_met because neither the title nor the summary calls it a postmortem. It loses because the body is an incident write-up with impact, timeline, cause and action items for a past outage, which is what a postmortem is.

#### meet-015 — truth `not_met`, judged `met` at confidence 0.79 (family `near_miss`, hard)
- condition: "notes from a call with a design candidate"
- connector / event_type: granola / note.generated
- title: "Design pipeline — Elena"
- summary: "Weekly recruiting sync on the Senior Product Designer search: three candidates in process, Simone Achebe at final portfolio review, Ruth Lindqvist at phone screen."
- text_snippet: "- Simone: Dana wants one more portfolio convo, Elena booking\n- Ruth Lindqvist: phone screen Thu, came via LinkedIn\n- Bea Castellanos: withdrew, took an offer elsewhere\n- Elena thinks we should reopen the JD to remote, not sure\n- todo: ask Dana if she'd interview Ruth herself"
- why the corpus says `not_met`: Three design candidates are named and discussed, but the call is a recruiter sync between two employees; no candidate was on it. condition_met loses because the condition asks for a call with a candidate, and this is a call about them.

#### comms-029 — truth `not_judgeable`, judged `not_met` at confidence 0.49 (family `untestable`, hard)
- condition: "the page was edited by mistake"
- connector / event_type: notion / notion.page.content_updated
- title: "Onboarding Revamp — PRD"
- summary: "Sam Achterberg edited Onboarding Revamp — PRD."
- text_snippet: "## Goals\n- time to first synced invoice under 10 min (was 25)\n- 60% of new workspaces connect a bank in week 1\n- drop 'invite your accountant' from v1"
- why the corpus says `not_judgeable`: condition_not_met is where a reader lands because the edit looks deliberate; it loses because the editor's intent is not something any page-edit event carries — the condition asks about a state of mind, so no event of this kind could ever affirm it.

#### eng-032 — truth `met`, judged `not_met` at confidence 0.51 (family `negated_condition`, hard)
- condition: "an issue is deleted and it wasnt a duplicate"
- connector / event_type: linear / linear.issue.remove
- title: "GRO-91: Referral banner copy test"
- summary: "Noor Haddad deleted GRO-91 from team Growth."
- text_snippet: "Filed against the wrong team by mistake — moved over to Mobile as MOB-433."
- why the corpus says `met`: Nearest label is condition_not_met because a second key (MOB-433) exists for the same work. It loses because the stated reason is a wrong-team filing that was moved, not a duplicate of pre-existing work; there is one issue, relocated.

#### meet-020 — truth `not_met`, judged `met` at confidence 0.47 (family `wrong_field`, hard)
- condition: "a meeting i had with marcus"
- connector / event_type: granola / note.edited
- title: "1:1 — Jae"
- summary: "Weekly 1:1 with Jae. Hiring loop for Senior Backend is too long; Marcus wants it cut to three rounds."
- text_snippet: "- Jae says Marcus wants the eng loop down to 3 rounds, take-home optional\n- Marcus also asked Jae why Theo hasn't got a take-home yet\n- Jae worried about on-call load if we don't hire by Nov\n- (edited: added) Marcus is out next week, so decide the loop change without him"
- why the corpus says `not_met`: Marcus is mentioned in every line, but always as someone Jae is reporting on, and the edit even notes Marcus is away; the meeting was with Jae. condition_met loses because the condition asks who the meeting was with, not who was talked about.

#### meet-027 — truth `not_judgeable`, judged `not_met` at confidence 0.45 (family `untestable`, easy)
- condition: "the customer is happy with how the call went"
- connector / event_type: granola / note.edited
- title: "Oakridge — Ben, bulk approvals timeline"
- summary: "Gave Ben the end-of-quarter date for bulk approvals. He took it without pushing back."
- text_snippet: "- end of quarter for bulk approvals, Ben said 'ok'\n- (edited) actually he said 'ok, but that's the last slip' — adding for the record\n- Sam to send written timeline"
- why the corpus says `not_judgeable`: How a customer feels is not something a note can carry; it holds what he said and the writer's read of it, and a different note could not carry his feeling either. condition_not_met is the nearest reading given the 'last slip' edit, but that is still an inference about a state of mind the event cannot report.
