import { z } from "zod";

/** Product limit explicitly set to 10,000 people per activity (2026-10-19). */
export const MAX_EXTERNAL_PEOPLE = 10_000;

export const ExternalPersonSchema = z.strictObject({
  provider: z.string().min(1).max(80),
  providerTenantId: z.string().min(1).max(200).nullable(),
  providerUserId: z.string().min(1).max(200).nullable(),
  handle: z.string().min(1).max(200).nullable(),
  email: z.string().email().max(254).nullable(),
  displayName: z.string().min(1).max(180).nullable(),
  role: z.string().min(1).max(80),
  sourceText: z.string().min(1).max(1000),
});

/** Keep first occurrence order and distinct roles; transport formatting is not identity. */
export function deduplicateExternalPeople<T>(people: readonly T[]): T[] {
  const seen = new Set<string>();
  return people.filter((person) => {
    const row = person && typeof person === "object" ? person as Record<string, unknown> : {};
    const text = (value: unknown) => typeof value === "string" && value.length > 0 ? value : null;
    const providerId = text(row.providerUserId);
    const email = text(row.email)?.toLowerCase();
    const handle = text(row.handle);
    const identity = providerId ? ["id", providerId] : email ? ["email", email]
      : handle ? ["handle", handle] : ["evidence", row.displayName ?? null, row.sourceText ?? JSON.stringify(person)];
    const key = JSON.stringify([row.provider, row.providerTenantId, row.role, identity]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export const ExternalPeopleSchema = z.array(ExternalPersonSchema)
  .transform(deduplicateExternalPeople)
  .pipe(z.array(ExternalPersonSchema).max(MAX_EXTERNAL_PEOPLE));
