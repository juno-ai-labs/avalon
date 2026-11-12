import type { PromptMessage } from "./types";

/**
 * The prompt a past run of this conversation left for this one.
 *
 * Unlike a trigger activity, this text is Rally's own: an earlier authorized
 * run inside this same conversation wrote it through `schedule_wakeup`,
 * so it is an instruction rather than evidence. It is still labelled and dated,
 * because a prompt written hours ago may have been overtaken by the transcript
 * that followed it.
 */
export function renderScheduledWakeupMessage(input: {
  prompt: string;
  scheduledAt: string;
  dueAt: string;
}): PromptMessage {
  return {
    role: "user",
    content: [
      "SCHEDULED WAKE-UP FROM AN EARLIER RUN OF THIS CONVERSATION",
      `Written at ${input.scheduledAt} and due at ${input.dueAt}, both UTC.`,
      "Act on it now. If the transcript since then already settled it, or it no longer makes sense, say so briefly instead of repeating work.",
      "",
      input.prompt,
    ].join("\n"),
  };
}
