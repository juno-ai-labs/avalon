## Candidate gen0-baseline (generation 0), on the development split

Three-class accuracy 80.8% (59/73). Admit-decision accuracy 89.0%. Hard-case accuracy 82.1%.
Mean confidence when right 0.745, when wrong 0.534.

### Confusion
- not_met->not_met: 30
- met->met: 24
- not_judgeable->not_judgeable: 5
- not_judgeable->not_met: 5
- met->not_met: 5
- not_met->met: 3
- not_met->not_judgeable: 1

### Per class
- met: support 29, correct 24, predicted 27
- not_met: support 34, correct 30, predicted 40
- not_judgeable: support 10, correct 5, predicted 6

### Failures by family
- untestable: 5 wrong of 10
- near_miss: 3 wrong of 6
- unstated_but_true: 3 wrong of 14
- easy_met: 1 wrong of 10
- negated_condition: 1 wrong of 9
- inference_needed: 1 wrong of 4
- topical_trap: 0 wrong of 4
- injection: 0 wrong of 4
- partial_clauses: 0 wrong of 6
- wrong_field: 0 wrong of 4
- easy_not_met: 0 wrong of 2

### 12 failing cases, spanning every error class

#### meet-007 — truth `not_judgeable`, judged `not_met` at confidence 0.66 (family `untestable`, hard)
- condition: "northwind is going to sign this quarter"
- connector / event_type: fireflies / fireflies.meeting.summarized
- title: "Northwind Logistics <> Lattice Harbor: proposal review"
- summary: "Carla Mendes reviewed the proposal with Priya Raman and said she intends to take it to her CFO next week with a recommendation to proceed. Open items: SSO timeline and a Q4 start date."
- text_snippet: "Participants: Carla Mendes (Northwind), Priya Raman\n\nKey points\n- Carla: 'I'm recommending this. Whether it lands this quarter depends on the CFO's calendar'\n- Q4 start is Carla's preference, not confirmed\n\nAction items\n- Priya: send redlined MSA\n- Carla: CFO review next week"
- why the corpus says `not_judgeable`: The condition asks about a future outcome, and no meeting record can settle whether a contract will be signed later; the most a meeting can carry is intent. condition_met is the tempting reading because Carla is recommending the deal, but a recommendation is not the signing the condition names, and no other event of this kind could carry it either.

#### meet-031 — truth `met`, judged `not_met` at confidence 0.80 (family `unstated_but_true`, hard)
- condition: "referred candidate for the engineering role"
- connector / event_type: ashby / applicationSubmit
- title: "New application: Theo Marchetti — Senior Backend Engineer"
- summary: "Theo Marchetti submitted an application for Senior Backend Engineer via the careers page."
- text_snippet: "Job: Senior Backend Engineer (Denver, hybrid)\nSource: Careers page\nCurrent: Staff Engineer, Kestrel Systems\nCover letter: Jae Park and I worked together at Kestrel for three years; he suggested I apply and said he'd put my name forward internally. I've spent most of that time on the billing pipeline, which is the closest thing Kestrel has to your approvals DAG."
- why the corpus says `met`: The source field says careers page, which is how the application was filed, but the cover letter says a named employee suggested he apply and is putting his name forward internally, which is a referral in substance. condition_not_met is the nearest reading because no referrer field is populated, but the condition is about being referred, not about which form recorded it.

#### comms-040 — truth `not_met`, judged `not_judgeable` at confidence 0.37 (family `inference_needed`, hard)
- condition: "a meeting with more than 8 attendees is added to my calendar"
- connector / event_type: google / calendar.event.created
- title: "Ledgerline all-hands — September"
- summary: "Sam Achterberg invited you to a meeting on Fri Sep 25, 09:00–09:45 PT."
- text_snippet: "Guests: engineering@ledgerline.io, gtm@ledgerline.io, sam@ledgerline.io\nAgenda: Q4 priorities, Pricing 2.0 update, security review status"
- why the corpus says `not_met`: condition_met is tempting because an all-hands is surely more than eight people; it loses because the event lists three guest entries, two of them group aliases whose membership it does not state, so the count over 8 is an inference and not a fact of the event.

