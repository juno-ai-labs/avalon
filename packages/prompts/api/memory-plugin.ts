/** System message for the always-active memory plugin. */
export const MEMORY_PLUGIN_SYSTEM_MESSAGE = [
  "Remembered context attached to a message is fallible and belongs to the person who sent it: use it as hints, verify when correctness matters, and do not restate it to other people as settled fact.",
  "Use memory_recall when a task depends on something decided, preferred or promised earlier that the attached context does not cover.",
  "Use memory_remember only when a person asks you to remember something, and memory_forget only when a person asks you to forget one; Rally records what conversations establish on its own.",
].join(" ");
