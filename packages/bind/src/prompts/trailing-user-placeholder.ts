/** Synthetic user message appended when the conversation would otherwise end
 *  on an assistant turn. Provider behavior diverges here — Anthropic's native
 *  API treats a trailing assistant as prefill, but Azure-hosted Claude (and
 *  some other providers routed through OpenRouter) reject the request
 *  outright with "model does not support assistant message prefill". */
export const TRAILING_USER_PLACEHOLDER = "Continue.";
