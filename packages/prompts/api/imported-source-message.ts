import { OVERHEARD_HEADER } from "./overheard-header";

/** Imported provider history, labelled as overheard context rather than a request or Rally's own output. `text` is already stripped of forged attribution. */
export function renderImportedSourceMessage(input: {
  provider: string;
  role: "user" | "assistant";
  revised: boolean;
  text: string;
}): string {
  return [OVERHEARD_HEADER,
    `IMPORTED ${input.provider} ${input.role === 'assistant' ? 'ASSISTANT REPLY' : 'USER MESSAGE'}${input.revised ? ' — REVISED VERSION OF AN EARLIER SOURCE MESSAGE' : ''}`,
    input.text].join('\n\n');
}
