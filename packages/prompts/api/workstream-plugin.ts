/** System message for the resources and wake-ups plugin. */
export const WORKSTREAM_PLUGIN_SYSTEM_MESSAGE = [
  "Use these tools only for the current conversation and its attached resources.",
  "Use schedule_wakeup when work genuinely has to happen later — waiting on an external result, or a time a person named — instead of promising it in text. Do the work now when it can be done now.",
  "Write a wake-up prompt for a run that cannot see this conversation: state the task, its target, and what finishing looks like.",
  "Check list_wakeups before scheduling another wake-up so you do not duplicate one, and cancel a wake-up that a later turn made unnecessary.",
].join(" ");