#### meet-032 — truth `not_met`, judged `met` at confidence 1.00 (family `near_miss`, hard)
- condition: "a design candidate reached the onsite stage"
- connector / event_type: ashby / candidateStageChange
- title: "Stage change: Kenji Oyelaran → Onsite"
- summary: "Kenji Oyelaran moved from Take-home exercise to Onsite for Senior Backend Engineer."
- text_snippet: "Job: Senior Backend Engineer\nFrom: Take-home exercise\nTo: Onsite\nInterviewers: Jae Park, Dana Whitfield (design collaboration round), Marcus Lee\nNote from Jae: take-home was clean, worth the full loop."
- why the corpus says `not_met`: The stage is exactly Onsite and the Head of Design is on the panel, but the candidate is in the engineering pipeline and the condition names a design candidate. condition_met loses because the subject is the wrong requisition, however right the stage.

#### eng-019 — truth `not_judgeable`, judged `not_met` at confidence 0.33 (family `untestable`, easy)
- condition: "post the release notes to #eng-releases in slack"
- connector / event_type: github / github.release.published
- title: "corvid-hq/mobile: android-v3.8.0"
- summary: "Devin Ashby published release android-v3.8.0 in corvid-hq/mobile."
- text_snippet: "Offline job notes, faster photo uploads on cellular, bug fixes."
- why the corpus says `not_judgeable`: Nearest label is condition_met because a release with notes did happen. It loses because the text is an instruction for what to do, not a test of the event; there is nothing in it for the event to satisfy.

#### eng-030 — truth `met`, judged `not_met` at confidence 0.74 (family `unstated_but_true`, hard)
- condition: "a postmortem document is created"
- connector / event_type: linear / linear.document.create
- title: "2026-09-11 invoice PDF 5xx"
- summary: "Ingrid Sørensen created a document in project Checkout v2."
- text_snippet: "## Impact\n3.4% of `/invoices/:id/pdf` requests returned 502 between 14:07 and 15:22 UTC. 41 workspaces affected.\n\n## Timeline\n- 14:07 #4128 deployed\n- 14:19 alert `pdf_5xx_rate` fired\n- 15:22 revert deployed\n\n## What went wrong\nweasyprint's font cache is not isolate-safe.\n\n## Action items\n- [ ] Re-land behind ff_pdf_renderer_v2 (Ingrid)\n- [ ] Add pdf render to the canary suite (Marcus)"
- why the corpus says `met`: Nearest label is condition_not_met because neither the title nor the summary calls it a postmortem. It loses because the body is an incident write-up with impact, timeline, cause and action items for a past outage, which is what a postmortem is.

#### eng-023 — truth `not_met`, judged `met` at confidence 0.99 (family `near_miss`, hard)
- condition: "an issue is created about the data pipeline"
- connector / event_type: linear / linear.issue.create
- title: "ENG-2866: Deploy pipeline stuck on the smoke-test stage"
- summary: "Marcus Feld created ENG-2866 in team Platform. Status: Todo."
- text_snippet: "The Cloudflare deploy pipeline for apps/web has been sitting on `smoke-test` for 40 minutes on the last two runs. The stage waits on a health check against the preview URL that never comes up. Nothing to do with the warehouse jobs — this is the web deploy only."
- why the corpus says `not_met`: Nearest label is condition_met because 'pipeline' is in the title and body. It loses because the pipeline named is the web deploy pipeline, and the body rules out the warehouse jobs, so the subject is not the data pipeline.

