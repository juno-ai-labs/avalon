/** The RFC 9562 UUID forms accepted by Zod v4, case-explicit for JSON Schema. */
export const STRICT_UUID_JSON_SCHEMA_PATTERN = "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$";

/** Runtime and provider conversion share one pattern source so they cannot drift. */
export const STRICT_UUID_PATTERN = new RegExp(STRICT_UUID_JSON_SCHEMA_PATTERN, "u");
