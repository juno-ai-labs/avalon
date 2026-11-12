export interface PromptMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** A message whose content may be text parts, for prompts that keep untrusted text in its own part. */
export interface PromptPartsMessage {
  role: "system" | "user" | "assistant";
  content: string | { type: "text"; text: string }[];
}
