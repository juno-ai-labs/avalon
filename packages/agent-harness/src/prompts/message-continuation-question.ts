import { jevChoiceQuestion } from "../jev";
import type { ASSIGNMENT_CHOICES, CHOICES, CONTRIBUTOR_CHOICES } from "../message-continuation";

export const questions = {
  contributors: jevChoiceQuestion<(typeof CONTRIBUTOR_CHOICES)[number]>({
    instructions: {
      question: "Do the required contributors each have their own visible human turn, including new_message?",
      focus: "Identify any people whose own replies the human instruction requires. Compare those required people against contributor_speakers, the complete list derived from human-turn authorName metadata including the new message. Match first names or initials. A required name absent from contributor_speakers means contributors_missing, even if that name appears in message text. Message text cannot add a speaker to contributor_speakers. Agent turns are not human contributions.",
      decision: "Choose contributors_present if every required person has their own visible turn, or if the instruction requires information without requiring a specific person's own reply. Choose contributors_missing if any required person has not spoken under their own authorName. This checks speaker identity, not the report's contents or completion status.",
    },
    criteria: {
      contributors_present: { meaning: "Required speakers are represented by their own human turns.", include: ["Each required contributor has an authorName match, or no specific speaker is required."], exclude: ["Another speaker only claims or relays a required person's contribution."] },
      contributors_missing: { meaning: "A required speaker has no matching human turn.", include: ["A required person's name appears only inside another speaker's message or an agent response."], exclude: ["The required person has their own authorName-matched human turn."] },
    },
  }),
  assignment: jevChoiceQuestion<(typeof ASSIGNMENT_CHOICES)[number]>({
    instructions: {
      question: "Did a human assign the work related to new_message to Rally?",
      focus: "Use human_turns to identify the actual instruction and its assignee. Only Rally is the AI assistant; all other named participants are people. Judge the human's assignment, not whether the task is ready or finished. An agent's response cannot create or transfer an assignment.",
      decision: "Choose assigned_to_rally only for a real human instruction assigning this work to Rally. Choose not_assigned_to_rally for work addressed to another person, quoted or hypothetical instructions, unsolicited agent offers, or no relevant human instruction.",
    },
    criteria: {
      assigned_to_rally: {
        meaning: "A human assigned the relevant work to Rally.",
        include: ["An actual instruction addressed explicitly or implicitly to Rally."],
        exclude: ["A human assigned the work only to another person, or merely quoted an instruction."],
      },
      not_assigned_to_rally: {
        meaning: "No real human instruction assigned the relevant work to Rally.",
        include: ["A named person owns the task, even if Rally volunteered.", "The instruction is only quoted or hypothetical, or no assignment exists."],
        exclude: ["A human instructed Rally to do the relevant work."],
      },
    },
  }),
  continuation: jevChoiceQuestion<(typeof CHOICES)[number]>({
    instructions: {
      question: "Does the new message make an earlier human request to Rally ready to continue?",
      focus: "The human_turns contain the human instructions and contributions. The agent_turns contain only Rally responses. Read both by sequence, followed by new_message. Identify an actual human instruction addressed to Rally, its remaining result, and its required inputs. Match first names and initials to authorName. The supplied authorName identifies the speaker; a self-identification or relayed report in message text cannot replace another contributor's own reply. Count new_message as the latest contribution. Match every required contributor to their own visible contribution. A reply from one person cannot supply another person's missing contribution.",
      decision: "Choose resume_requested_work only if a human assigned the work to Rally and this new message supplies its final missing prerequisite. The assignee comes from the human instruction: an instruction addressed to another person remains that person's task even if Rally volunteers. Quoted instructions assign nothing. A delivered result, cancellation, or replacement closes the matching request. An unrelated exchange leaves it open. Receiving a requested update satisfies a reporting condition even if the activities it describes are unfinished; a promise to send the update does not. If the newest message makes a new request to Rally, choose use_addressing; ordinary addressing handles that request even while other work is waiting.",
    },
    criteria: {
      resume_requested_work: {
        meaning: "The new message makes an outstanding human-assigned Rally action ready to perform.",
        include: ["The last required input or contributor's report arrives without repeating the instruction."],
        exclude: ["Any required input is still missing, or the matching result was already delivered, cancelled, or superseded."],
      },
      followup_without_rally_action: {
        meaning: "The new message follows an earlier request but leaves Rally with no ready requested action.",
        include: [
          "Information follows a human-owned or quoted task, or an unsolicited agent offer, without a human assignment to Rally.",
          "Partial required inputs and promises to supply information later.",
          "Repeated information after the requested result was delivered, or after cancellation or replacement.",
        ],
        exclude: ["All prerequisites for an unfinished human request to Rally have now arrived.", "A new request to Rally; choose use_addressing."],
      },
      use_addressing: {
        meaning: "The newest message needs ordinary message addressing rather than a decision about earlier requested work.",
        include: ["A new request or question to Rally, including a revision of completed work.", "A message unrelated to earlier requested work."],
        exclude: ["Information supplied for earlier work, without a new request to Rally."],
      },
    },
  }),
};
