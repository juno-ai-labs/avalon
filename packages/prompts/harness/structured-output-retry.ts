/** The user-role turn that asks a model to repair a structured answer that failed validation. */
export function renderStructuredOutputRetryMessage(validationIssues: unknown): string {
  return `Return a corrected response matching the JSON schema. Validation issues: ${JSON.stringify(validationIssues)}`;
}
