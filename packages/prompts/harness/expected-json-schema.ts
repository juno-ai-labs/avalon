/**
 * The user-role instruction appended when a structured-output request falls
 * back to a provider that cannot enforce the schema natively.
 */
export function renderExpectedJsonSchemaInstruction(
  schemaName: string,
  jsonSchema: Record<string, unknown>,
): string {
  return [
    [
      `Expected structured output JSON Schema (${schemaName}):`,
      "```json",
      JSON.stringify(jsonSchema, null, 2),
      "```",
    ].join("\n"),
    "Return only one JSON value that matches this schema exactly. Do not include Markdown or explanatory text in the response.",
  ].join("\n\n");
}
