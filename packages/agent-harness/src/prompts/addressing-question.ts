import { jevChoiceQuestion } from "../jev";
import type { AddressingChoice } from "../index";

export const typesafeAddressingQuestions = {
  addressing: jevChoiceQuestion<AddressingChoice>({
    instructions: {
      question: "Who is expected to act on `current_message.text` now?",
      focus: "Judge the current message. Use `conversation_context.recent_messages` only to resolve references, implied addressee, or continuation.",
      decision: "Choose exactly one actor pattern.",
    },
    criteria: {
      rally_should_act: {
        meaning: "Rally should answer or perform work now.",
        include: [
          "Direct request to Rally",
          "Question or instruction whose implied addressee is Rally",
          "Continuation asking Rally to proceed or revise",
        ],
        exclude: [
          "Quoted commands presented as content",
          "Request directed only to a person",
          "Acknowledgement, FYI, status report, or social reaction",
        ],
      },
      people_only: {
        meaning: "Rally should not act; the message is for people or conversational only.",
        include: [
          "Request or question directed only to a named person",
          "Human coordination",
          "Acknowledgement, FYI, status report, or social reaction",
          "Follow-up questions in an established person-to-person exchange retain that human addressee until redirected to Rally.",
        ],
        exclude: ["Implied question or instruction to Rally"],
      },
      rally_and_people_should_act: {
        meaning: "Rally and at least one person each receive an independent action.",
        include: ["One action assigned to Rally and another assigned to a person"],
        exclude: [
          "Rally doing work about, for, or involving a person",
          "A person merely mentioned in Rally work",
        ],
      },
      no_clear_request: {
        meaning: "The intended actor cannot genuinely be determined.",
        include: ["Gibberish", "Unresolvable fragment", "Conflicting evidence"],
        exclude: ["Ordinary uncertainty", "FYIs or reactions, which are people_only"],
      },
    },
  }),
} as const;