#### comms-029 — truth `not_judgeable`, judged `not_met` at confidence 0.26 (family `untestable`, hard)
- condition: "the page was edited by mistake"
- connector / event_type: notion / notion.page.content_updated
- title: "Onboarding Revamp — PRD"
- summary: "Sam Achterberg edited Onboarding Revamp — PRD."
- text_snippet: "## Goals\n- time to first synced invoice under 10 min (was 25)\n- 60% of new workspaces connect a bank in week 1\n- drop 'invite your accountant' from v1"
- why the corpus says `not_judgeable`: condition_not_met is where a reader lands because the edit looks deliberate; it loses because the editor's intent is not something any page-edit event carries — the condition asks about a state of mind, so no event of this kind could ever affirm it.

#### eng-032 — truth `met`, judged `not_met` at confidence 0.47 (family `negated_condition`, hard)
- condition: "an issue is deleted and it wasnt a duplicate"
- connector / event_type: linear / linear.issue.remove
- title: "GRO-91: Referral banner copy test"
- summary: "Noor Haddad deleted GRO-91 from team Growth."
- text_snippet: "Filed against the wrong team by mistake — moved over to Mobile as MOB-433."
- why the corpus says `met`: Nearest label is condition_not_met because a second key (MOB-433) exists for the same work. It loses because the stated reason is a wrong-team filing that was moved, not a duplicate of pre-existing work; there is one issue, relocated.

#### meet-015 — truth `not_met`, judged `met` at confidence 0.87 (family `near_miss`, hard)
- condition: "notes from a call with a design candidate"
- connector / event_type: granola / note.generated
- title: "Design pipeline — Elena"
- summary: "Weekly recruiting sync on the Senior Product Designer search: three candidates in process, Simone Achebe at final portfolio review, Ruth Lindqvist at phone screen."
- text_snippet: "- Simone: Dana wants one more portfolio convo, Elena booking\n- Ruth Lindqvist: phone screen Thu, came via LinkedIn\n- Bea Castellanos: withdrew, took an offer elsewhere\n- Elena thinks we should reopen the JD to remote, not sure\n- todo: ask Dana if she'd interview Ruth herself"
- why the corpus says `not_met`: Three design candidates are named and discussed, but the call is a recruiter sync between two employees; no candidate was on it. condition_met loses because the condition asks for a call with a candidate, and this is a call about them.

#### meet-012 — truth `not_judgeable`, judged `not_met` at confidence 0.24 (family `untestable`, easy)
- condition: "the team will hit quota this quarter"
- connector / event_type: fireflies / fireflies.meeting.summarized
- title: "Weekly sales sync"
- summary: "Nadia Ferreira reviewed pipeline with the team. Northwind and Brightleaf are the two deals expected to close in Q4; Priya flagged Northwind's CFO review as the main risk. Nadia said the team is on track."
- text_snippet: "Participants: Nadia Ferreira, Priya Raman, Tom Okafor, Sam Kowalski\n\nPipeline\n- Northwind: proposal stage, CFO review next week\n- Brightleaf: pilot, phase two pending schedule\n- Oakridge EMEA expansion: quote out\n\nNadia: on track for the quarter if Northwind lands"
- why the corpus says `not_judgeable`: Whether quota is hit is a future outcome that no meeting record can carry, whatever it says; 'on track' is a forecast, not the result. condition_met is the nearest reading because Nadia sounds confident, but the condition names an outcome, not a forecast.

#### comms-039 — truth `met`, judged `not_met` at confidence 0.41 (family `easy_met`, easy)
- condition: "a customer call gets cancelled"
- connector / event_type: google / calendar.event.cancelled
- title: "Brightwater Foods — Q3 business review"
- summary: "Ines Ferreira cancelled the event scheduled for Mon Sep 21, 13:00 PT."
- text_snippet: "Cancelled.\nGuests: ines, marcus, k.adeyemi@brightwaterfoods.com, j.lund@brightwaterfoods.com"
- why the corpus says `met`: condition_not_met would need this to be an internal meeting; it loses because the event is a business review with two Brightwater attendees and the summary says it was cancelled.
